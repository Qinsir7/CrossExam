import { describe, expect, it } from 'vitest'
import { issueDecisionAssuranceRecord } from './assuranceRecord'
import type { CrossExamResult, DecisionPackage } from '../src/domain/types'
import type { ReviewDispatch } from '../src/network/reviewNetwork'

const decision: DecisionPackage = {
  id: 'DP-RECORD',
  title: 'Record a material decision',
  valueAtRiskUsd: 8_000,
  claims: [{ id: 'C-1', statement: 'A premise is supportable.', materiality: 0.8 }],
}
const dispatch: ReviewDispatch = {
  id: 'RD-RECORD',
  decisionId: 'DP-RECORD',
  status: 'DELIVERED',
  assignments: [{
    scopeId: 'evidence-integrity',
    status: 'DELIVERED',
    reviewer: { id: 'r-1', displayName: 'Reviewer', ownerId: 'owner-1', modelFamily: 'model-1', evidenceRoutes: ['primary'] },
    delivery: {
      reviewerId: 'r-1',
      deliveredAt: '2026-07-14T16:00:00.000Z',
      artifacts: [{ id: 'E-1', kind: 'PRIMARY_SOURCE', locator: 'https://example.com', observedAt: '2026-07-14T15:59:00.000Z', excerpt: 'Evidence.' }],
      findings: [{ claimId: 'C-1', reviewerId: 'r-1', verdict: 'SUPPORTS', confidence: 0.8, materiality: 0.8, evidence: 'Evidence supports the premise.' }],
    },
    reason: 'Delivered.',
  }],
}
const result: CrossExamResult = {
  claims: [{ id: 'C-1', text: 'A premise is supportable.', verdict: 'SURVIVED', evidence: 'Evidence supports the premise.', challenger: 'Reviewer' }],
  action: 'PROCEED',
  effectiveIndependence: 0.9,
  materialRefutations: 0,
  materialUnresolved: 0,
  reversalConditions: [],
}

describe('issueDecisionAssuranceRecord', () => {
  it('produces a stable content-derived identifier for the same reviewed input', () => {
    const first = issueDecisionAssuranceRecord(decision, dispatch, result, '2026-07-14T16:01:00.000Z')
    const second = issueDecisionAssuranceRecord(decision, dispatch, result, '2026-07-14T16:01:00.000Z')

    expect(first.recordId).toBe(second.recordId)
    expect(first.recordId).toMatch(/^dar_[a-f0-9]{24}$/)
  })

  it('changes the identifier when the conclusion changes', () => {
    const first = issueDecisionAssuranceRecord(decision, dispatch, result, '2026-07-14T16:01:00.000Z')
    const changed = issueDecisionAssuranceRecord(decision, dispatch, { ...result, action: 'HOLD' }, '2026-07-14T16:01:00.000Z')

    expect(first.recordId).not.toBe(changed.recordId)
  })

  it('labels caller-supplied reviewer attribution honestly', () => {
    const record = issueDecisionAssuranceRecord(decision, dispatch, result, '2026-07-14T16:01:00.000Z')

    expect(record.attributionStatus).toBe('DECLARED_BY_CALLER')
  })
})
