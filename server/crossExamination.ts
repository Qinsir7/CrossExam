import { createActionBinding } from '../src/domain/actionBinding'
import { createTransactionAssuranceAction, toDecisionPackage, type AssuranceAction } from '../src/domain/assuranceAction'
import type { CrossExaminationPreparationRequest, CrossExaminationPreparationResponse, CrossExaminationResponse, EvidencePlanScope } from '../src/domain/assuranceContracts'
import { compileTransactionClaims } from '../src/domain/transactionClaims'
import { createReviewPlan } from '../src/domain/reviewPlan'
import type { ActionType, DecisionClaim, DecisionPackage, ReviewProfile } from '../src/domain/types'
import { stageReviewPlan } from '../src/network/reviewNetwork'
import { createReviewJobWithAccess } from './reviewJob'
import { quoteReview } from './reviewPricing'
import { applyMatchedProviderCosts, type ReviewerRegistry } from './reviewerRegistry'

export type CrossExaminationPricing = {
  authorizationPriceUsd: string
  minimumGrossMarginFraction: number
}

export type PreparedCrossExamination = CrossExaminationPreparationResponse & {
  canStart: boolean
}

function actionKind(actionType: ActionType): AssuranceAction['kind'] {
  if (actionType === 'DEPLOY') return 'DEPLOYMENT'
  if (actionType === 'PUBLISH') return 'PUBLISH'
  if (actionType === 'OTHER') return 'OTHER'
  return 'TRANSACTION'
}

function requiredText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  return value.trim()
}

function actionFromDecision(decision: DecisionPackage): AssuranceAction {
  if (!decision.actionBinding) {
    throw new Error('Advanced Cross-Examination input requires an exact actionBinding. Use simple input to bind a new action.')
  }
  return {
    id: `AA-${decision.id.replace(/^DP-/, '')}`,
    kind: actionKind(decision.actionBinding.actionType),
    title: requiredText(decision.title, 'Decision title'),
    valueAtRiskUsd: decision.valueAtRiskUsd,
    binding: decision.actionBinding,
    ...(decision.reviewEvidenceContext ? { reviewEvidenceContext: decision.reviewEvidenceContext } : {}),
  }
}

function genericClaims(): DecisionClaim[] {
  return [
    {
      id: 'C-INTENT-SCOPE',
      statement: 'The exact action and decision scope supplied by the caller remain unchanged through execution.',
      materiality: 1,
    },
    {
      id: 'C-EVIDENCE-BASIS',
      statement: 'Each material factual premise for the action is independently supported by traceable, current evidence.',
      materiality: 1,
    },
    {
      id: 'C-ASSUMPTION-CHALLENGE',
      statement: 'Material assumptions survive relevant counterexamples and omitted preconditions.',
      materiality: 0.9,
    },
    {
      id: 'C-DOMAIN-RISK',
      statement: 'Known domain-specific failure modes do not contradict the proposed action.',
      materiality: 0.9,
    },
  ]
}

async function decisionFromSimple(input: NonNullable<CrossExaminationPreparationRequest['simple']>): Promise<{ action: AssuranceAction; decision: DecisionPackage; claims: DecisionClaim[]; limitations: string[] }> {
  const title = requiredText(input.title, 'Action title')
  const intent = requiredText(input.intent, 'Action intent')
  if (!Number.isFinite(input.valueAtRiskUsd) || input.valueAtRiskUsd <= 0 || input.valueAtRiskUsd > 1_000_000_000_000) {
    throw new Error('Value at risk must be a positive USD amount no greater than 1000000000000.')
  }

  if (input.transaction) {
    const action = await createTransactionAssuranceAction({
      ...input.transaction,
      title,
      intent,
      valueAtRiskUsd: input.valueAtRiskUsd,
      ...(input.tokenRiskTarget ? { tokenRiskTarget: input.tokenRiskTarget } : {}),
    })
    const compiled = compileTransactionClaims(action)
    const livePretradeProfile = action.binding.actionType === 'TRADE'
      && action.evm?.chainId === 196
      && Boolean(action.reviewEvidenceContext?.tokenRiskTarget)
    const limitations = [...compiled.limitations]
    if (!livePretradeProfile) {
      limitations.push('Live deep Cross-Examination currently fulfills only exact X Layer token trades with an explicit token risk target. This action is structured but cannot be purchased until a matching independent evidence profile is registered.')
    }
    return {
      action,
      decision: toDecisionPackage(action, compiled.claims, livePretradeProfile ? 'PRETRADE_ONCHAIN' satisfies ReviewProfile : 'GENERAL'),
      claims: compiled.claims,
      limitations,
    }
  }

  const binding = await createActionBinding('OTHER', `intent:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'decision'}`, JSON.stringify({ title, intent }))
  const action: AssuranceAction = {
    id: `AA-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    kind: 'OTHER',
    title,
    valueAtRiskUsd: input.valueAtRiskUsd,
    intent,
    binding,
  }
  const claims = genericClaims()
  return { action, decision: toDecisionPackage(action, claims, 'GENERAL'), claims, limitations: [] }
}

async function normalizeInput(input: CrossExaminationPreparationRequest) {
  const hasSimple = input?.simple !== undefined
  const hasDecision = input?.decision !== undefined
  if (hasSimple === hasDecision) throw new Error('Provide exactly one of simple or decision.')
  if (hasSimple) return decisionFromSimple(input.simple!)

  const decision = input.decision!
  const action = actionFromDecision(decision)
  if (!Array.isArray(decision.claims) || decision.claims.length === 0) throw new Error('Advanced Cross-Examination input requires at least one material claim.')
  return { action, decision, claims: decision.claims, limitations: [] }
}

function planScopes(decision: DecisionPackage, registry: ReviewerRegistry): { evidencePlan: EvidencePlanScope[]; unmatchedScopeIds: string[]; estimatedExternalCostUsdt: number } {
  const canonicalPlan = createReviewPlan(decision)
  const activeReviewers = Object.values(registry).filter((reviewer) => reviewer.status === 'ACTIVE')
  const staged = stageReviewPlan(canonicalPlan, activeReviewers)
  const plan = applyMatchedProviderCosts(canonicalPlan, staged, registry)
  const evidencePlan = plan.scopes.map((scope) => {
    const assignment = staged.assignments.find((candidate) => candidate.scopeId === scope.id)
    return {
      id: scope.id,
      title: scope.title,
      objective: scope.objective,
      claimIds: scope.claimIds,
      sourceIds: assignment?.reviewer ? [assignment.reviewer.id] : [],
      estimatedCostUsdt: scope.estimatedFeeUsdt,
    }
  })
  return {
    evidencePlan,
    unmatchedScopeIds: staged.assignments.filter((assignment) => !assignment.reviewer).map((assignment) => assignment.scopeId),
    estimatedExternalCostUsdt: plan.estimatedTotalUsdt,
  }
}

/**
 * Prepares a deterministic action, claims, source plan, and economics without
 * creating a job, charging a customer, or authorizing provider procurement.
 */
export async function prepareCrossExamination(
  input: CrossExaminationPreparationRequest,
  registry: ReviewerRegistry,
  pricing: CrossExaminationPricing,
): Promise<PreparedCrossExamination> {
  const normalized = await normalizeInput(input)
  const planned = planScopes(normalized.decision, registry)
  const quote = quoteReview({
    id: `RP-${normalized.decision.id.replace(/^DP-/, '')}`,
    decisionId: normalized.decision.id,
    scopes: planned.evidencePlan.map((scope) => ({
      id: scope.id,
      title: scope.title,
      objective: scope.objective,
      claimIds: scope.claimIds,
      requiredCapability: '',
      estimatedFeeUsdt: scope.estimatedCostUsdt,
    })),
    estimatedTotalUsdt: planned.estimatedExternalCostUsdt,
  }, pricing.authorizationPriceUsd, pricing.minimumGrossMarginFraction)
  const limitations = [...normalized.limitations]
  if (planned.unmatchedScopeIds.length) {
    limitations.push(`No active independent provider is registered for: ${planned.unmatchedScopeIds.join(', ')}. CrossExam will not accept payment for an unfulfillable review.`)
  }
  return {
    action: normalized.action,
    decision: normalized.decision,
    generatedClaims: normalized.claims,
    evidencePlan: planned.evidencePlan,
    quote: {
      priceUsdt: quote.authorizationPriceUsdt.toFixed(2),
      externalEvidenceBudgetUsdt: quote.estimatedExternalCostUsdt,
      minimumGrossMarginFraction: quote.minimumGrossMarginFraction,
    },
    limitations,
    canStart: planned.unmatchedScopeIds.length === 0 && normalized.limitations.length === 0,
  }
}

/**
 * Starts only a fulfillable durable review. The returned owner capability is
 * required by the existing x402 authorization, status, ledger, result and
 * access-recovery endpoints. Job creation itself cannot spend any wallet.
 */
export async function startCrossExamination(
  input: CrossExaminationPreparationRequest,
  registry: ReviewerRegistry,
  pricing: CrossExaminationPricing,
): Promise<CrossExaminationResponse & { job: ReturnType<typeof createReviewJobWithAccess>['job'] }> {
  const prepared = await prepareCrossExamination(input, registry, pricing)
  if (!prepared.canStart) {
    throw new Error(`Cross-Examination cannot be purchased yet: ${prepared.limitations.join(' ')}`)
  }
  const created = createReviewJobWithAccess(prepared.decision, registry, undefined, pricing)
  return {
    job: created.job,
    jobId: created.job.id,
    status: created.job.status,
    accessToken: created.accessToken,
    action: prepared.action,
    decision: prepared.decision,
    evidencePlan: prepared.evidencePlan,
    quote: prepared.quote,
    authorization: {
      endpoint: '/api/v1/review-jobs/authorize',
      method: 'POST',
      required: true,
      request: { jobId: created.job.id, accessToken: created.accessToken },
    },
  }
}
