import { describe, expect, it } from 'vitest'
import { buildReviewerReliabilityProfile, type ReviewerOutcomeEvent } from './reliability'

function event(overrides: Partial<ReviewerOutcomeEvent> = {}): ReviewerOutcomeEvent {
  return {
    reviewerId: 'challenger',
    reviewId: 'R-1',
    claimId: 'C-1',
    materiality: 0.9,
    reviewerVerdict: 'CONTRADICTS',
    exPostAdjudication: 'CONTRADICTED',
    evidenceCompleteness: 1,
    latencySeconds: 120,
    ...overrides,
  }
}

describe('buildReviewerReliabilityProfile', () => {
  it('does not issue a ranking score from a thin history', () => {
    const profile = buildReviewerReliabilityProfile('challenger', [event()])

    expect(profile.status).toBe('PROVISIONAL')
    expect(profile.reliabilityScore).toBeNull()
  })

  it('rewards an independently proven contradiction, not agreement with a majority', () => {
    const challenger = buildReviewerReliabilityProfile('challenger', Array.from({ length: 5 }, (_, index) => event({ reviewId: `R-${index}` })))
    const consensusFollower = buildReviewerReliabilityProfile('follower', Array.from({ length: 5 }, (_, index) => event({
      reviewerId: 'follower', reviewId: `R-${index}`, reviewerVerdict: 'SUPPORTS', exPostAdjudication: 'CONTRADICTED',
    })))

    expect(challenger.reliabilityScore).toBeGreaterThan(0.9)
    expect(consensusFollower.reliabilityScore).toBeLessThan(0.3)
  })

  it('gives an inconclusive outcome credit only when the reviewer exposed uncertainty', () => {
    const honest = buildReviewerReliabilityProfile('honest', Array.from({ length: 5 }, (_, index) => event({
      reviewerId: 'honest', reviewId: `R-${index}`, reviewerVerdict: 'INSUFFICIENT_EVIDENCE', exPostAdjudication: 'INCONCLUSIVE',
    })))
    const overconfident = buildReviewerReliabilityProfile('overconfident', Array.from({ length: 5 }, (_, index) => event({
      reviewerId: 'overconfident', reviewId: `R-${index}`, reviewerVerdict: 'SUPPORTS', exPostAdjudication: 'INCONCLUSIVE',
    })))

    expect(honest.materialAccuracy).toBe(1)
    expect(overconfident.materialAccuracy).toBe(0)
  })

  it('applies a visible penalty for independently adjudicated misconduct', () => {
    const profile = buildReviewerReliabilityProfile('challenger', [
      ...Array.from({ length: 5 }, (_, index) => event({ reviewId: `R-${index}` })),
      event({ reviewId: 'R-misconduct', exPostAdjudication: 'MISCONDUCT' }),
    ])

    expect(profile.misconductEvents).toBe(1)
    expect(profile.reliabilityScore).toBeLessThan(0.8)
  })
})
