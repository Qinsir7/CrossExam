import { describe, expect, it } from 'vitest'
import { createReviewPlan } from '../domain/reviewPlan'
import { createBlindReviewTask } from './reviewTask'
import type { DecisionPackage } from '../domain/types'

const decision: DecisionPackage = {
  id: 'DP-BLIND', title: 'Sensitive action', valueAtRiskUsd: 1000,
  claims: [{ id: 'C-1', statement: 'A material premise is true.', materiality: 0.8 }],
}

describe('createBlindReviewTask', () => {
  it('gives challengers claims and evidence requirements but no peer verdict context', () => {
    const task = createBlindReviewTask(decision, createReviewPlan(decision), 'assumption-challenge')

    expect(task.claims).toEqual(decision.claims)
    expect(task.withheldContext).toContain('other_reviewer_findings')
    expect(task).not.toHaveProperty('originRecommendation')
    expect(task).not.toHaveProperty('peerFindings')
    expect(task).not.toHaveProperty('aggregateVerdict')
  })
})
