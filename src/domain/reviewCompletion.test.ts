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
    artifacts: [{ id: `E-${reviewerId}`, kind: 'PRIMARY_SOURCE', locator: `https://example.com/${reviewerId}`, observedAt: '2026-07-14T13:59:00.000Z', excerpt: 'Attributable evidence.', contentHash: '0x01' }],
    findings: [{ claimId: 'C-1', reviewerId, verdict, confidence: verdict === 'CONTRADICTS' ? 0.9 : 0.8, materiality: 0.9, evidence: 'The reviewer supplied an evidence-backed finding.', evidenceArtifactIds: [`E-${reviewerId}`] }],
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

  it('keeps a canonical pre-trade action binding as a first-party deterministic fact and scopes each external source to its own claim', () => {
    const pretrade: DecisionPackage = {
      id: 'DP-PRETRADE',
      title: 'Review an X Layer trade',
      valueAtRiskUsd: 5_000,
      reviewProfile: 'PRETRADE_ONCHAIN',
      actionBinding: { actionType: 'TRADE', target: 'evm:196:0x1111111111111111111111111111111111111111', parametersHash: `0x${'1'.repeat(64)}` },
      claims: [
        { id: 'C-ACTION-BINDING', statement: 'The reviewed action is unchanged.', materiality: 1 },
        { id: 'C-EXECUTION-LIQUIDITY', statement: 'Liquidity is sufficient.', materiality: 1 },
        { id: 'C-TOKEN-TRANSFER-SAFETY', statement: 'The token is transferable.', materiality: 1 },
      ],
    }
    const pretradeReviewers: ReviewerProfile[] = [
      { id: 'liquidity', displayName: 'Liquidity source', ownerId: 'liquidity-owner', modelFamily: 'market-data', evidenceRoutes: ['liquidity'], capabilities: ['execution liquidity'] },
      { id: 'risk', displayName: 'Token-risk source', ownerId: 'risk-owner', modelFamily: 'security', evidenceRoutes: ['token-risk'], capabilities: ['contract token risk'] },
    ]
    const plan = createReviewPlan(pretrade)
    let dispatch = stageReviewPlan(plan, pretradeReviewers)
    const liquidityArtifact = { id: 'E-liquidity', kind: 'TOOL_OUTPUT' as const, locator: 'https://example.com/liquidity', observedAt: '2026-07-18T00:00:00.000Z', excerpt: 'Pool evidence.', contentHash: '0x01' as const }
    const riskArtifact = { id: 'E-risk', kind: 'TOOL_OUTPUT' as const, locator: 'https://example.com/risk', observedAt: '2026-07-18T00:00:00.000Z', excerpt: 'Risk evidence.', contentHash: '0x02' as const }
    dispatch = acceptReviewDelivery(plan, dispatch, 'execution-liquidity', {
      reviewerId: 'liquidity', deliveredAt: '2026-07-18T00:00:00.000Z', artifacts: [liquidityArtifact],
      findings: [{ claimId: 'C-EXECUTION-LIQUIDITY', reviewerId: 'liquidity', verdict: 'INSUFFICIENT_EVIDENCE', confidence: 1, materiality: 1, evidence: 'Pool depth is incomplete.', evidenceArtifactIds: [liquidityArtifact.id] }],
    })
    dispatch = acceptReviewDelivery(plan, dispatch, 'contract-token-risk', {
      reviewerId: 'risk', deliveredAt: '2026-07-18T00:00:00.000Z', artifacts: [riskArtifact],
      findings: [{ claimId: 'C-TOKEN-TRANSFER-SAFETY', reviewerId: 'risk', verdict: 'CONTRADICTS', confidence: 0.95, materiality: 1, evidence: 'The token cannot be sold.', evidenceArtifactIds: [riskArtifact.id] }],
    })

    const result = completeCrossExam(pretrade, dispatch)

    expect(result.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'C-ACTION-BINDING', verdict: 'SURVIVED', challenger: 'CrossExam canonical action binding' }),
      expect.objectContaining({ id: 'C-EXECUTION-LIQUIDITY', verdict: 'UNRESOLVED', challenger: 'Liquidity source' }),
      expect.objectContaining({ id: 'C-TOKEN-TRANSFER-SAFETY', verdict: 'REFUTED', challenger: 'Token-risk source' }),
    ]))
    expect(result.action).toBe('HOLD')
    expect(result.effectiveIndependence).toBe(1.8)
  })
})
