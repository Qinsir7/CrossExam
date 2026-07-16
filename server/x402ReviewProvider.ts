import { x402Client } from '@okxweb3/x402-core/client'
import { x402HTTPClient } from '@okxweb3/x402-core/http'
import type { PaymentRequired, PaymentRequirements } from '@okxweb3/x402-core/types'
import { ExactEvmScheme, toClientEvmSigner } from '@okxweb3/x402-evm'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import type { ExternalReviewProvider } from './reviewJobWorker'
import type { ReviewerRegistry } from './reviewerRegistry'

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type X402ReviewProviderOptions = {
  registry: ReviewerRegistry
  signingKey: Hex
  maxPerScopeAtomic: bigint
  allowedAssets: string[]
  callbackBaseUrl: string
  fetchImpl?: FetchLike
}

function allowedRequirement(requirement: PaymentRequirements, options: X402ReviewProviderOptions) {
  return requirement.scheme === 'exact'
    && requirement.network === 'eip155:196'
    && /^0x[a-fA-F0-9]{40}$/.test(requirement.payTo)
    && options.allowedAssets.includes(requirement.asset.toLowerCase())
    && /^[1-9][0-9]*$/.test(requirement.amount)
    && BigInt(requirement.amount) <= options.maxPerScopeAtomic
}

function selectAllowedRequirements(payment: PaymentRequired, options: X402ReviewProviderOptions) {
  const allowed = payment.accepts.filter((requirement) => allowedRequirement(requirement, options))
  if (!allowed.length) {
    throw new Error('External reviewer payment requirements violate the X Layer procurement spend policy.')
  }
  return allowed
}

function callbackUrl(baseUrl: string, jobId: string, scopeId: string) {
  const normalized = baseUrl.replace(/\/$/, '')
  if (!/^https:\/\/.+/.test(normalized)) throw new Error('Procurement callbacks require a public HTTPS CROSSEXAM_PUBLIC_URL.')
  return `${normalized}/api/v1/review-jobs/${encodeURIComponent(jobId)}/deliveries/${encodeURIComponent(scopeId)}`
}

/**
 * Real buyer-side x402 adapter. It first asks the external ASP for a job,
 * then signs only an `exact` X Layer requirement that passes the configured
 * asset allowlist and atomic per-scope cap. It never falls back to an unpaid
 * request, broadens the price cap, or follows redirects to an unreviewed URL.
 */
export class X402ReviewProvider implements ExternalReviewProvider {
  private readonly options: X402ReviewProviderOptions
  private readonly http: x402HTTPClient
  private readonly fetchImpl: FetchLike

  constructor(options: X402ReviewProviderOptions) {
    if (options.maxPerScopeAtomic <= 0n || !options.allowedAssets.length) throw new Error('X402 procurement requires an explicit positive spend policy.')
    this.options = { ...options, allowedAssets: options.allowedAssets.map((asset) => asset.toLowerCase()) }
    const account = privateKeyToAccount(options.signingKey)
    const core = x402Client.fromConfig({
      schemes: [{ network: 'eip155:196', client: new ExactEvmScheme(toClientEvmSigner(account)) }],
      policies: [(_version, requirements) => requirements.filter((requirement) => allowedRequirement(requirement, this.options))],
    })
    this.http = new x402HTTPClient(core)
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async requestReview(input: Parameters<ExternalReviewProvider['requestReview']>[0]): Promise<Awaited<ReturnType<ExternalReviewProvider['requestReview']>>>
  {
    const reviewer = this.options.registry[input.reviewerId]
    if (!reviewer?.procurementEndpoint || !/^https:\/\/.+/.test(reviewer.procurementEndpoint)
      || reviewer.procurementProtocol !== 'CROSSEXAM_SIGNED_CALLBACK_V1') {
      throw new Error('Matched reviewer has no approved CrossExam signed-callback procurement endpoint.')
    }
    const body = JSON.stringify({
      schemaVersion: '0.1',
      jobId: input.jobId,
      scopeId: input.scopeId,
      task: input.task,
      callback: { url: callbackUrl(this.options.callbackBaseUrl, input.jobId, input.scopeId), attestation: 'EIP191 delivery required' },
    })
    const headers = { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey }
    const initial = await this.fetchImpl(reviewer.procurementEndpoint, { method: 'POST', headers, body, redirect: 'error' })
    if (initial.status !== 402) {
      throw new Error(`External reviewer must return x402 Payment Required before accepting work (received ${initial.status}).`)
    }
    const required = this.http.getPaymentRequiredResponse((name) => initial.headers.get(name))
    const allowed = selectAllowedRequirements(required, this.options)
    const payment = await this.http.createPaymentPayload({ ...required, accepts: allowed })
    const paid = await this.fetchImpl(reviewer.procurementEndpoint, {
      method: 'POST',
      headers: { ...headers, ...this.http.encodePaymentSignatureHeader(payment) },
      body,
      redirect: 'error',
    })
    if (!paid.ok) throw new Error(`External reviewer rejected the paid procurement request (${paid.status}).`)
    const settlement = this.http.getPaymentSettleResponse((name) => paid.headers.get(name))
    if (!settlement.success || settlement.network !== 'eip155:196' || !settlement.transaction?.trim()) {
      throw new Error('External reviewer response lacks a successful X Layer payment settlement confirmation.')
    }
    const response = await paid.json() as { requestId?: unknown }
    if (typeof response.requestId !== 'string' || !response.requestId.trim()) {
      throw new Error('External reviewer accepted payment without returning a stable requestId.')
    }
    const accepted = payment.accepted
    const amountAtomic = settlement.amount ?? accepted.amount
    if (!/^[1-9][0-9]*$/.test(amountAtomic) || BigInt(amountAtomic) > this.options.maxPerScopeAtomic) {
      throw new Error('Settlement amount violates the approved procurement spend policy.')
    }
    return {
      externalRequestId: response.requestId,
      payment: {
        network: 'eip155:196',
        asset: accepted.asset.toLowerCase(),
        amountAtomic,
        transaction: settlement.transaction,
      },
    }
  }
}
