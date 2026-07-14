import { describe, expect, it } from 'vitest'
import { createReviewPlan } from '../domain/reviewPlan'
import type { DecisionPackage } from '../domain/types'
import { acceptReviewDelivery, stageReviewPlan, type ReviewDelivery, type ReviewerProfile } from './reviewNetwork'

const decision: DecisionPackage = {
  id: 'DP-TEST',
  title: 'Approve a high-impact action',
  valueAtRiskUsd: 10_000,
  claims: [{ id: 'C-1', statement: 'A material condition is true.', materiality: 0.9 }],
}

const registry: ReviewerProfile[] = [
  { id: 'r-1', displayName: 'Source Examiner', ownerId: 'owner-a', modelFamily: 'model-a', evidenceRoutes: ['primary-web'], capabilities: ['source verification'] },
  { id: 'r-2', displayName: 'Counterexample Lab', ownerId: 'owner-b', modelFamily: 'model-b', evidenceRoutes: ['research-db'], capabilities: ['adversarial research'] },
  { id: 'r-3', displayName: 'Domain Risk Lab', ownerId: 'owner-c', modelFamily: 'model-c', evidenceRoutes: ['onchain'], capabilities: ['domain specialist'] },
]

describe('stageReviewPlan', () => {
  it('matches scopes to distinct reviewer owners when the registry permits it', () => {
    const dispatch = stageReviewPlan(createReviewPlan(decision), registry)

    expect(dispatch.status).toBe('MATCHED')
    expect(dispatch.assignments.map((assignment) => assignment.reviewer?.ownerId)).toEqual(['owner-a', 'owner-b', 'owner-c'])
  })

  it('does not reuse a reviewer owner just to fill all review scopes', () => {
    const oneOwner: ReviewerProfile[] = registry.map((reviewer, index) => ({ ...reviewer, ownerId: 'single-owner', id: `single-${index}` }))
    const dispatch = stageReviewPlan(createReviewPlan(decision), oneOwner)

    expect(dispatch.status).toBe('PARTIALLY_MATCHED')
    expect(dispatch.assignments.filter((assignment) => assignment.status === 'MATCHED')).toHaveLength(1)
    expect(dispatch.assignments.filter((assignment) => assignment.status === 'AWAITING_MATCH')).toHaveLength(2)
  })

  it('stages rather than inventing a reviewer or finding when no registry is available', () => {
    const dispatch = stageReviewPlan(createReviewPlan(decision), [])

    expect(dispatch.status).toBe('STAGED')
    expect(dispatch.assignments.every((assignment) => assignment.status === 'AWAITING_MATCH')).toBe(true)
    expect(dispatch.assignments.some((assignment) => 'finding' in assignment)).toBe(false)
  })
})

describe('acceptReviewDelivery', () => {
  const plan = createReviewPlan(decision)
  const dispatch = stageReviewPlan(plan, registry)

  function delivery(overrides: Partial<ReviewDelivery> = {}): ReviewDelivery {
    return {
      reviewerId: 'r-1',
      deliveredAt: '2026-07-14T14:00:00.000Z',
      artifacts: [{ id: 'E-1', kind: 'PRIMARY_SOURCE', locator: 'https://example.com/source', observedAt: '2026-07-14T13:59:00.000Z', excerpt: 'A traceable source excerpt.' }],
      findings: [{ claimId: 'C-1', reviewerId: 'r-1', verdict: 'SUPPORTS', confidence: 0.8, materiality: 0.9, evidence: 'The source directly supports this claim.' }],
      ...overrides,
    }
  }

  it('accepts only an attributable, complete, evidenced delivery', () => {
    const accepted = acceptReviewDelivery(plan, dispatch, 'evidence-integrity', delivery())

    expect(accepted.assignments[0].status).toBe('DELIVERED')
    expect(accepted.assignments[0].delivery?.findings).toHaveLength(1)
  })

  it('rejects a delivery from an unassigned reviewer', () => {
    expect(() => acceptReviewDelivery(plan, dispatch, 'evidence-integrity', delivery({ reviewerId: 'r-2' }))).toThrow('assigned')
  })

  it('rejects a delivery that omits evidence artifacts', () => {
    expect(() => acceptReviewDelivery(plan, dispatch, 'evidence-integrity', delivery({ artifacts: [] }))).toThrow('traceable')
  })
})
