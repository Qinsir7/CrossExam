import type { DecisionAssuranceRecord } from './assuranceRecord'

export type PublicAssuranceRecord = {
  recordId: string
  issuedAt: string
  attributionStatus: DecisionAssuranceRecord['attributionStatus']
  verdict: string
  actionTitle: string
  valueReviewedUsd: number
  strongestContradiction?: { claimId: string; summary: string }
  sources: Array<{ name: string; observedAt?: string }>
  serviceAttestation?: { scheme: 'EIP191'; signer: string; payloadHash: string }
}

/** A deliberate allowlist; never expose decision bindings, raw evidence, payments, or bearer capabilities. */
export function publicRecordProjection(record: DecisionAssuranceRecord): PublicAssuranceRecord {
  const refuted = record.result.claims.find((claim) => claim.verdict === 'REFUTED')
  const sources = record.dispatch.assignments.flatMap((assignment) => assignment.reviewer ? [{
    name: assignment.reviewer.displayName,
    ...(assignment.delivery?.deliveredAt ? { observedAt: assignment.delivery.deliveredAt } : {}),
  }] : [])
  return {
    recordId: record.recordId,
    issuedAt: record.issuedAt,
    attributionStatus: record.attributionStatus,
    verdict: record.result.action,
    actionTitle: record.decision.title,
    valueReviewedUsd: record.decision.valueAtRiskUsd,
    ...(refuted ? { strongestContradiction: { claimId: refuted.id, summary: refuted.evidence } } : {}),
    sources,
    ...(record.serviceAttestation ? { serviceAttestation: { scheme: record.serviceAttestation.scheme, signer: record.serviceAttestation.signer, payloadHash: record.serviceAttestation.payloadHash } } : {}),
  }
}
