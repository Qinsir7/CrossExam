import type { AssuranceAction, AssuranceVerdict } from './assuranceAction'
import type { CompiledTransactionClaim } from './transactionClaims'
import type { TransactionClaimEvidence } from './transactionEvidence'

export type TransactionPreflightAttribution = 'DECLARED_BY_CALLER' | 'PROCUREMENT_VERIFIED' | 'NETWORK_VERIFIED'

export type TransactionPreflightPolicy = {
  requireNetworkVerificationAtOrAboveUsd: number
}

export const defaultTransactionPreflightPolicy: TransactionPreflightPolicy = {
  requireNetworkVerificationAtOrAboveUsd: 1_000,
}

/**
 * Product-level transaction policy is stricter than the legacy aggregate
 * recommendation: one material contradiction blocks the action. Missing,
 * stale, or insufficiently attributable evidence never upgrades to PERMIT.
 */
export function evaluateTransactionPreflight(
  action: AssuranceAction,
  claims: CompiledTransactionClaim[],
  evidence: TransactionClaimEvidence[],
  attributionStatus: TransactionPreflightAttribution,
  policy: TransactionPreflightPolicy = defaultTransactionPreflightPolicy,
): AssuranceVerdict {
  const byClaim = new Map(evidence.map((item) => [item.claimId, item]))
  const contradictory = claims
    .map((claim) => ({ claim, evidence: byClaim.get(claim.id) }))
    .filter((item) => item.evidence?.verdict === 'CONTRADICTS')

  if (contradictory.length) {
    const strongest = [...contradictory].sort((left, right) => (right.evidence!.confidence * right.claim.materiality) - (left.evidence!.confidence * left.claim.materiality))[0]
    return {
      verdict: 'BLOCK',
      canExecute: false,
      reasons: contradictory.map((item) => item.evidence!.explanation),
      strongestContradiction: {
        claimId: strongest.claim.id,
        summary: strongest.evidence!.explanation,
        evidenceObservationIds: strongest.evidence!.evidenceObservationIds,
      },
      reversalConditions: contradictory.map((item) => ({
        claimId: item.claim.id,
        requirement: `Provide fresh, independently attributable evidence that overturns: ${item.evidence!.explanation}`,
      })),
    }
  }

  const unresolved = claims
    .map((claim) => ({ claim, evidence: byClaim.get(claim.id) }))
    .filter((item) => !item.evidence || item.evidence.verdict !== 'SUPPORTS')
  if (unresolved.length) {
    return {
      verdict: 'HOLD',
      canExecute: false,
      reasons: unresolved.map((item) => item.evidence?.explanation ?? `No evidence result exists for ${item.claim.id}.`),
      reversalConditions: unresolved.map((item) => ({
        claimId: item.claim.id,
        requirement: `Provide the required independent evidence for: ${item.claim.statement}`,
      })),
    }
  }

  if (action.valueAtRiskUsd >= policy.requireNetworkVerificationAtOrAboveUsd && attributionStatus !== 'NETWORK_VERIFIED') {
    return {
      verdict: 'HOLD',
      canExecute: false,
      reasons: ['This high-value action requires network-verified evidence before CrossExam can permit execution.'],
      reversalConditions: claims.map((claim) => ({
        claimId: claim.id,
        requirement: 'Obtain network-verified delivery for this material claim.',
      })),
    }
  }

  return {
    verdict: 'PERMIT',
    canExecute: true,
    reasons: ['All material transaction claims survived under the configured evidence and attribution policy.'],
    reversalConditions: [],
  }
}
