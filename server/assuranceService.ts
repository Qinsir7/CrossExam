import { completeCrossExam } from '../src/domain/reviewCompletion'
import type { DecisionPackage } from '../src/domain/types'
import type { ReviewDispatch } from '../src/network/reviewNetwork'
import { issueDecisionAssuranceRecord } from './assuranceRecord'
import { assertDispatchEvidenceIntegrity } from './evidenceIntegrity'
import { verifyDeliveryAttestation, type SignedReviewDelivery } from './deliveryAttestation'
import { normalizeNetworkVerifiedDispatch, reviewerWalletRegistry, type ReviewerRegistry } from './reviewerRegistry'

export type AggregateAssuranceRequest = {
  decision: DecisionPackage
  dispatch: ReviewDispatch
}

/**
 * The paid A2MCP capability: deterministically turn a fully delivered review
 * dispatch into an assurance result. It never manufactures reviewer output.
 */
export function aggregateAssurance(request: AggregateAssuranceRequest, issuedAt = new Date().toISOString()) {
  assertDispatchEvidenceIntegrity(request.dispatch)
  const result = completeCrossExam(request.decision, request.dispatch)
  return issueDecisionAssuranceRecord(request.decision, request.dispatch, result, issuedAt)
}

/** Only emits NETWORK_VERIFIED after every delivered scope is registry-bound and signed. */
export async function aggregateNetworkVerifiedAssurance(
  request: AggregateAssuranceRequest,
  registry: ReviewerRegistry,
  issuedAt = new Date().toISOString(),
) {
  const dispatch = normalizeNetworkVerifiedDispatch(request.decision, request.dispatch, registry)
  assertDispatchEvidenceIntegrity(dispatch)
  const wallets = reviewerWalletRegistry(registry)
  await Promise.all(dispatch.assignments.map(async (assignment) => {
    if (!assignment.delivery || !assignment.reviewer) {
      throw new Error('A network-verified result requires a delivered reviewer assignment.')
    }
    await verifyDeliveryAttestation({
      dispatchId: dispatch.id,
      decisionId: request.decision.id,
      scopeId: assignment.scopeId,
      delivery: assignment.delivery as SignedReviewDelivery,
      reviewerWallets: wallets,
    })
  }))
  const result = completeCrossExam(request.decision, dispatch)
  return issueDecisionAssuranceRecord(request.decision, dispatch, result, issuedAt, 'NETWORK_VERIFIED')
}
