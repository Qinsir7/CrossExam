import { completeCrossExam } from '../src/domain/reviewCompletion'
import type { DecisionPackage } from '../src/domain/types'
import type { ReviewDispatch } from '../src/network/reviewNetwork'
import { issueDecisionAssuranceRecord } from './assuranceRecord'
import { verifyDeliveryAttestation, type ReviewerWalletRegistry, type SignedReviewDelivery } from './deliveryAttestation'

export type AggregateAssuranceRequest = {
  decision: DecisionPackage
  dispatch: ReviewDispatch
}

/**
 * The paid A2MCP capability: deterministically turn a fully delivered review
 * dispatch into an assurance result. It never manufactures reviewer output.
 */
export function aggregateAssurance(request: AggregateAssuranceRequest, issuedAt = new Date().toISOString()) {
  const result = completeCrossExam(request.decision, request.dispatch)
  return issueDecisionAssuranceRecord(request.decision, request.dispatch, result, issuedAt)
}

/** Only emits NETWORK_VERIFIED after every delivered scope is registry-bound and signed. */
export async function aggregateNetworkVerifiedAssurance(
  request: AggregateAssuranceRequest,
  reviewerWallets: ReviewerWalletRegistry,
  issuedAt = new Date().toISOString(),
) {
  const result = completeCrossExam(request.decision, request.dispatch)
  const assignedWallets = new Set<string>()
  await Promise.all(request.dispatch.assignments.map(async (assignment) => {
    if (!assignment.delivery || !assignment.reviewer) {
      throw new Error('A network-verified result requires a delivered reviewer assignment.')
    }
    const wallet = reviewerWallets[assignment.reviewer.id]
    if (!wallet) throw new Error('A network-verified result requires every reviewer to be in the wallet registry.')
    const normalizedWallet = wallet.toLowerCase()
    if (assignedWallets.has(normalizedWallet)) {
      throw new Error('A network-verified result cannot reuse the same reviewer wallet across scopes.')
    }
    assignedWallets.add(normalizedWallet)
    await verifyDeliveryAttestation({
      dispatchId: request.dispatch.id,
      decisionId: request.decision.id,
      scopeId: assignment.scopeId,
      delivery: assignment.delivery as SignedReviewDelivery,
      reviewerWallets,
    })
  }))
  return issueDecisionAssuranceRecord(request.decision, request.dispatch, result, issuedAt, 'NETWORK_VERIFIED')
}
