import { describe, expect, it } from 'vitest'
import { issueDecisionAssuranceRecord } from './assuranceRecord'
import { publicRecordProjection } from './publicRecord'

describe('publicRecordProjection', () => {
  it('allows only the deliberate share fields and omits private action binding and evidence payloads', () => {
    const record = issueDecisionAssuranceRecord({
      id: 'DP-SHARE', title: 'Review a token purchase', valueAtRiskUsd: 5000,
      actionBinding: { actionType: 'TRADE', target: 'evm:196:0x1111111111111111111111111111111111111111', parametersHash: '0xprivate' },
      claims: [{ id: 'C-1', statement: 'The purchase is safe.', materiality: 1 }],
    }, {
      id: 'RD-SHARE', decisionId: 'DP-SHARE', status: 'DELIVERED', assignments: [],
    }, {
      action: 'BLOCK', effectiveIndependence: 1, materialRefutations: 1, materialUnresolved: 0,
      claims: [{ id: 'C-1', text: 'The purchase is safe.', verdict: 'REFUTED', evidence: 'A material control contradicts transfer safety.', challenger: 'source' }],
      reversalConditions: [],
    }, '2026-07-18T00:00:00.000Z')

    const shared = publicRecordProjection(record)
    expect(shared).toMatchObject({ actionTitle: 'Review a token purchase', verdict: 'BLOCK', strongestContradiction: { claimId: 'C-1' } })
    expect(JSON.stringify(shared)).not.toContain('0xprivate')
    expect(JSON.stringify(shared)).not.toContain('0x1111111111111111111111111111111111111111')
  })
})
