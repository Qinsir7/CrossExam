import { describe, expect, it } from 'vitest'
import { evaluateDecisionResult, summarizeBenchmark } from './benchmark'
import type { CrossExamResult } from '../domain/types'

const truth = {
  id: 'truth-1',
  claims: [
    { id: 'C-1', expectedVerdict: 'REFUTED' as const, materiality: 0.9 },
    { id: 'C-2', expectedVerdict: 'SURVIVED' as const, materiality: 0.8 },
  ],
}

function result(overrides: Partial<CrossExamResult> = {}): CrossExamResult {
  return {
    claims: [
      { id: 'C-1', text: 'Risk premise', verdict: 'REFUTED', evidence: 'Contradiction', challenger: 'Reviewer' },
      { id: 'C-2', text: 'Positive premise', verdict: 'SURVIVED', evidence: 'Support', challenger: 'Reviewer' },
    ],
    action: 'HOLD', effectiveIndependence: 2.7, materialRefutations: 1, materialUnresolved: 0,
    reversalConditions: [{ claimId: 'C-1', kind: 'OVERTURN_CONTRADICTION', requirement: 'Overturn it.', basedOnEvidence: 'Contradiction' }],
    ...overrides,
  }
}

describe('evaluation benchmark', () => {
  it('credits a detected material contradiction and its remediation path', () => {
    const evaluation = evaluateDecisionResult(truth, result())

    expect(evaluation).toMatchObject({ materialContradictionsExpected: 1, materialContradictionsDetected: 1, unsafeAction: false, reversalCoverage: 1 })
  })

  it('flags a system that permits an action despite a known material contradiction', () => {
    const missed = result({
      claims: [{ id: 'C-1', text: 'Risk premise', verdict: 'SURVIVED', evidence: 'Missed', challenger: 'Reviewer' }, { id: 'C-2', text: 'Positive premise', verdict: 'SURVIVED', evidence: 'Support', challenger: 'Reviewer' }],
      action: 'PROCEED', materialRefutations: 0, reversalConditions: [],
    })
    const evaluation = evaluateDecisionResult(truth, missed)

    expect(evaluation).toMatchObject({ materialContradictionsDetected: 0, unsafeAction: true, reversalCoverage: 0 })
  })

  it('summarizes safety and coverage across decisions', () => {
    const safe = evaluateDecisionResult(truth, result())
    const unsafe = evaluateDecisionResult(truth, result({ action: 'PROCEED', claims: [{ id: 'C-1', text: 'Risk premise', verdict: 'SURVIVED', evidence: 'Missed', challenger: 'Reviewer' }, { id: 'C-2', text: 'Positive premise', verdict: 'SURVIVED', evidence: 'Support', challenger: 'Reviewer' }], materialRefutations: 0, reversalConditions: [] }))

    expect(summarizeBenchmark([safe, unsafe])).toMatchObject({ decisions: 2, materialContradictionRecall: 0.5, unsafeActionRate: 0.5, reversalCoverage: 0.5 })
  })
})
