import type { ActionRecommendation, CrossExamResult } from './types'

export type AssuredDecision = {
  recordId: string
  decisionId: string
  valueAtRiskUsd: number
  attributionStatus: 'DECLARED_BY_CALLER' | 'NETWORK_VERIFIED'
  result: CrossExamResult
}

export type ActionIntent = {
  decisionId: string
  valueAtRiskUsd: number
  actionType: 'SPEND' | 'TRADE' | 'DEPLOY' | 'PUBLISH' | 'OTHER'
}

export type PreActionPolicy = {
  requireNetworkVerificationAtOrAboveUsd: number
}

export type PreActionDecision = {
  status: 'PERMIT' | 'REMEDIATE' | 'REQUIRE_NETWORK_VERIFICATION' | 'DENY'
  executable: boolean
  reasons: string[]
  requiredClaimIds: string[]
}

export const defaultPreActionPolicy: PreActionPolicy = {
  requireNetworkVerificationAtOrAboveUsd: 1_000,
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
): PreActionDecision {
  if (assured.decisionId !== intent.decisionId) {
    return { status: 'DENY', executable: false, reasons: ['The action intent does not match this Decision Assurance Record.'], requiredClaimIds: [] }
  }
  if (intent.valueAtRiskUsd > assured.valueAtRiskUsd) {
    return { status: 'DENY', executable: false, reasons: ['The action exceeds the value at risk reviewed by this Decision Assurance Record.'], requiredClaimIds: [] }
  }
  if (intent.valueAtRiskUsd >= policy.requireNetworkVerificationAtOrAboveUsd && assured.attributionStatus !== 'NETWORK_VERIFIED') {
    return { status: 'REQUIRE_NETWORK_VERIFICATION', executable: false, reasons: ['This action exceeds the policy threshold and needs network-verified reviewer delivery.'], requiredClaimIds: [] }
  }

  const requiredClaimIds = assured.result.reversalConditions.map((condition) => condition.claimId)
  if (assured.result.action === 'PROCEED') {
    return { status: 'PERMIT', executable: true, reasons: [actionReason(assured.result.action)], requiredClaimIds: [] }
  }
  if (assured.result.action === 'BLOCK') {
    return { status: 'DENY', executable: false, reasons: [actionReason(assured.result.action)], requiredClaimIds }
  }
  return {
    status: 'REMEDIATE',
    executable: false,
    reasons: [actionReason(assured.result.action), ...assured.result.reversalConditions.map((condition) => condition.requirement)],
    requiredClaimIds,
  }
}
