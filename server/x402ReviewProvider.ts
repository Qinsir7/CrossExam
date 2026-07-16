import { x402Client } from '@okxweb3/x402-core/client'
import { x402HTTPClient } from '@okxweb3/x402-core/http'
import type { PaymentRequired, PaymentRequirements } from '@okxweb3/x402-core/types'
import { ExactEvmScheme, toClientEvmSigner } from '@okxweb3/x402-evm'
import { privateKeyToAccount } from 'viem/accounts'
import { keccak256, stringToHex, type Hex } from 'viem'
import { createHmac } from 'node:crypto'
import type { ExternalReviewProvider } from './reviewJobWorker'
import type { ReviewerRegistry } from './reviewerRegistry'
import { evidenceArtifactHash } from './evidenceIntegrity'
import type { RegisteredReviewer } from './reviewerRegistry'

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type X402ReviewProviderOptions = {
  registry: ReviewerRegistry
  signingKey?: Hex
  maxPerScopeAtomic?: bigint
  allowedAssets?: string[]
  callbackBaseUrl: string
  okxMarketCredentials?: { apiKey: string; secretKey: string; passphrase: string }
  fetchImpl?: FetchLike
}

function allowedRequirement(requirement: PaymentRequirements, options: X402ReviewProviderOptions) {
  return requirement.scheme === 'exact'
    && requirement.network === 'eip155:196'
    && /^0x[a-fA-F0-9]{40}$/.test(requirement.payTo)
    && Boolean(options.maxPerScopeAtomic && options.allowedAssets?.includes(requirement.asset.toLowerCase()))
    && /^[1-9][0-9]*$/.test(requirement.amount)
    && BigInt(requirement.amount) <= (options.maxPerScopeAtomic ?? 0n)
}

function selectAllowedRequirements(payment: PaymentRequired, options: X402ReviewProviderOptions, reviewer: RegisteredReviewer) {
  const allowed = payment.accepts.filter((requirement) => allowedRequirement(requirement, options))
  if (!allowed.length) {
    throw new Error('External reviewer payment requirements violate the X Layer procurement spend policy.')
  }
  if (reviewer.procurementProtocol !== 'PAID_EVIDENCE_V1') return allowed
  const recipient = reviewer.paymentRecipient?.toLowerCase()
  const bound = recipient ? allowed.filter((requirement) => requirement.payTo.toLowerCase() === recipient) : []
  if (!bound.length) {
    throw new Error('Paid evidence source payment recipient does not match its server-owned registry binding.')
  }
  return bound
}

function callbackUrl(baseUrl: string, jobId: string, scopeId: string) {
  const normalized = baseUrl.replace(/\/$/, '')
  if (!/^https:\/\/.+/.test(normalized)) throw new Error('Procurement callbacks require a public HTTPS CROSSEXAM_PUBLIC_URL.')
  return `${normalized}/api/v1/review-jobs/${encodeURIComponent(jobId)}/deliveries/${encodeURIComponent(scopeId)}`
}

function boundedResponse(text: string) {
  if (!text.trim()) throw new Error('Paid evidence source returned an empty response.')
  if (Buffer.byteLength(text, 'utf8') > 65_536) throw new Error('Paid evidence source response exceeds the 64 KiB retention limit.')
  try {
    JSON.parse(text)
  } catch {
    throw new Error('Paid evidence source must return a JSON response for the OPAQUE_JSON_V1 adapter.')
  }
  return text
}

type EvidenceRequest = { url: string; method: 'GET' | 'POST'; body?: string }

function evidenceRequest(reviewer: RegisteredReviewer, input: Parameters<ExternalReviewProvider['requestReview']>[0]): EvidenceRequest {
  if (reviewer.responseAdapter === 'OPAQUE_JSON_V1') {
    return { url: reviewer.procurementEndpoint!, method: 'POST', body: JSON.stringify(reviewer.evidenceRequestBody ?? {}) }
  }
  if (reviewer.responseAdapter === 'CERTIK_TOKEN_SCAN_V1') {
    const target = input.task.reviewEvidenceContext?.tokenRiskTarget ?? input.task.actionBinding?.target ?? ''
    const matched = /^(?:token|contract):([a-z0-9_-]+):(0x[a-fA-F0-9]{40})$/.exec(target)
    if (!matched) throw new Error('CertiK Token Scan requires actionBinding.target formatted as token:<chain>:0x<contract-address>.')
    const url = new URL(reviewer.procurementEndpoint!)
    url.searchParams.set('chain', matched[1])
    url.searchParams.set('address', matched[2])
    return { url: url.toString(), method: 'GET' }
  }
  if (reviewer.responseAdapter === 'OKX_TOKEN_LIQUIDITY_V1') {
    const target = input.task.reviewEvidenceContext?.tokenRiskTarget ?? input.task.actionBinding?.target ?? ''
    const matched = /^(?:token|contract):([a-z0-9_-]+):(0x[a-fA-F0-9]{40})$/.exec(target)
    if (!matched) throw new Error('OKX token liquidity evidence requires token:<chain>:0x<contract-address>.')
    const chainIndex = matched[1] === 'xlayer' ? '196' : matched[1]
    if (chainIndex !== '196') throw new Error('The first production liquidity policy supports X Layer targets only.')
    const url = new URL(reviewer.procurementEndpoint!)
    url.searchParams.set('chainIndex', chainIndex)
    url.searchParams.set('tokenContractAddress', matched[2].toLowerCase())
    return { url: url.toString(), method: 'GET' }
  }
  if (reviewer.responseAdapter === 'GOPLUS_TOKEN_SECURITY_V1') {
    const target = input.task.reviewEvidenceContext?.tokenRiskTarget ?? input.task.actionBinding?.target ?? ''
    const matched = /^(?:token|contract):([a-z0-9_-]+):(0x[a-fA-F0-9]{40})$/.exec(target)
    if (!matched) throw new Error('GoPlus token security evidence requires token:<chain>:0x<contract-address>.')
    const chainIndex = matched[1] === 'xlayer' ? '196' : matched[1]
    if (chainIndex !== '196') throw new Error('The built-in GoPlus source is bound to X Layer chain 196.')
    const url = new URL(reviewer.procurementEndpoint!)
    url.searchParams.set('contract_addresses', matched[2].toLowerCase())
    return { url: url.toString(), method: 'GET' }
  }
  throw new Error('External evidence source has no approved response adapter.')
}

function okxMarketHeaders(url: string, credentials: NonNullable<X402ReviewProviderOptions['okxMarketCredentials']>) {
  const parsed = new URL(url)
  const requestPath = `${parsed.pathname}${parsed.search}`
  const timestamp = new Date().toISOString()
  const signature = createHmac('sha256', credentials.secretKey).update(`${timestamp}GET${requestPath}`).digest('base64')
  return {
    'OK-ACCESS-KEY': credentials.apiKey,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-PASSPHRASE': credentials.passphrase,
    'OK-ACCESS-TIMESTAMP': timestamp,
  }
}

function okxLiquidityFindings(input: Parameters<ExternalReviewProvider['requestReview']>[0], reviewer: RegisteredReviewer, response: Record<string, unknown>, artifactId: string) {
  if (response.code !== '0' || !Array.isArray(response.data)) throw new Error('OKX Market liquidity response returned an unsuccessful API envelope.')
  const pools = response.data.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'))
  const liquidities = pools.map((pool) => Number(pool.liquidityUsd)).filter((value) => Number.isFinite(value) && value >= 0)
  if (!liquidities.length) throw new Error('OKX Market liquidity response contains no usable pool liquidity values.')
  const totalLiquidityUsd = liquidities.reduce((sum, value) => sum + value, 0)
  const ratio = totalLiquidityUsd / input.task.valueAtRiskUsd
  const contradiction = pools.length === 0 || ratio < 10
  const verdict = contradiction ? 'CONTRADICTS' as const : 'INSUFFICIENT_EVIDENCE' as const
  const explanation = `OKX Onchain OS Market observed ${pools.length} top pool(s) with ${totalLiquidityUsd.toFixed(2)} USD aggregate liquidity (${ratio.toFixed(2)}× the reviewed value at risk). ${contradiction ? 'This is below the 10× hard liquidity floor and materially contradicts safe execution.' : 'Pool TVL alone does not prove route-specific executable depth or slippage, so CrossExam does not upgrade it to support.'}`
  return input.task.claims.map((claim) => ({
    claimId: claim.id,
    reviewerId: reviewer.id,
    verdict,
    confidence: contradiction ? 0.9 : 1,
    materiality: claim.materiality,
    evidence: explanation,
    evidenceArtifactIds: [artifactId],
  }))
}

function goPlusFindings(input: Parameters<ExternalReviewProvider['requestReview']>[0], reviewer: RegisteredReviewer, response: Record<string, unknown>, artifactId: string) {
  if (response.code !== 1 || !response.result || typeof response.result !== 'object') throw new Error('GoPlus token security returned an unsuccessful API envelope.')
  const target = input.task.reviewEvidenceContext?.tokenRiskTarget ?? ''
  const address = /0x[a-fA-F0-9]{40}$/.exec(target)?.[0].toLowerCase()
  const result = address ? (response.result as Record<string, unknown>)[address] : undefined
  if (!result || typeof result !== 'object') throw new Error('GoPlus token security returned no record for the bound X Layer contract.')
  const risk = result as Record<string, unknown>
  const tax = Math.max(Number(risk.buy_tax || 0), Number(risk.sell_tax || 0), Number(risk.transfer_tax || 0))
  const criticalFlags = [
    ['is_honeypot', 'honeypot behavior'],
    ['cannot_buy', 'buying disabled'],
    ['cannot_sell_all', 'full selling disabled'],
    ['is_blacklisted', 'blacklist controls'],
  ] as const
  const triggered: string[] = criticalFlags.filter(([field]) => risk[field] === '1').map(([, label]) => label)
  if (risk.is_open_source === '0') triggered.push('contract source is not open')
  if (Number.isFinite(tax) && tax >= 0.5) triggered.push(`tax at ${(tax * 100).toFixed(2)}%`)
  const contradiction = triggered.length > 0
  const warnings = [risk.is_proxy === '1' ? 'proxy contract' : '', risk.honeypot_with_same_creator === '1' ? 'creator linked to another honeypot' : ''].filter(Boolean)
  const verdict = contradiction ? 'CONTRADICTS' as const : 'INSUFFICIENT_EVIDENCE' as const
  const explanation = contradiction
    ? `GoPlus X Layer token security detected material execution risk: ${triggered.join(', ')}.`
    : `GoPlus found no deterministic critical token-control flag in this response${warnings.length ? `; non-blocking warnings: ${warnings.join(', ')}` : ''}. Absence of a flag is not proof of safety, so CrossExam does not upgrade it to support.`
  return input.task.claims.map((claim) => ({
    claimId: claim.id,
    reviewerId: reviewer.id,
    verdict,
    confidence: contradiction ? 0.95 : 1,
    materiality: claim.materiality,
    evidence: explanation,
    evidenceArtifactIds: [artifactId],
  }))
}

function certikFindings(input: Parameters<ExternalReviewProvider['requestReview']>[0], reviewer: RegisteredReviewer, response: Record<string, unknown>, artifactId: string) {
  const summary = response.summary && typeof response.summary === 'object' ? response.summary as Record<string, unknown> : {}
  const score = typeof summary.score === 'number' ? summary.score : Number(summary.score)
  const alertCount = typeof summary.alert_count === 'number' ? summary.alert_count : Number(summary.alert_count)
  const alertLevel = typeof summary.highest_alert_level === 'string' ? summary.highest_alert_level.toUpperCase() : ''
  const contradiction = alertLevel === 'CRITICAL' || alertLevel === 'MAJOR' || (Number.isFinite(score) && score < 50)
  const support = !contradiction && Number.isFinite(score) && score >= 70 && Number.isFinite(alertCount) && alertCount === 0
  const verdict = contradiction ? 'CONTRADICTS' as const : support ? 'SUPPORTS' as const : 'INSUFFICIENT_EVIDENCE' as const
  const explanation = Number.isFinite(score)
    ? `CertiK Token Scan reported score ${score}${Number.isFinite(alertCount) ? `, ${alertCount} alert(s)` : ''}${alertLevel ? `, highest alert ${alertLevel}` : ''}.`
    : 'CertiK Token Scan returned no normalized score, so the source cannot resolve this claim.'
  return input.task.claims.map((claim) => ({
    claimId: claim.id,
    reviewerId: reviewer.id,
    verdict,
    confidence: contradiction ? 0.9 : support ? 0.75 : 1,
    materiality: claim.materiality,
    evidence: explanation,
    evidenceArtifactIds: [artifactId],
  }))
}

/**
 * Real buyer-side x402 adapter. It first asks the external ASP for a job,
 * then signs only an `exact` X Layer requirement that passes the configured
 * asset allowlist and atomic per-scope cap. It never falls back to an unpaid
 * request, broadens the price cap, or follows redirects to an unreviewed URL.
 */
export class X402ReviewProvider implements ExternalReviewProvider {
  private readonly options: X402ReviewProviderOptions
  private readonly http?: x402HTTPClient
  private readonly fetchImpl: FetchLike

  constructor(options: X402ReviewProviderOptions) {
    this.options = { ...options, allowedAssets: (options.allowedAssets ?? []).map((asset) => asset.toLowerCase()) }
    if (options.signingKey) {
      if (!options.maxPerScopeAtomic || options.maxPerScopeAtomic <= 0n || !options.allowedAssets?.length) throw new Error('X402 procurement requires an explicit positive spend policy.')
      const account = privateKeyToAccount(options.signingKey)
      const core = x402Client.fromConfig({
        schemes: [{ network: 'eip155:196', client: new ExactEvmScheme(toClientEvmSigner(account)) }],
        policies: [(_version, requirements) => requirements.filter((requirement) => allowedRequirement(requirement, this.options))],
      })
      this.http = new x402HTTPClient(core)
    }
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  async requestReview(input: Parameters<ExternalReviewProvider['requestReview']>[0]): Promise<Awaited<ReturnType<ExternalReviewProvider['requestReview']>>>
  {
    const reviewer = this.options.registry[input.reviewerId]
    if (!reviewer?.procurementEndpoint || !/^https:\/\/.+/.test(reviewer.procurementEndpoint)
      || (reviewer.procurementProtocol !== 'CROSSEXAM_SIGNED_CALLBACK_V1'
        && reviewer.procurementProtocol !== 'PAID_EVIDENCE_V1'
        && reviewer.procurementProtocol !== 'AUTHENTICATED_API_EVIDENCE_V1'
        && reviewer.procurementProtocol !== 'PUBLIC_API_EVIDENCE_V1')) {
      throw new Error('Matched source has no approved external procurement endpoint.')
    }
    const evidenceProtocol = reviewer.procurementProtocol === 'PAID_EVIDENCE_V1'
      || reviewer.procurementProtocol === 'AUTHENTICATED_API_EVIDENCE_V1'
      || reviewer.procurementProtocol === 'PUBLIC_API_EVIDENCE_V1'
    const externalRequest = evidenceProtocol
      ? evidenceRequest(reviewer, input)
      : JSON.stringify({
        schemaVersion: '0.1',
        jobId: input.jobId,
        scopeId: input.scopeId,
        task: input.task,
        callback: { url: callbackUrl(this.options.callbackBaseUrl, input.jobId, input.scopeId), attestation: 'EIP191 delivery required' },
      })
    const request = typeof externalRequest === 'string'
      ? { url: reviewer.procurementEndpoint, method: 'POST' as const, body: externalRequest }
      : externalRequest
    const marketCredentials = this.options.okxMarketCredentials
    if (reviewer.procurementProtocol === 'AUTHENTICATED_API_EVIDENCE_V1' && !marketCredentials) {
      throw new Error('OKX Market evidence source requires worker-only API credentials.')
    }
    const authenticatedHeaders = reviewer.procurementProtocol === 'AUTHENTICATED_API_EVIDENCE_V1'
      ? okxMarketHeaders(request.url, marketCredentials!)
      : {}
    const headers = { ...authenticatedHeaders, ...(request.body ? { 'content-type': 'application/json' } : {}), 'idempotency-key': input.idempotencyKey }
    const initial = await this.fetchImpl(request.url, { method: request.method, headers, ...(request.body ? { body: request.body } : {}), redirect: 'error' })
    const publicApi = reviewer.procurementProtocol === 'PUBLIC_API_EVIDENCE_V1'
    const includedQuota = (reviewer.procurementProtocol === 'AUTHENTICATED_API_EVIDENCE_V1' || publicApi) && initial.ok
    if (publicApi && !initial.ok) throw new Error(`Public external evidence source rejected the request (${initial.status}).`)
    if (!includedQuota && initial.status !== 402) {
      throw new Error(`External reviewer must return x402 Payment Required before accepting work (received ${initial.status}).`)
    }
    if (!includedQuota && !this.http) throw new Error('Paid external evidence requires the dedicated procurement signer and spend policy.')
    const required = includedQuota ? undefined : this.http!.getPaymentRequiredResponse((name) => initial.headers.get(name))
    const allowed = required ? selectAllowedRequirements(required, this.options, reviewer) : undefined
    const payment = required && allowed ? await this.http!.createPaymentPayload({ ...required, accepts: allowed }) : undefined
    const paid = includedQuota ? initial : await this.fetchImpl(request.url, {
      method: request.method,
      headers: {
        ...(reviewer.procurementProtocol === 'AUTHENTICATED_API_EVIDENCE_V1' ? okxMarketHeaders(request.url, marketCredentials!) : headers),
        ...this.http!.encodePaymentSignatureHeader(payment!),
        'idempotency-key': input.idempotencyKey,
      },
      ...(request.body ? { body: request.body } : {}),
      redirect: 'error',
    })
    if (!paid.ok) throw new Error(`External reviewer rejected the paid procurement request (${paid.status}).`)
    const settlement = includedQuota ? undefined : this.http!.getPaymentSettleResponse((name) => paid.headers.get(name))
    if (!includedQuota && (!settlement?.success || settlement.network !== 'eip155:196' || !settlement.transaction?.trim())) {
      throw new Error('External reviewer response lacks a successful X Layer payment settlement confirmation.')
    }
    const accepted = payment?.accepted
    const amountAtomic = settlement && accepted ? settlement.amount ?? accepted.amount : undefined
    if (amountAtomic !== undefined && (!/^[1-9][0-9]*$/.test(amountAtomic) || BigInt(amountAtomic) > (this.options.maxPerScopeAtomic ?? 0n))) {
      throw new Error('Settlement amount violates the approved procurement spend policy.')
    }
    const recordedPayment = settlement && accepted && amountAtomic ? {
        network: 'eip155:196',
        asset: accepted.asset.toLowerCase(),
        amountAtomic,
        transaction: settlement.transaction,
    } as const : undefined
    if (evidenceProtocol) {
      const responseBody = boundedResponse(await paid.text())
      const observedAt = new Date().toISOString()
      const requestHash = keccak256(stringToHex(JSON.stringify({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) })))
      const responseHash = keccak256(stringToHex(responseBody))
      const artifact = {
        id: `paid-response-${input.scopeId}`,
        kind: 'TOOL_OUTPUT' as const,
        locator: request.url,
        observedAt,
        excerpt: responseBody,
      }
      const delivery = {
        reviewerId: reviewer.id,
        deliveredAt: observedAt,
        artifacts: [{ ...artifact, contentHash: evidenceArtifactHash(artifact) }],
        findings: reviewer.responseAdapter === 'CERTIK_TOKEN_SCAN_V1'
          ? certikFindings(input, reviewer, JSON.parse(responseBody) as Record<string, unknown>, artifact.id)
          : reviewer.responseAdapter === 'OKX_TOKEN_LIQUIDITY_V1'
            ? okxLiquidityFindings(input, reviewer, JSON.parse(responseBody) as Record<string, unknown>, artifact.id)
            : reviewer.responseAdapter === 'GOPLUS_TOKEN_SECURITY_V1'
              ? goPlusFindings(input, reviewer, JSON.parse(responseBody) as Record<string, unknown>, artifact.id)
          : input.task.claims.map((claim) => ({
            claimId: claim.id,
            reviewerId: reviewer.id,
            verdict: 'INSUFFICIENT_EVIDENCE' as const,
            confidence: 1,
            materiality: claim.materiality,
            evidence: `CrossExam retained the paid ${reviewer.displayName} response, but its OPAQUE_JSON_V1 adapter does not infer a provider verdict. The action remains unresolved until a source-specific deterministic adapter or signed reviewer delivery is available.`,
            evidenceArtifactIds: [artifact.id],
          })),
        provenance: {
          kind: publicApi ? 'PUBLIC_API_EVIDENCE_V1' as const : includedQuota ? 'AUTHENTICATED_API_EVIDENCE_V1' as const : 'X402_PAID_EVIDENCE_V1' as const,
          sourceId: reviewer.id,
          endpoint: reviewer.procurementEndpoint,
          observedAt,
          requestHash,
          responseHash,
          ...(recordedPayment ? { payment: recordedPayment } : {}),
          ...(includedQuota && !publicApi ? { authentication: { scheme: 'OKX_HMAC_SHA256' as const, includedQuota: true as const } } : {}),
          ...(publicApi ? { transport: { scheme: 'PUBLIC_HTTPS' as const, marginalCostUsd: 0 as const } } : {}),
        },
      }
      return {
        externalRequestId: `evidence-${responseHash.slice(2, 18)}`,
        ...(recordedPayment ? { payment: recordedPayment } : {}),
        ...(includedQuota ? { includedQuota: { sourceId: reviewer.id, authentication: publicApi ? 'PUBLIC_HTTPS' as const : 'OKX_HMAC_SHA256' as const } } : {}),
        evidence: { delivery, provenance: delivery.provenance, responseBody },
      }
    }
    const response = await paid.json() as { requestId?: unknown }
    if (typeof response.requestId !== 'string' || !response.requestId.trim()) {
      throw new Error('External reviewer accepted payment without returning a stable requestId.')
    }
    return { externalRequestId: response.requestId, payment: recordedPayment }
  }
}
