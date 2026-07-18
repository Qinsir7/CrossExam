import { createEvmActionBinding, canonicalizeEvmTransaction, type CanonicalEvmTransaction, type EvmActionInput } from './evmAction'
import type { ActionBinding, ActionType, DecisionClaim, DecisionPackage, ReviewEvidenceContext, ReviewProfile } from './types'

/**
 * The product-level action understood by every new CrossExam service.
 *
 * Existing DecisionPackage, ReviewJob and DecisionAssuranceRecord types remain
 * the durable review/settlement model. This type is the narrow intake layer
 * that prevents each product entry point from inventing its own action hash.
 */
export type AssuranceActionKind = 'TRANSACTION' | 'ASP_PURCHASE' | 'DEPLOYMENT' | 'PUBLISH' | 'OTHER'

export type AssuranceAction = {
  id: string
  kind: AssuranceActionKind
  title: string
  valueAtRiskUsd: number
  intent?: string
  binding: ActionBinding
  evm?: CanonicalEvmTransaction & { from?: string }
  reviewEvidenceContext?: ReviewEvidenceContext
  aspPurchase?: {
    agentId?: string
    serviceId?: string
    endpoint: string
    expectedPriceAtomic?: string
  }
}

export type TransactionAssuranceActionInput = EvmActionInput & {
  id?: string
  title: string
  valueAtRiskUsd: number
  intent?: string
  /** The sender is not part of the current executable binding, but is retained for provider context and display. */
  from?: string
}

export type EvidenceObservationKind = 'AUTHENTICATED_API' | 'PUBLIC_API' | 'PAID_API' | 'SIGNED_REVIEWER'

/**
 * A provider-normalized fact. It is intentionally distinct from a signed
 * reviewer delivery: public and authenticated APIs can be provenance-verified
 * evidence without being misrepresented as independent reviewer signatures.
 */
export type EvidenceObservation = {
  id: string
  scopeId: string
  sourceId: string
  sourceOwner: string
  kind: EvidenceObservationKind
  observedAt: string
  requestHash: `0x${string}`
  responseHash: `0x${string}`
  locator: string
  facts: Array<{
    key: string
    value: string | number | boolean | null
    unit?: string
  }>
  addressedClaimIds: string[]
  cost?: {
    asset: `0x${string}`
    amountAtomic: string
    transaction?: `0x${string}`
  }
}

export type AssuranceVerdictKind = 'PERMIT' | 'HOLD' | 'BLOCK'

export type AssuranceVerdict = {
  verdict: AssuranceVerdictKind
  canExecute: boolean
  reasons: string[]
  strongestContradiction?: {
    claimId: string
    summary: string
    evidenceObservationIds: string[]
  }
  reversalConditions: Array<{
    claimId: string
    requirement: string
  }>
}

function requiredText(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

function optionalAddress(value: string | undefined, label: string) {
  if (value === undefined || value.trim() === '') return undefined
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error(`${label} must be a 20-byte 0x address.`)
  return value.toLowerCase()
}

function actionId(value: string | undefined) {
  if (value === undefined || value.trim() === '') return `AA-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
  const normalized = value.trim()
  if (!/^AA-[A-Za-z0-9_-]{1,120}$/.test(normalized)) throw new Error('Assurance action ID must use AA- followed by letters, numbers, underscores, or hyphens.')
  return normalized
}

function actionKind(actionType: ActionType): AssuranceActionKind {
  if (actionType === 'DEPLOY') return 'DEPLOYMENT'
  if (actionType === 'PUBLISH') return 'PUBLISH'
  if (actionType === 'OTHER') return 'OTHER'
  return 'TRANSACTION'
}

/**
 * Builds the canonical action once, using the same EVM normalizer and hash
 * that the executor SDK later verifies. No provider or model can substitute a
 * transaction after the action is prepared.
 */
export async function createTransactionAssuranceAction(input: TransactionAssuranceActionInput): Promise<AssuranceAction> {
  const title = requiredText(input.title, 'Action title')
  if (!Number.isFinite(input.valueAtRiskUsd) || input.valueAtRiskUsd <= 0 || input.valueAtRiskUsd > 1_000_000_000_000) {
    throw new Error('Value at risk must be a positive USD amount no greater than 1000000000000.')
  }

  const transaction = canonicalizeEvmTransaction(input)
  const bound = await createEvmActionBinding(input)
  const intent = input.intent?.trim()
  const from = optionalAddress(input.from, 'EVM sender')

  return {
    id: actionId(input.id),
    kind: actionKind(input.actionType),
    title,
    valueAtRiskUsd: input.valueAtRiskUsd,
    ...(intent ? { intent } : {}),
    binding: bound.actionBinding,
    evm: { ...transaction, ...(from ? { from } : {}) },
    ...(bound.reviewEvidenceContext ? { reviewEvidenceContext: bound.reviewEvidenceContext } : {}),
  }
}

/**
 * Maps product intake into the existing durable job/record model. Claims must
 * already be explicit and attributable; later claim compilers may populate
 * them, but this adapter never invents evidence or a conclusion.
 */
export function toDecisionPackage(
  action: AssuranceAction,
  claims: DecisionClaim[],
  reviewProfile: ReviewProfile = 'GENERAL',
): DecisionPackage {
  if (!Array.isArray(claims) || claims.length === 0 || claims.length > 64) {
    throw new Error('An assurance action requires between one and 64 material claims.')
  }
  if (claims.some((claim) => !/^C-[A-Za-z0-9_-]{1,120}$/.test(claim.id)
    || !claim.statement?.trim()
    || !Number.isFinite(claim.materiality)
    || claim.materiality < 0
    || claim.materiality > 1)) {
    throw new Error('Each assurance claim requires an ID, statement, and materiality from zero through one.')
  }
  if (new Set(claims.map((claim) => claim.id)).size !== claims.length) {
    throw new Error('Assurance claim IDs must be unique.')
  }

  return {
    id: `DP-${action.id.replace(/^AA-/, '')}`,
    title: action.title,
    valueAtRiskUsd: action.valueAtRiskUsd,
    claims,
    actionBinding: action.binding,
    ...(action.reviewEvidenceContext ? { reviewEvidenceContext: action.reviewEvidenceContext } : {}),
    reviewProfile,
  }
}
