import type { Finding } from '../domain/types'

export type ExPostAdjudication = 'SUPPORTED' | 'CONTRADICTED' | 'INCONCLUSIVE' | 'MISCONDUCT'

export type ReviewerOutcomeEvent = {
  reviewerId: string
  reviewId: string
  claimId: string
  materiality: number
  reviewerVerdict: Finding['verdict']
  exPostAdjudication: ExPostAdjudication
  evidenceCompleteness: number
  latencySeconds: number
}

export type ReviewerReliabilityProfile = {
  reviewerId: string
  status: 'PROVISIONAL' | 'ESTABLISHED'
  completedClaims: number
  independentlyResolvedClaims: number
  materialAccuracy: number | null
  evidenceCompleteness: number
  timeliness: number
  misconductEvents: number
  reliabilityScore: number | null
}

const MIN_RESOLVED_CLAIMS = 5
const TARGET_LATENCY_SECONDS = 600

function bounded(value: number) {
  return Math.max(0, Math.min(1, value))
}

function matchesOutcome(event: ReviewerOutcomeEvent) {
  if (event.exPostAdjudication === 'INCONCLUSIVE') return event.reviewerVerdict === 'INSUFFICIENT_EVIDENCE'
  if (event.exPostAdjudication === 'SUPPORTED') return event.reviewerVerdict === 'SUPPORTS'
  if (event.exPostAdjudication === 'CONTRADICTED') return event.reviewerVerdict === 'CONTRADICTS'
  return false
}

/**
 * Builds a reputation signal only from independently adjudicated outcomes.
 * Agreement with other reviewers is deliberately absent: a lonely, evidence-
 * backed contradiction that proves correct is more valuable than consensus.
 */
export function buildReviewerReliabilityProfile(
  reviewerId: string,
  events: ReviewerOutcomeEvent[],
): ReviewerReliabilityProfile {
  const ownEvents = events.filter((event) => event.reviewerId === reviewerId)
  const resolved = ownEvents.filter((event) => event.exPostAdjudication !== 'MISCONDUCT')
  const misconductEvents = ownEvents.filter((event) => event.exPostAdjudication === 'MISCONDUCT').length
  const materialWeight = resolved.reduce((sum, event) => sum + bounded(event.materiality), 0)
  const correctWeight = resolved.reduce((sum, event) => sum + (matchesOutcome(event) ? bounded(event.materiality) : 0), 0)
  const materialAccuracy = resolved.length === 0 || materialWeight === 0 ? null : Number((correctWeight / materialWeight).toFixed(3))
  const evidenceCompleteness = ownEvents.length === 0
    ? 0
    : Number((ownEvents.reduce((sum, event) => sum + bounded(event.evidenceCompleteness), 0) / ownEvents.length).toFixed(3))
  const timeliness = ownEvents.length === 0
    ? 0
    : Number((ownEvents.reduce((sum, event) => sum + bounded(1 - event.latencySeconds / TARGET_LATENCY_SECONDS), 0) / ownEvents.length).toFixed(3))
  const status = resolved.length >= MIN_RESOLVED_CLAIMS ? 'ESTABLISHED' : 'PROVISIONAL'

  // No ranking number is emitted for small samples. Once established, evidence
  // and timeliness refine the signal but cannot outweigh being wrong on
  // material claims. Misconduct applies a visible, bounded penalty.
  const reliabilityScore = status === 'PROVISIONAL' || materialAccuracy === null
    ? null
    : Number(bounded(materialAccuracy * 0.75 + evidenceCompleteness * 0.15 + timeliness * 0.1 - misconductEvents * 0.2).toFixed(3))

  return {
    reviewerId,
    status,
    completedClaims: ownEvents.length,
    independentlyResolvedClaims: resolved.length,
    materialAccuracy,
    evidenceCompleteness,
    timeliness,
    misconductEvents,
    reliabilityScore,
  }
}
