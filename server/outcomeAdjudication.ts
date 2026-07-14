import type { ReviewerOutcomeEvent, ExPostAdjudication } from '../src/network/reliability'
import type { DecisionAssuranceRecord } from './assuranceRecord'

export type OutcomeAuthorityKind = 'ONCHAIN_FINALITY' | 'INDEPENDENT_ARBITER'

export type ClaimOutcomeAdjudication = {
  schemaVersion: '0.1'
  recordId: string
  claimId: string
  exPostAdjudication: ExPostAdjudication
  adjudicatedAt: string
  authority: {
    id: string
    kind: OutcomeAuthorityKind
  }
  evidence: {
    locator: string
    observedAt: string
    excerpt: string
  }
}

function validTimestamp(value: string) {
  return !Number.isNaN(new Date(value).getTime())
}

/**
 * Converts a single independently sourced, ex-post claim resolution into
 * reputation inputs for every reviewer who made a finding on that claim.
 *
 * Caller-declared deliveries are intentionally ineligible: a reputation
 * network cannot safely rank identities that have not been bound to their
 * review delivery. The authority signature/registry transport is the next
 * service-layer concern; this contract preserves the precise evidence and
 * authority identity it must bind.
 */
export function deriveReviewerOutcomeEvents(
  record: DecisionAssuranceRecord,
  adjudication: ClaimOutcomeAdjudication,
): ReviewerOutcomeEvent[] {
  if (record.attributionStatus !== 'NETWORK_VERIFIED') {
    throw new Error('Only NETWORK_VERIFIED assurance records may contribute to reviewer reliability.')
  }
  if (record.recordId !== adjudication.recordId) throw new Error('Outcome adjudication must be bound to the supplied assurance record.')
  if (!record.decision.claims.some((claim) => claim.id === adjudication.claimId)) {
    throw new Error('Outcome adjudication references a claim outside this assurance record.')
  }
  if (!adjudication.authority.id.trim() || !adjudication.evidence.locator.trim() || !adjudication.evidence.excerpt.trim()) {
    throw new Error('Outcome adjudication requires an identified authority and traceable evidence.')
  }
  if (!validTimestamp(adjudication.adjudicatedAt) || !validTimestamp(adjudication.evidence.observedAt)) {
    throw new Error('Outcome adjudication requires valid timestamps.')
  }

  const materiality = record.decision.claims.find((claim) => claim.id === adjudication.claimId)!.materiality
  const adjudicatedAt = new Date(adjudication.adjudicatedAt).getTime()
  const events: ReviewerOutcomeEvent[] = []

  for (const assignment of record.dispatch.assignments) {
    const delivery = assignment.delivery
    if (!assignment.reviewer || !delivery) continue
    const deliveredAt = new Date(delivery.deliveredAt).getTime()
    if (!validTimestamp(delivery.deliveredAt) || adjudicatedAt < deliveredAt) {
      throw new Error('Outcome adjudication cannot predate a reviewer delivery.')
    }
    for (const finding of delivery.findings.filter((item) => item.claimId === adjudication.claimId)) {
      events.push({
        reviewerId: assignment.reviewer.id,
        reviewId: `${record.recordId}:${assignment.scopeId}`,
        claimId: adjudication.claimId,
        materiality,
        reviewerVerdict: finding.verdict,
        exPostAdjudication: adjudication.exPostAdjudication,
        evidenceCompleteness: delivery.artifacts.length > 0 && finding.evidence.trim() ? 1 : 0,
        latencySeconds: Math.round((adjudicatedAt - deliveredAt) / 1000),
      })
    }
  }

  if (events.length === 0) throw new Error('No delivered reviewer finding exists for this adjudicated claim.')
  return events
}
