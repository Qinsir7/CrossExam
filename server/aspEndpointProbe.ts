import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { decodePaymentRequiredHeader } from '@okxweb3/x402-core/http'
import { keccak256, stringToHex } from 'viem'
import { createActionBinding } from '../src/domain/actionBinding'
import type { AssuranceAction, AssuranceVerdict, EvidenceObservation } from '../src/domain/assuranceAction'
import type { AspTrustCheckRequest } from '../src/domain/assuranceContracts'
import type { CrossExamResult, DecisionClaim, DecisionPackage } from '../src/domain/types'
import { issueDecisionAssuranceRecord, type DecisionAssuranceRecord } from './assuranceRecord'

type AddressRecord = { address: string; family: number }
type ProbeResponse = { status: number; headers: Record<string, string | undefined>; body: string; latencyMs: number }
type ProbeDependencies = {
  resolve?: (hostname: string) => Promise<AddressRecord[]>
  request?: (input: { url: URL; address: string; method: 'GET' | 'HEAD' }) => Promise<ProbeResponse>
  now?: () => Date
}

function forbiddenIpv4(value: string) {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19))
}

function forbiddenAddress(address: string, family: number) {
  if (family === 4) return forbiddenIpv4(address)
  const normalized = address.toLowerCase()
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  return Boolean(mapped && forbiddenIpv4(mapped[1]))
}

function validateUrl(endpoint: string) {
  let url: URL
  try { url = new URL(endpoint) } catch { throw new Error('Endpoint must be a valid absolute HTTPS URL.') }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Passive endpoint probes allow only credential-free HTTPS URLs on port 443.')
  }
  return url
}

function boundedBody(chunks: Buffer[]) {
  const body = Buffer.concat(chunks)
  if (body.byteLength > 65_536) throw new Error('Endpoint response exceeded the 64 KiB passive-probe limit.')
  return body.toString('utf8')
}

async function pinnedHttpsRequest(input: { url: URL; address: string; method: 'GET' | 'HEAD' }): Promise<ProbeResponse> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const client = httpsRequest({
      hostname: input.address,
      servername: input.url.hostname,
      port: 443,
      path: `${input.url.pathname}${input.url.search}`,
      method: input.method,
      headers: { host: input.url.host, accept: 'application/json, */*;q=0.1', 'user-agent': 'CrossExam-ASP-Probe/0.1' },
      timeout: 8_000,
      rejectUnauthorized: true,
    }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 65_536) client.destroy(new Error('Endpoint response exceeded the 64 KiB passive-probe limit.'))
        else chunks.push(chunk)
      })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value])), body: boundedBody(chunks), latencyMs: Date.now() - started }))
    })
    client.once('timeout', () => client.destroy(new Error('Endpoint probe timed out after 8 seconds.')))
    client.once('error', reject)
    client.end()
  })
}

function facts(response: ProbeResponse, challenge?: { amount: string; payTo: string; asset: string; maxTimeoutSeconds: number }) {
  return [
    { key: 'availability.httpStatus', value: response.status },
    { key: 'availability.latencyMs', value: response.latencyMs, unit: 'ms' },
    { key: 'behavior.redirect', value: response.status >= 300 && response.status < 400 },
    ...(challenge ? [
      { key: 'payment.amountAtomic', value: challenge.amount },
      { key: 'payment.recipient', value: challenge.payTo },
      { key: 'payment.asset', value: challenge.asset },
      { key: 'payment.timeoutSeconds', value: challenge.maxTimeoutSeconds, unit: 'seconds' },
    ] : []),
  ]
}

function decisionResult(claims: DecisionClaim[], recommendation: 'BUY' | 'CAUTION' | 'AVOID', verdict: AssuranceVerdict): CrossExamResult {
  return {
    claims: claims.map((claim) => ({ id: claim.id, text: claim.statement, verdict: recommendation === 'BUY' ? 'SURVIVED' as const : recommendation === 'AVOID' ? 'REFUTED' as const : 'UNRESOLVED' as const, evidence: verdict.reasons.join(' '), challenger: 'crossexam-asp-probe' })),
    action: recommendation === 'BUY' ? 'PROCEED' : recommendation === 'AVOID' ? 'BLOCK' : 'HOLD',
    effectiveIndependence: 1,
    materialRefutations: recommendation === 'AVOID' ? claims.length : 0,
    materialUnresolved: recommendation === 'CAUTION' ? claims.length : 0,
    reversalConditions: verdict.reversalConditions.map((condition) => ({ claimId: condition.claimId, kind: recommendation === 'AVOID' ? 'OVERTURN_CONTRADICTION' as const : 'RESOLVE_UNCERTAINTY' as const, requirement: condition.requirement, basedOnEvidence: verdict.reasons.join(' ') })),
  }
}

export async function prepareAspTrustCheck(input: AspTrustCheckRequest, dependencies: ProbeDependencies = {}) {
  const now = dependencies.now ?? (() => new Date())
  const url = validateUrl(input.endpoint)
  const requestedMethod = input.intendedRequest?.method ?? 'GET'
  if (requestedMethod !== 'GET') throw new Error('PASSIVE ASP checks intentionally permit only GET; POST is reserved for an explicit future paid-call policy.')
  const method: 'GET' = requestedMethod
  if (input.probeMode === 'PAID_CALL') throw new Error('PAID_CALL is not enabled: CrossExam will not spend against an untrusted ASP until a recipient-bound procurement policy is configured.')
  const resolved = await (dependencies.resolve ?? (async (hostname: string) => lookup(hostname, { all: true, verbatim: true })))(url.hostname)
  if (!resolved.length || resolved.some((address) => forbiddenAddress(address.address, address.family))) throw new Error('Endpoint resolves to a loopback, private, link-local, multicast, or otherwise forbidden address.')
  // Pinning the chosen public address for the TLS request prevents a DNS answer
  // from changing between the validation and the actual passive probe.
  const response = await (dependencies.request ?? pinnedHttpsRequest)({ url, address: resolved[0].address, method })
  const requestHash = keccak256(stringToHex(JSON.stringify({ method, url: url.toString() })))
  const responseHash = keccak256(stringToHex(response.body))
  let challenge: { amount: string; payTo: string; asset: string; maxTimeoutSeconds: number } | undefined
  let challengeError: string | undefined
  if (response.status === 402) {
    try {
      const required = decodePaymentRequiredHeader(response.headers['payment-required'] ?? '')
      const accepted = required.accepts.find((item) => item.scheme === 'exact' && item.network === 'eip155:196'
        && /^0x[a-fA-F0-9]{40}$/.test(item.asset) && /^0x[a-fA-F0-9]{40}$/.test(item.payTo)
        && /^[1-9][0-9]*$/.test(item.amount) && Number.isInteger(item.maxTimeoutSeconds) && item.maxTimeoutSeconds > 0 && item.maxTimeoutSeconds <= 600)
      if (!accepted) throw new Error('The endpoint offered no bounded X Layer exact payment option.')
      challenge = { amount: accepted.amount, payTo: accepted.payTo, asset: accepted.asset, maxTimeoutSeconds: accepted.maxTimeoutSeconds }
      if (input.expectedPriceAtomic && input.expectedPriceAtomic !== challenge.amount) challengeError = 'The challenged payment amount differs from the caller expectation.'
      if (input.expectedRecipient && input.expectedRecipient.toLowerCase() !== challenge.payTo.toLowerCase()) challengeError = 'The challenged payment recipient differs from the caller expectation.'
    } catch (error) { challengeError = error instanceof Error ? error.message : 'The endpoint returned an unreadable payment challenge.' }
  }
  const reasons = response.status >= 300 && response.status < 400
    ? ['Endpoint attempted a redirect; CrossExam never follows redirects during a passive trust check.']
    : response.status !== 402
      ? [`Endpoint returned HTTP ${response.status}; no standard unpaid payment challenge was observed.`]
      : challengeError ? [challengeError] : ['Endpoint returned a bounded, coherent X Layer payment challenge. Passive probing does not verify marketplace identity, ownership, or paid behavior.']
  const recommendation = response.status >= 300 && response.status < 400 || response.status === 0 ? 'AVOID' as const : response.status === 402 && challenge && !challengeError ? 'BUY' as const : 'CAUTION' as const
  const verdict: AssuranceVerdict = {
    verdict: recommendation === 'BUY' ? 'PERMIT' : recommendation === 'AVOID' ? 'BLOCK' : 'HOLD',
    canExecute: recommendation === 'BUY',
    reasons,
    reversalConditions: recommendation === 'BUY' ? [] : [{ claimId: 'C-PAYMENT-CONTRACT', requirement: 'Provide a reachable endpoint with a bounded, standards-compliant X Layer payment challenge matching the expected commercial terms.' }],
  }
  const claims: DecisionClaim[] = [
    { id: 'C-ENDPOINT-HTTPS', statement: 'The requested ASP endpoint is a reachable public HTTPS origin without redirect indirection.', materiality: 1 },
    { id: 'C-PAYMENT-CONTRACT', statement: 'The unpaid endpoint exposes a bounded X Layer payment challenge coherent with the expected service terms.', materiality: 1 },
  ]
  const action: AssuranceAction = {
    id: input.id?.trim() || `AA-ASP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    kind: 'ASP_PURCHASE',
    title: input.title?.trim() || `Assess ASP endpoint ${url.hostname}`,
    valueAtRiskUsd: input.valueAtRiskUsd,
    binding: await createActionBinding('SPEND', `asp:${url.origin}`, JSON.stringify({ endpoint: url.toString(), method, expectedPriceAtomic: input.expectedPriceAtomic ?? null, expectedRecipient: input.expectedRecipient ?? null })),
    aspPurchase: { endpoint: url.toString(), ...(input.agentId ? { agentId: input.agentId } : {}), ...(input.serviceId ? { serviceId: input.serviceId } : {}), ...(input.expectedPriceAtomic ? { expectedPriceAtomic: input.expectedPriceAtomic } : {}) },
  }
  const decision: DecisionPackage = { id: `DP-${action.id.replace(/^AA-/, '')}`, title: action.title, valueAtRiskUsd: action.valueAtRiskUsd, claims, actionBinding: action.binding }
  const observation: EvidenceObservation = { id: `EO-${responseHash.slice(2, 18)}`, scopeId: 'asp-passive-endpoint', sourceId: 'crossexam-asp-probe', sourceOwner: 'crossexam', kind: 'PUBLIC_API', observedAt: now().toISOString(), requestHash, responseHash, locator: url.toString(), facts: facts(response, challenge), addressedClaimIds: claims.map((claim) => claim.id) }
  const dispatch = { id: `RD-${decision.id.replace('DP-', '')}`, decisionId: decision.id, status: 'STAGED' as const, assignments: [] }
  const record: DecisionAssuranceRecord = issueDecisionAssuranceRecord(decision, dispatch, decisionResult(claims, recommendation, verdict), now().toISOString())
  return { action, observations: [observation], verdict, recommendation, record }
}
