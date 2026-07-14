import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { acceptReviewDelivery, stageReviewPlan, type ReviewDelivery, type ReviewerProfile } from '../src/network/reviewNetwork'
import { createReviewPlan } from '../src/domain/reviewPlan'
import type { DecisionPackage } from '../src/domain/types'
import { aggregateAssurance, aggregateNetworkVerifiedAssurance } from './assuranceService'
import { deliveryPayloadHash } from './deliveryAttestation'

const decision: DecisionPackage = {
  id: 'DP-ASP',
  title: 'Aggregate an independently delivered review',
  valueAtRiskUsd: 12_000,
  claims: [{ id: 'C-1', statement: 'A decision-critical premise holds.', materiality: 0.9 }],
}
const reviewers: ReviewerProfile[] = [
  { id: 'r-1', displayName: 'Source', ownerId: 'owner-1', modelFamily: 'model-1', evidenceRoutes: ['primary'], capabilities: ['source verification'] },
  { id: 'r-2', displayName: 'Challenge', ownerId: 'owner-2', modelFamily: 'model-2', evidenceRoutes: ['counterexample'], capabilities: ['adversarial research'] },
  { id: 'r-3', displayName: 'Domain', ownerId: 'owner-3', modelFamily: 'model-3', evidenceRoutes: ['domain'], capabilities: ['domain specialist'] },
]

function delivery(reviewerId: string, verdict: ReviewDelivery['findings'][number]['verdict']): ReviewDelivery {
  return {
    reviewerId,
    deliveredAt: '2026-07-14T15:00:00.000Z',
    artifacts: [{ id: `e-${reviewerId}`, kind: 'PRIMARY_SOURCE', locator: `https://example.com/${reviewerId}`, observedAt: '2026-07-14T14:59:00.000Z', excerpt: 'Traceable review material.' }],
    findings: [{ claimId: 'C-1', reviewerId, verdict, confidence: 0.9, materiality: 0.9, evidence: 'This is attributable evidence.' }],
  }
}

describe('aggregateAssurance', () => {
  it('returns an assurance result only from a fully delivered dispatch', () => {
    const plan = createReviewPlan(decision)
    let dispatch = stageReviewPlan(plan, reviewers)
    dispatch = acceptReviewDelivery(plan, dispatch, 'evidence-integrity', delivery('r-1', 'SUPPORTS'))
    dispatch = acceptReviewDelivery(plan, dispatch, 'assumption-challenge', delivery('r-2', 'CONTRADICTS'))
    dispatch = acceptReviewDelivery(plan, dispatch, 'domain-risk', delivery('r-3', 'SUPPORTS'))

    const response = aggregateAssurance({ decision, dispatch }, '2026-07-14T16:02:00.000Z')

    expect(response.recordId).toMatch(/^dar_/)
    expect(response.result.action).toBe('HOLD')
  })
})

describe('aggregateNetworkVerifiedAssurance', () => {
  const accounts = [
    privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123'),
    privateKeyToAccount('0x1123456789012345678901234567890123456789012345678901234567890123'),
    privateKeyToAccount('0x2123456789012345678901234567890123456789012345678901234567890123'),
  ]

  async function signedDispatch() {
    const plan = createReviewPlan(decision)
    let dispatch = stageReviewPlan(plan, reviewers)
    dispatch = acceptReviewDelivery(plan, dispatch, 'evidence-integrity', delivery('r-1', 'SUPPORTS'))
    dispatch = acceptReviewDelivery(plan, dispatch, 'assumption-challenge', delivery('r-2', 'CONTRADICTS'))
    dispatch = acceptReviewDelivery(plan, dispatch, 'domain-risk', delivery('r-3', 'SUPPORTS'))

    const assignments = await Promise.all(dispatch.assignments.map(async (assignment, index) => {
      const review = assignment.delivery!
      const payloadHash = deliveryPayloadHash({ dispatchId: dispatch.id, decisionId: decision.id, scopeId: assignment.scopeId, delivery: review })
      const signature = await accounts[index].signMessage({ message: { raw: payloadHash } })
      return { ...assignment, delivery: { ...review, attestation: { scheme: 'EIP191' as const, payloadHash, signature } } }
    }))

    return { ...dispatch, assignments }
  }

  it('issues NETWORK_VERIFIED only after every registry-bound reviewer signs its own delivery', async () => {
    const dispatch = await signedDispatch()
    const result = await aggregateNetworkVerifiedAssurance(
      { decision, dispatch },
      { 'r-1': accounts[0].address, 'r-2': accounts[1].address, 'r-3': accounts[2].address },
      '2026-07-14T16:03:00.000Z',
    )

    expect(result.attributionStatus).toBe('NETWORK_VERIFIED')
    expect(result.result.action).toBe('HOLD')
  })
})
