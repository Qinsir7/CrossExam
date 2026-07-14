import { describe, expect, it } from 'vitest'
import { acceptReviewDelivery, stageReviewPlan, type ReviewDelivery, type ReviewerProfile } from '../network/reviewNetwork'
import { createReviewPlan } from './reviewPlan'
import { completeCrossExam } from './reviewCompletion'
import type { DecisionPackage } from './types'

const decision: DecisionPackage = {
  id: 'DP-COMPLETE',
  title: 'Execute the action',
  valueAtRiskUsd: 25_000,
  claims: [{ id: 'C-1', statement: 'A material premise is true.', materiality: 0.9 }],
}

const reviewers: ReviewerProfile[] = [
  { id: 'r-source', displayName: 'Source', ownerId: 'owner-source', modelFamily: 'model-source', evidenceRoutes: ['primary-web'], capabilities: ['source verification'] },
  { id: 'r-challenge', displayName: 'Challenge', ownerId: 'owner-challenge', modelFamily: 'model-challenge', evidenceRoutes: ['research-db'], capabilities: ['adversarial research'] },
  { id: 'r-domain', displayName: 'Domain', ownerId: 'owner-domain', modelFamily: 'model-domain', evidenceRoutes: ['onchain'], capabilities: ['domain specialist'] },
]

function makeDelivery(reviewerId: string, verdict: ReviewDelivery['findings'][number]['verdict']): ReviewDelivery {
  return {
    reviewerId,
    deliveredAt: '2026-07-14T14:00:00.000Z',
    artifacts: [{ id: `E-${reviewerId}`, kind: 'PRIMARY_SOURCE', locator: `https://example.com/${reviewerId}`, observedAt: '2026-07-14T13:59:00.000Z', excerpt: 'Attributable evidence.' }],
    findings: [{ claimId: 'C-1', reviewerId, verdict, confidence: verdict === 'CONTRADICTS' ? 0.9 : 0.8, materiality: 0.9, evidence: 'The reviewer supplied an evidence-backed finding.' }],
  }
}

describe('completeCrossExam', () => {
  it('refuses to issue an action recommendation from partial reviews', () => {
    const plan = createReviewPlan(decision)
    const dispatch = stageReviewPlan(plan, reviewers)

    expect(() => completeCrossExam(decision, dispatch)).toThrow('every independent scope')
  })

  it('aggregates delivered, attributable findings through the contradiction-first engine', () => {
    const plan = createReviewPlan(decision)
    let dispatch = stageReviewPlan(plan, reviewers)
    dispatch = acceptReviewDelivery(plan, dispatch, 'evidence-integrity', makeDelivery('r-source', 'SUPPORTS'))
    dispatch = acceptReviewDelivery(plan, dispatch, 'assumption-challenge', makeDelivery('r-challenge', 'CONTRADICTS'))
    dispatch = acceptReviewDelivery(plan, dispatch, 'domain-risk', makeDelivery('r-domain', 'SUPPORTS'))

    const result = completeCrossExam(decision, dispatch)

    expect(dispatch.status).toBe('DELIVERED')
    expect(result.claims[0].verdict).toBe('REFUTED')
    expect(result.action).toBe('HOLD')
  })
})
