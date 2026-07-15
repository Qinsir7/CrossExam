import { describe, expect, it } from 'vitest'
import { deriveReviewerOutcomeEvents, type ClaimOutcomeAdjudication } from './outcomeAdjudication'
import { issueDecisionAssuranceRecord } from './assuranceRecord'
import { createReviewPlan } from '../src/domain/reviewPlan'
import { acceptReviewDelivery, stageReviewPlan, type ReviewerProfile } from '../src/network/reviewNetwork'
import { runCrossExam } from '../src/domain/crossExam'
import type { DecisionPackage } from '../src/domain/types'

const decision: DecisionPackage = {
  id: 'DP-OUTCOME', title: 'Outcome integrity', valueAtRiskUsd: 1000,
  claims: [{ id: 'C-1', statement: 'A material control is active.', materiality: 0.9 }],
}
const reviewers: ReviewerProfile[] = [
  { id: 'challenger', displayName: 'Challenger', ownerId: 'owner-a', modelFamily: 'model-a', evidenceRoutes: ['primary'], capabilities: ['source verification', 'adversarial research', 'domain specialist'] },
  { id: 'independent', displayName: 'Independent', ownerId: 'owner-b', modelFamily: 'model-b', evidenceRoutes: ['onchain'], capabilities: ['source verification', 'adversarial research', 'domain specialist'] },
  { id: 'specialist', displayName: 'Specialist', ownerId: 'owner-c', modelFamily: 'model-c', evidenceRoutes: ['audit'], capabilities: ['source verification', 'adversarial research', 'domain specialist'] },
]

function record(attributionStatus: 'DECLARED_BY_CALLER' | 'NETWORK_VERIFIED' = 'NETWORK_VERIFIED') {
  const plan = createReviewPlan(decision)
  let dispatch = stageReviewPlan(plan, reviewers)
  for (const assignment of dispatch.assignments) {
    const reviewerId = assignment.reviewer!.id
    dispatch = acceptReviewDelivery(plan, dispatch, assignment.scopeId, {
      reviewerId,
      deliveredAt: '2026-07-15T00:00:00.000Z',
      artifacts: [{ id: `E-${reviewerId}`, kind: 'PRIMARY_SOURCE', locator: `https://example.com/${reviewerId}`, observedAt: '2026-07-15T00:00:00.000Z', excerpt: 'Traceable evidence.', contentHash: '0x01' }],
      findings: [{ claimId: 'C-1', reviewerId, verdict: reviewerId === 'challenger' ? 'CONTRADICTS' : 'SUPPORTS', confidence: 0.9, materiality: 0.9, evidence: 'A reviewed finding.', evidenceArtifactIds: [`E-${reviewerId}`] }],
    })
  }
  const result = runCrossExam(decision, reviewers.map((reviewer) => ({ id: reviewer.id, name: reviewer.displayName, ownerId: reviewer.ownerId, modelFamily: reviewer.modelFamily, evidenceRoute: reviewer.evidenceRoutes[0] })), dispatch.assignments.flatMap((assignment) => assignment.delivery!.findings))
  return issueDecisionAssuranceRecord(decision, dispatch, result, '2026-07-15T00:01:00.000Z', attributionStatus)
}

function adjudication(recordId: string): ClaimOutcomeAdjudication {
  return {
    schemaVersion: '0.1', recordId, claimId: 'C-1', exPostAdjudication: 'CONTRADICTED', adjudicatedAt: '2026-07-15T00:10:00.000Z',
    authority: { id: 'xlayer-finality', kind: 'ONCHAIN_FINALITY' },
    evidence: { locator: 'xlayer://tx/0xoutcome', observedAt: '2026-07-15T00:10:00.000Z', excerpt: 'Finalized execution outcome.' },
  }
}

describe('deriveReviewerOutcomeEvents', () => {
  it('creates truth-labeled reviewer events from a network-verified record', () => {
    const assurance = record()
    const events = deriveReviewerOutcomeEvents(assurance, adjudication(assurance.recordId))

    expect(events).toHaveLength(3)
    expect(events.find((event) => event.reviewerId === 'challenger')).toMatchObject({ reviewerVerdict: 'CONTRADICTS', exPostAdjudication: 'CONTRADICTED', evidenceCompleteness: 1 })
  })

  it('never turns caller-declared reviewer output into reputation data', () => {
    const assurance = record('DECLARED_BY_CALLER')

    expect(() => deriveReviewerOutcomeEvents(assurance, adjudication(assurance.recordId))).toThrow('NETWORK_VERIFIED')
  })
})
