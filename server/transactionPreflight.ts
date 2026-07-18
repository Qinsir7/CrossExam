import { createTransactionAssuranceAction, toDecisionPackage, type AssuranceAction, type AssuranceVerdict, type EvidenceObservation } from '../src/domain/assuranceAction'
import type { TransactionPreflightRequest } from '../src/domain/assuranceContracts'
import { compileTransactionClaims } from '../src/domain/transactionClaims'
import { mapTransactionEvidence } from '../src/domain/transactionEvidence'
import { evaluateTransactionPreflight } from '../src/domain/transactionPolicy'
import type { CrossExamResult } from '../src/domain/types'
import { aggregateProcurementVerifiedAssurance } from './assuranceService'
import { issueDecisionAssuranceRecord, type DecisionAssuranceRecord } from './assuranceRecord'
import { blindTaskForProcurement, createReviewJob, markIncludedQuotaProcurementRequested, markProcurementDispatching, markProcurementRequested, recordPaidEvidenceDelivery, type ReviewJob } from './reviewJob'
import type { ExternalReviewProvider } from './reviewJobWorker'
import type { ReviewerRegistry } from './reviewerRegistry'
import { XLAYER_USDT0 } from './customerPayment'

type SourceFailure = { scopeId: string; sourceId?: string; message: string }

export type PreparedTransactionPreflight = {
  action: AssuranceAction
  decision: ReturnType<typeof toDecisionPackage>
  claims: ReturnType<typeof compileTransactionClaims>['claims']
  evidence: EvidenceObservation[]
  verdict: AssuranceVerdict
  record: DecisionAssuranceRecord
  economics: {
    externalEvidenceCostUsdt: number
    costBasis: 'INCLUDED_API_QUOTA' | 'SETTLED_X402' | 'MIXED'
  }
  procurementFailures: SourceFailure[]
}

export const supportedTransactionPreflightBoundary = 'Transaction Preflight currently supports only exact X Layer token trades with an explicit token risk target. CrossExam will not charge for a scope its live evidence sources cannot fulfill.'

/**
 * Validates the paid preflight boundary before the x402 middleware is reached.
 * The current production evidence profile is deliberately narrow: it can bind
 * an exact X Layer trade to liquidity and token-security observations. A
 * payment, approval, deployment, another chain, or an unidentified router
 * asset needs a different registered evidence profile and must not be sold as
 * this product today.
 */
export async function validateTransactionPreflightInput(input: unknown): Promise<AssuranceAction> {
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    throw new Error(`${supportedTransactionPreflightBoundary} Provide a structured transaction request.`)
  }
  const action = await createTransactionAssuranceAction(input as TransactionPreflightRequest)
  if (action.binding.actionType !== 'TRADE' || action.evm?.chainId !== 196 || !action.reviewEvidenceContext?.tokenRiskTarget) {
    throw new Error(supportedTransactionPreflightBoundary)
  }
  return action
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be a JSON object.`)
  return value as Record<string, unknown>
}

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === true || value === '1' || value === 'true') return true
  if (value === false || value === '0' || value === 'false') return false
  return undefined
}

function observationKind(kind: string): EvidenceObservation['kind'] {
  if (kind === 'AUTHENTICATED_API_EVIDENCE_V1') return 'AUTHENTICATED_API'
  if (kind === 'PUBLIC_API_EVIDENCE_V1') return 'PUBLIC_API'
  return 'PAID_API'
}

function responseObservation(action: AssuranceAction, job: ReviewJob, scopeId: string, registry: ReviewerRegistry): EvidenceObservation | null {
  const assignment = job.dispatch.assignments.find((item) => item.scopeId === scopeId)
  const procurement = job.procurements.find((item) => item.scopeId === scopeId)
  const source = assignment?.reviewer ? registry[assignment.reviewer.id] : undefined
  const delivery = assignment?.delivery
  const provenance = delivery?.provenance
  const responseBody = procurement?.evidence?.responseBody
  if (!source || !delivery || !provenance || !responseBody) return null

  const body = object(JSON.parse(responseBody), `${source.id} response`)
  const facts: EvidenceObservation['facts'] = []
  if (source.responseAdapter === 'OKX_TOKEN_LIQUIDITY_V1') {
    if (body.code !== '0' || !Array.isArray(body.data)) throw new Error('OKX liquidity evidence did not contain a successful data envelope.')
    const liquidities = body.data
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      .map((pool) => numeric(pool.liquidityUsd))
      .filter((value): value is number => value !== undefined && value >= 0)
    if (!liquidities.length) throw new Error('OKX liquidity evidence contained no usable pool liquidity values.')
    facts.push({ key: 'liquidity.totalUsd', value: liquidities.reduce((sum, value) => sum + value, 0), unit: 'USD' })
    facts.push({ key: 'liquidity.poolCount', value: liquidities.length, unit: 'pools' })
  } else if (source.responseAdapter === 'GOPLUS_TOKEN_SECURITY_V1') {
    const target = action.reviewEvidenceContext?.tokenRiskTarget
    const address = target?.match(/0x[a-fA-F0-9]{40}$/)?.[0].toLowerCase()
    const result = object(body.result, 'GoPlus result')
    const risk = address ? object(result[address], 'GoPlus token record') : undefined
    if (!risk) throw new Error('GoPlus evidence has no record for the action-bound token.')
    const flags: Array<[string, unknown]> = [
      ['tokenRisk.honeypot', risk.is_honeypot],
      ['tokenRisk.cannotBuy', risk.cannot_buy],
      ['tokenRisk.cannotSellAll', risk.cannot_sell_all],
      ['tokenRisk.blacklist', risk.is_blacklisted],
      ['tokenRisk.sourceOpen', risk.is_open_source],
      ['tokenRisk.proxy', risk.is_proxy],
      ['tokenRisk.creatorHoneypot', risk.honeypot_with_same_creator],
    ]
    flags.forEach(([key, value]) => {
      const normalized = optionalBoolean(value)
      if (normalized !== undefined) facts.push({ key, value: normalized })
    })
    const taxes: Array<[string, unknown]> = [
      ['tokenRisk.buyTax', risk.buy_tax],
      ['tokenRisk.sellTax', risk.sell_tax],
      ['tokenRisk.transferTax', risk.transfer_tax],
    ]
    taxes.forEach(([key, value]) => {
      const normalized = numeric(value)
      if (normalized !== undefined) facts.push({ key, value: normalized, unit: 'fraction' })
    })
  } else {
    // A generic opaque source may be retained in the signed record, but it is
    // not silently converted into a policy fact. That keeps unknown schemas
    // fail-closed until a deterministic normalizer is introduced.
    return null
  }

  return {
    id: `EO-${provenance.responseHash.slice(2, 18)}`,
    scopeId,
    sourceId: source.id,
    sourceOwner: source.ownerId,
    kind: observationKind(provenance.kind),
    observedAt: provenance.observedAt,
    requestHash: provenance.requestHash,
    responseHash: provenance.responseHash,
    locator: provenance.endpoint,
    facts,
    addressedClaimIds: delivery.findings.map((finding) => finding.claimId),
    ...(provenance.payment ? { cost: { asset: provenance.payment.asset as `0x${string}`, amountAtomic: provenance.payment.amountAtomic, transaction: provenance.payment.transaction as `0x${string}` } } : {}),
  }
}

function resultFromVerdict(decision: ReturnType<typeof toDecisionPackage>, verdict: AssuranceVerdict, evidence: ReturnType<typeof mapTransactionEvidence>, observations: EvidenceObservation[]): CrossExamResult {
  const byClaim = new Map(evidence.map((item) => [item.claimId, item]))
  return {
    claims: decision.claims.map((claim) => {
      const finding = byClaim.get(claim.id)
      return {
        id: claim.id,
        text: claim.statement,
        verdict: finding?.verdict === 'SUPPORTS' ? 'SURVIVED' : finding?.verdict === 'CONTRADICTS' ? 'REFUTED' : 'UNRESOLVED',
        evidence: finding?.explanation ?? 'No decision-grade evidence result exists for this material claim.',
        challenger: finding?.evidenceObservationIds[0]
          ? observations.find((item) => item.id === finding.evidenceObservationIds[0])?.sourceId ?? 'crossexam'
          : 'crossexam-action-binding',
      }
    }),
    action: verdict.verdict === 'PERMIT' ? 'PROCEED' : verdict.verdict,
    effectiveIndependence: new Set(observations.map((item) => item.sourceOwner)).size,
    materialRefutations: evidence.filter((item) => item.verdict === 'CONTRADICTS').length,
    materialUnresolved: evidence.filter((item) => item.verdict === 'INSUFFICIENT_EVIDENCE').length,
    reversalConditions: verdict.reversalConditions.map((condition) => ({
      claimId: condition.claimId,
      kind: verdict.verdict === 'BLOCK' ? 'OVERTURN_CONTRADICTION' as const : 'RESOLVE_UNCERTAINTY' as const,
      requirement: condition.requirement,
      basedOnEvidence: verdict.reasons.join(' '),
    })),
  }
}

function actualSettledCost(job: ReviewJob) {
  // Amounts are reported only for settled X Layer USDT0 receipts, whose six
  // decimals are defined by the protocol. Included quota or another asset is
  // not relabelled as a made-up dollar spend.
  return Number((job.procurements
    .filter((item) => item.payment?.asset.toLowerCase() === XLAYER_USDT0)
    .reduce((sum, item) => sum + Number(item.payment!.amountAtomic) / 1_000_000, 0)).toFixed(6))
}

function costBasis(job: ReviewJob): PreparedTransactionPreflight['economics']['costBasis'] {
  const paid = job.procurements.some((item) => Boolean(item.payment))
  const quota = job.procurements.some((item) => Boolean(item.includedQuota))
  return paid && quota ? 'MIXED' : paid ? 'SETTLED_X402' : 'INCLUDED_API_QUOTA'
}

/**
 * Executes the production transaction-preflight chain. The provider is real
 * in the application; tests inject a bounded fake transport only to exercise
 * parsing and policy. No source failure is converted into a safe result.
 */
export async function prepareTransactionPreflight(
  input: TransactionPreflightRequest,
  dependencies: { registry: ReviewerRegistry; provider: ExternalReviewProvider; now?: () => Date },
): Promise<PreparedTransactionPreflight> {
  const now = dependencies.now ?? (() => new Date())
  const action = await validateTransactionPreflightInput(input)
  const compiled = compileTransactionClaims(action)
  const decision = toDecisionPackage(action, compiled.claims, 'PRETRADE_ONCHAIN')
  let job = createReviewJob(decision, dependencies.registry, now().toISOString())
  const failures: SourceFailure[] = []

  for (const procurement of [...job.procurements]) {
    const assignment = job.dispatch.assignments.find((item) => item.scopeId === procurement.scopeId)
    if (!assignment?.reviewer) {
      failures.push({ scopeId: procurement.scopeId, message: 'No independent, compatible evidence source is currently available for this scope.' })
      continue
    }
    try {
      job = markProcurementDispatching(job, procurement.scopeId, now().toISOString())
      const response = await dependencies.provider.requestReview({
        jobId: job.id,
        scopeId: procurement.scopeId,
        reviewerId: assignment.reviewer.id,
        idempotencyKey: job.procurements.find((item) => item.scopeId === procurement.scopeId)!.idempotencyKey,
        task: blindTaskForProcurement(job, procurement.scopeId),
      })
      if (response.payment) {
        job = markProcurementRequested(job, procurement.scopeId, response.externalRequestId, response.payment, now().toISOString())
      } else if (response.includedQuota) {
        job = markIncludedQuotaProcurementRequested(job, procurement.scopeId, response.externalRequestId, response.includedQuota.sourceId, response.includedQuota.authentication, now().toISOString())
      } else {
        throw new Error('Evidence source returned neither a settled payment nor an included-quota receipt.')
      }
      if (!response.evidence) throw new Error('Evidence source acknowledged work but returned no immediate immutable evidence result.')
      job = recordPaidEvidenceDelivery(job, procurement.scopeId, response.evidence.delivery, response.evidence.provenance, response.evidence.responseBody, dependencies.registry, now().toISOString())
    } catch (error) {
      failures.push({ scopeId: procurement.scopeId, sourceId: assignment.reviewer.id, message: error instanceof Error ? error.message : 'Evidence procurement failed.' })
    }
  }

  const observations = job.procurements.flatMap((procurement) => {
    try {
      const observation = responseObservation(action, job, procurement.scopeId, dependencies.registry)
      return observation ? [observation] : []
    } catch (error) {
      const assignment = job.dispatch.assignments.find((item) => item.scopeId === procurement.scopeId)
      failures.push({ scopeId: procurement.scopeId, sourceId: assignment?.reviewer?.id, message: error instanceof Error ? error.message : 'Evidence normalization failed.' })
      return []
    }
  })
  const evidence = mapTransactionEvidence(action, compiled.claims, observations)
  let verdict = evaluateTransactionPreflight(action, compiled.claims, evidence, job.status === 'READY_FOR_ASSURANCE' ? 'PROCUREMENT_VERIFIED' : 'DECLARED_BY_CALLER')
  if (failures.length) {
    verdict = {
      ...verdict,
      verdict: verdict.verdict === 'BLOCK' ? 'BLOCK' : 'HOLD',
      canExecute: false,
      reasons: [...verdict.reasons, ...failures.map((failure) => `${failure.scopeId}: ${failure.message}`)],
      reversalConditions: [...verdict.reversalConditions, ...failures.map((failure) => ({ claimId: `SOURCE-${failure.scopeId}`, requirement: `Obtain a fresh successful result from ${failure.sourceId ?? 'a compatible independent source'} for ${failure.scopeId}.` }))],
    }
  }

  // This validates the complete evidence graph and source provenance before a
  // procurement-qualified record is issued. Partial or failed procurement is
  // deliberately downgraded rather than overstated.
  const attributionStatus = job.status === 'READY_FOR_ASSURANCE'
    ? (await aggregateProcurementVerifiedAssurance({ decision, dispatch: job.dispatch }, dependencies.registry, now().toISOString())).attributionStatus
    : 'DECLARED_BY_CALLER' as const
  const record = issueDecisionAssuranceRecord(decision, job.dispatch, resultFromVerdict(decision, verdict, evidence, observations), now().toISOString(), attributionStatus)

  return {
    action,
    decision,
    claims: compiled.claims,
    evidence: observations,
    verdict,
    record,
    economics: { externalEvidenceCostUsdt: actualSettledCost(job), costBasis: costBasis(job) },
    procurementFailures: failures,
  }
}
