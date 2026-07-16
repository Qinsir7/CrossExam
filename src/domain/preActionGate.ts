import type { ActionBinding, ActionRecommendation, ActionType, CrossExamResult } from './types'

export type AssuredDecision = {
  recordId: string
  issuedAt: string
  decisionId: string
  valueAtRiskUsd: number
  attributionStatus: 'DECLARED_BY_CALLER' | 'PROCUREMENT_VERIFIED' | 'NETWORK_VERIFIED'
  result: CrossExamResult
  actionBinding?: ActionBinding
}

export type ActionIntent = {
  decisionId: string
  valueAtRiskUsd: number
  actionType: ActionType
  target: string
  parametersHash: string
}

export type PreActionPolicy = {
  requireNetworkVerificationAtOrAboveUsd: number
  requireActionBindingAtOrAboveUsd: number
  /** Maximum age of evidence before a new assurance record is required. */
  maxRecordAgeSeconds: number
  /** Tolerates small issuer/executor clock skew but rejects future-dated records. */
  maxFutureClockSkewSeconds: number
}

export type PreActionDecision = {
  status: 'PERMIT' | 'REMEDIATE' | 'REQUIRE_NETWORK_VERIFICATION' | 'DENY'
  executable: boolean
  reasons: string[]
  requiredClaimIds: string[]
}

export const defaultPreActionPolicy: PreActionPolicy = {
  requireNetworkVerificationAtOrAboveUsd: 1_000,
  requireActionBindingAtOrAboveUsd: 1_000,
  maxRecordAgeSeconds: 900,
  maxFutureClockSkewSeconds: 60,
}

function actionReason(action: ActionRecommendation) {
  if (action === 'BLOCK') return 'CrossExam blocked this action because multiple material claims were refuted.'
  if (action === 'HOLD') return 'CrossExam placed this action on hold until its material contradictions are addressed.'
  if (action === 'CONDITIONAL') return 'CrossExam requires the listed uncertainties to be resolved before execution.'
  return 'CrossExam found no outstanding material contradiction under the current evidence record.'
}

/**
 * Machine-readable enforcement boundary for an agent executor. It never
 * silently upgrades a recorded decision: a larger action, a different
 * decision, or an insufficiently verified high-value review must be gated.
 */
export function evaluatePreAction(
  assured: AssuredDecision,
  intent: ActionIntent,
  policy: PreActionPolicy = defaultPreActionPolicy,
  now = new Date(),
): PreActionDecision {
  if (assured.decisionId !== intent.decisionId) {
    return { status: 'DENY', executable: false, reasons: ['The action intent does not match this Decision Assurance Record.'], requiredClaimIds: [] }
  }
  if (intent.valueAtRiskUsd > assured.valueAtRiskUsd) {
    return { status: 'DENY', executable: false, reasons: ['The action exceeds the value at risk reviewed by this Decision Assurance Record.'], requiredClaimIds: [] }
  }
  const issuedAt = new Date(assured.issuedAt).getTime()
  if (Number.isNaN(issuedAt)) {
    return { status: 'DENY', executable: false, reasons: ['The Decision Assurance Record has an invalid issuance timestamp.'], requiredClaimIds: [] }
  }
  const nowMs = now.getTime()
  if (issuedAt - nowMs > policy.maxFutureClockSkewSeconds * 1_000) {
    return { status: 'DENY', executable: false, reasons: ['The Decision Assurance Record is future-dated beyond the permitted clock skew.'], requiredClaimIds: [] }
  }
  if (nowMs - issuedAt > policy.maxRecordAgeSeconds * 1_000) {
    return { status: 'REMEDIATE', executable: false, reasons: ['The Decision Assurance Record has expired under this execution policy and requires a fresh review.'], requiredClaimIds: [] }
  }
  if (intent.valueAtRiskUsd >= policy.requireActionBindingAtOrAboveUsd && !assured.actionBinding) {
    return { status: 'DENY', executable: false, reasons: ['This action exceeds the policy threshold and has no action binding in its Decision Assurance Record.'], requiredClaimIds: [] }
  }
  if (assured.actionBinding && (
    assured.actionBinding.actionType !== intent.actionType ||
    assured.actionBinding.target !== intent.target ||
    assured.actionBinding.parametersHash !== intent.parametersHash
  )) {
    return { status: 'DENY', executable: false, reasons: ['The action target or parameters do not match the reviewed action binding.'], requiredClaimIds: [] }
  }
  const requiredClaimIds = assured.result.reversalConditions.map((condition) => condition.claimId)
  // Negative evidence is fail-closed at every attribution level. Verification
  // strength can restrict a PROCEED decision, but must never weaken BLOCK/HOLD.
  if (assured.result.action === 'BLOCK') {
    return { status: 'DENY', executable: false, reasons: [actionReason(assured.result.action)], requiredClaimIds }
  }
  if (assured.result.action !== 'PROCEED') {
    return {
      status: 'REMEDIATE',
      executable: false,
      reasons: [actionReason(assured.result.action), ...assured.result.reversalConditions.map((condition) => condition.requirement)],
      requiredClaimIds,
    }
  }
  if (intent.valueAtRiskUsd >= policy.requireNetworkVerificationAtOrAboveUsd && assured.attributionStatus !== 'NETWORK_VERIFIED') {
    return { status: 'REQUIRE_NETWORK_VERIFICATION', executable: false, reasons: ['This action exceeds the policy threshold and needs network-verified reviewer delivery before a positive execution decision.'], requiredClaimIds: [] }
  }
  return { status: 'PERMIT', executable: true, reasons: [actionReason(assured.result.action)], requiredClaimIds: [] }
}
