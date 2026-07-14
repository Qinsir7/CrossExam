import { describe, expect, it } from 'vitest'
import { createReviewPlan } from './reviewPlan'
import type { DecisionPackage } from './types'

const decision: DecisionPackage = {
  id: 'DP-900',
  title: 'Approve an action',
  valueAtRiskUsd: 10000,
  claims: [
    { id: 'C-01', statement: 'Claim one', materiality: 0.7 },
    { id: 'C-02', statement: 'Claim two', materiality: 0.8 },
  ],
}

describe('createReviewPlan', () => {
  it('creates three independent evidence scopes that each cover every submitted claim', () => {
    const plan = createReviewPlan(decision)

    expect(plan.scopes).toHaveLength(3)
    expect(plan.scopes.map((scope) => scope.claimIds)).toEqual([
      ['C-01', 'C-02'],
      ['C-01', 'C-02'],
      ['C-01', 'C-02'],
    ])
  })

  it('keeps the initial procurement estimate under one percent of value at risk', () => {
    const plan = createReviewPlan(decision)

    expect(plan.estimatedTotalUsdt).toBeLessThan(decision.valueAtRiskUsd * 0.01)
  })
})
