import { describe, expect, it } from 'vitest'
import { evaluatePreAction } from './preActionGate'
import type { AssuredDecision } from './preActionGate'

function assured(overrides: Partial<AssuredDecision> = {}): AssuredDecision {
  return {
    recordId: 'dar_1234567890abcdef12345678',
    decisionId: 'DP-1',
    valueAtRiskUsd: 5_000,
    attributionStatus: 'NETWORK_VERIFIED',
    actionBinding: { actionType: 'SPEND', target: 'vendor:demo', parametersHash: '0xspend-demo' },
    result: {
      claims: [], action: 'PROCEED', effectiveIndependence: 2.7, materialRefutations: 0, materialUnresolved: 0, reversalConditions: [],
    },
    ...overrides,
  }
}

describe('evaluatePreAction', () => {
  it('permits only an in-scope, network-verified action that survived review', () => {
    const gate = evaluatePreAction(assured(), { decisionId: 'DP-1', valueAtRiskUsd: 5_000, actionType: 'SPEND', target: 'vendor:demo', parametersHash: '0xspend-demo' })

    expect(gate).toMatchObject({ status: 'PERMIT', executable: true })
  })

  it('does not let an executor reuse a review for a larger action', () => {
    const gate = evaluatePreAction(assured(), { decisionId: 'DP-1', valueAtRiskUsd: 5_001, actionType: 'TRADE', target: 'vendor:demo', parametersHash: '0xspend-demo' })

    expect(gate.status).toBe('DENY')
  })

  it('requires remediation for a held decision and names the blocking claims', () => {
    const gate = evaluatePreAction(assured({ result: {
      claims: [], action: 'HOLD', effectiveIndependence: 2.7, materialRefutations: 1, materialUnresolved: 0,
      reversalConditions: [{ claimId: 'C-1', kind: 'OVERTURN_CONTRADICTION', requirement: 'Provide independent overturning evidence.', basedOnEvidence: 'Contradiction.' }],
    } }), { decisionId: 'DP-1', valueAtRiskUsd: 1_000, actionType: 'SPEND', target: 'vendor:demo', parametersHash: '0xspend-demo' })

    expect(gate).toMatchObject({ status: 'REMEDIATE', executable: false, requiredClaimIds: ['C-1'] })
  })

  it('requires network verification at high risk before permitting an otherwise positive record', () => {
    const gate = evaluatePreAction(assured({ attributionStatus: 'DECLARED_BY_CALLER' }), { decisionId: 'DP-1', valueAtRiskUsd: 1_000, actionType: 'SPEND', target: 'vendor:demo', parametersHash: '0xspend-demo' })

    expect(gate.status).toBe('REQUIRE_NETWORK_VERIFICATION')
  })

  it('denies a substituted target even when the amount and decision ID match', () => {
    const gate = evaluatePreAction(assured(), { decisionId: 'DP-1', valueAtRiskUsd: 5_000, actionType: 'SPEND', target: 'attacker:wallet', parametersHash: '0xspend-demo' })

    expect(gate.status).toBe('DENY')
  })
})
