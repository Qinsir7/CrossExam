import { completeCrossExam } from '../src/domain/reviewCompletion'
import type { DecisionPackage } from '../src/domain/types'
import type { ReviewDispatch } from '../src/network/reviewNetwork'
import { issueDecisionAssuranceRecord } from './assuranceRecord'
import { assertDispatchEvidenceIntegrity } from './evidenceIntegrity'
import { verifyDeliveryAttestation, type SignedReviewDelivery } from './deliveryAttestation'
import { normalizeNetworkVerifiedDispatch, normalizeReviewJobDispatch, reviewerWalletRegistry, type ReviewerRegistry } from './reviewerRegistry'

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

/**
 * Evidence purchased from a normal A2MCP endpoint is payment-verifiable, but
 * does not become a reviewer signature. This route preserves that distinction
 * in the issued record while still allowing its evidence to trigger a safe
 * HOLD/BLOCK decision.
 */
export async function aggregateProcurementVerifiedAssurance(
  request: AggregateAssuranceRequest,
  registry: ReviewerRegistry,
  issuedAt = new Date().toISOString(),
) {
  const dispatch = normalizeReviewJobDispatch(request.decision, request.dispatch, registry)
  assertDispatchEvidenceIntegrity(dispatch)
  const wallets = reviewerWalletRegistry(registry)
  let hasPaidEvidence = false
  await Promise.all(dispatch.assignments.map(async (assignment) => {
    if (!assignment.delivery || !assignment.reviewer) throw new Error('A procurement-verified result requires every delivered scope.')
    const reviewer = registry[assignment.reviewer.id]
    if (!reviewer) throw new Error('A procurement-verified result references an unknown source.')
    if (reviewer.procurementProtocol === 'PAID_EVIDENCE_V1' || reviewer.procurementProtocol === 'AUTHENTICATED_API_EVIDENCE_V1') {
      const provenance = assignment.delivery.provenance
      const validPayment = provenance?.kind === 'X402_PAID_EVIDENCE_V1' && provenance.payment
        && /^0x[0-9a-f]+$/i.test(provenance.payment.transaction)
      const validAuthentication = provenance?.kind === 'AUTHENTICATED_API_EVIDENCE_V1'
        && provenance.authentication?.scheme === 'OKX_HMAC_SHA256' && provenance.authentication.includedQuota
      if (!provenance || provenance.sourceId !== reviewer.id
        || provenance.endpoint !== reviewer.procurementEndpoint || !/^0x[0-9a-f]{64}$/i.test(provenance.requestHash)
        || !/^0x[0-9a-f]{64}$/i.test(provenance.responseHash) || (!validPayment && !validAuthentication)) {
        throw new Error('Paid evidence delivery has incomplete or mismatched provenance.')
      }
      hasPaidEvidence = true
      return
    }
    await verifyDeliveryAttestation({
      dispatchId: dispatch.id,
      decisionId: request.decision.id,
      scopeId: assignment.scopeId,
      delivery: assignment.delivery as SignedReviewDelivery,
      reviewerWallets: wallets,
    })
  }))
  if (!hasPaidEvidence) throw new Error('Use network verification when every delivery is reviewer-signed.')
  const result = completeCrossExam(request.decision, dispatch)
  return issueDecisionAssuranceRecord(request.decision, dispatch, result, issuedAt, 'PROCUREMENT_VERIFIED')
}
