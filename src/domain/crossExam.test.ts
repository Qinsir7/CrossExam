import { describe, expect, it } from 'vitest'
import { runCrossExam } from './crossExam'
import type { DecisionPackage, Finding, Reviewer } from './types'

const decision: DecisionPackage = {
  id: 'DP-test',
  title: 'Test decision',
  valueAtRiskUsd: 1000,
  claims: [{ id: 'C-01', statement: 'The critical premise is true.', materiality: 0.9 }],
}

const independentReviewers: Reviewer[] = [
  { id: 'a', name: 'A', ownerId: 'owner-a', modelFamily: 'model-a', evidenceRoute: 'route-a' },
  { id: 'b', name: 'B', ownerId: 'owner-b', modelFamily: 'model-b', evidenceRoute: 'route-b' },
  { id: 'c', name: 'C', ownerId: 'owner-c', modelFamily: 'model-c', evidenceRoute: 'route-c' },
]

describe('runCrossExam', () => {
  it('treats one high-confidence material contradiction as stronger than supporting votes', () => {
    const findings: Finding[] = [
      { claimId: 'C-01', reviewerId: 'a', verdict: 'SUPPORTS', confidence: 0.95, materiality: 0.9, evidence: 'Support one' },
      { claimId: 'C-01', reviewerId: 'b', verdict: 'SUPPORTS', confidence: 0.91, materiality: 0.9, evidence: 'Support two' },
      { claimId: 'C-01', reviewerId: 'c', verdict: 'CONTRADICTS', confidence: 0.88, materiality: 0.93, evidence: 'Material contradiction' },
    ]

    const result = runCrossExam(decision, independentReviewers, findings)

    expect(result.claims[0].verdict).toBe('REFUTED')
    expect(result.action).toBe('HOLD')
  })

  it('does not turn duplicate reviewers into false independence', () => {
    const duplicatedReviewers: Reviewer[] = independentReviewers.map((reviewer, index) => ({
      ...reviewer,
      id: `duplicate-${index}`,
      ownerId: 'same-owner',
      modelFamily: 'same-model',
      evidenceRoute: 'same-route',
    }))
    const findings: Finding[] = [
      { claimId: 'C-01', reviewerId: 'duplicate-0', verdict: 'SUPPORTS', confidence: 0.92, materiality: 0.9, evidence: 'Evidence' },
    ]

    const result = runCrossExam(decision, duplicatedReviewers, findings)

    expect(result.effectiveIndependence).toBe(0.9)
  })

  it('keeps unresolved material evidence visible and recommends a conditional action', () => {
    const findings: Finding[] = [
      { claimId: 'C-01', reviewerId: 'a', verdict: 'INSUFFICIENT_EVIDENCE', confidence: 0.86, materiality: 0.9, evidence: 'Primary evidence is unavailable' },
    ]

    const result = runCrossExam(decision, [independentReviewers[0]], findings)

    expect(result.claims[0].verdict).toBe('UNRESOLVED')
    expect(result.action).toBe('CONDITIONAL')
  })
})
