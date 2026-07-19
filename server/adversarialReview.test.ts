import { describe, expect, it } from 'vitest'
import type { AdversarialReviewResult } from '../src/domain/generalReview'
import { preparePaidAdversarialReview } from './adversarialReview'

describe('paid adversarial review record', () => {
  it('persists an honest model-only result and leaves factual claims unresolved', async () => {
    const text = 'We should invest because returns will be 30% within 90 days.'
    const prepared = await preparePaidAdversarialReview({ text, profile: 'MONEY' }, {
      async review(_text, preflight): Promise<AdversarialReviewResult> {
        return {
          verdict: 'UNRESOLVED',
          headline: 'The return premise is not established.',
          strongestAttack: 'There is no source, base rate, or downside case for the predicted return.',
          claims: preflight.claims.map((claim) => ({
            claimId: claim.id,
            verdict: 'UNRESOLVED',
            strongestAttack: 'The number has no demonstrated basis.',
            reasoning: 'The conclusion depends on a future quantitative premise.',
            blindSpot: 'The downside distribution is missing.',
            evidenceNeeded: 'Provide dated primary data and the calculation.',
            verificationStatus: 'REQUIRES_EXTERNAL_SOURCE',
          })),
          blindSpots: ['No downside distribution'],
          nextActions: ['Add dated source data'],
          sources: [],
          provenance: { provider: 'DEEPSEEK', model: 'deepseek-v4-pro', requestHash: `0x${'1'.repeat(64)}`, responseHash: `0x${'2'.repeat(64)}` },
        }
      },
    }, '2026-07-20T00:00:00.000Z')

    expect(prepared.record.attributionStatus).toBe('MODEL_ANALYZED')
    expect(prepared.record.result.action).toBe('CONDITIONAL')
    expect(prepared.record.result.effectiveIndependence).toBe(0)
    expect(prepared.record.adversarialAnalysis?.sources).toEqual([])
    expect(prepared.record.dispatch.assignments[0].reason).toContain('No external factual verification')
  })
})
