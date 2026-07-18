import type { ActionIntent, PreActionDecision, PreActionPolicy } from './preActionGate'
import type { DecisionClaim, DecisionPackage } from './types'
import type { AssuranceAction, AssuranceVerdict, EvidenceObservation, TransactionAssuranceActionInput } from './assuranceAction'

/** Stable contract names for the product-level endpoints introduced after the legacy aggregate API. */
export const assuranceProductEndpoints = {
  verify: '/api/v1/assurance/verify',
  transactionPreflight: '/api/v1/preflight/transaction',
  aspTrustCheck: '/api/v1/preflight/asp',
  prepareCrossExamination: '/api/v1/cross-examinations/prepare',
  crossExaminations: '/api/v1/cross-examinations',
} as const

export type AssuranceRecordReference = {
  recordId: string
  issuedAt: string
  attributionStatus: 'DECLARED_BY_CALLER' | 'PROCUREMENT_VERIFIED' | 'NETWORK_VERIFIED'
  serviceAttestation: {
    scheme: 'EIP191'
    payloadHash: `0x${string}`
    signer: `0x${string}`
    signature: `0x${string}`
  }
  readAccess?: {
    token: string
    expiresAt: string
  }
}

export type EvidencePlanScope = {
  id: string
  title: string
  objective: string
  claimIds: string[]
  sourceIds: string[]
  estimatedCostUsdt: number
}

/** x402-paid transaction route. The canonical action is derived server-side from this exact input. */
export type TransactionPreflightRequest = TransactionAssuranceActionInput & {
  idempotencyKey?: string
  /** Reject false assumptions about executable liquidity when the exact asset is known. */
  tokenRiskTarget?: string
}

export type TransactionPreflightResponse = {
  action: AssuranceAction
  decision: DecisionPackage
  claims: DecisionClaim[]
  evidence: EvidenceObservation[]
  verdict: AssuranceVerdict
  record: AssuranceRecordReference
  economics: {
    customerSettlement?: { asset: `0x${string}`; amountAtomic: string; transaction: `0x${string}` }
    externalEvidenceCostUsdt: number
    costBasis: 'INCLUDED_API_QUOTA' | 'SETTLED_X402' | 'MIXED'
  }
}

export type AspProbeMode = 'PASSIVE' | 'PAID_CALL'

/** x402-paid ASP purchase preflight. PAID_CALL is opt-in and must remain spend-policy constrained. */
export type AspTrustCheckRequest = {
  id?: string
  title?: string
  valueAtRiskUsd: number
  endpoint: string
  agentId?: string
  serviceId?: string
  expectedPriceAtomic?: string
  expectedRecipient?: `0x${string}`
  intendedRequest?: {
    method?: 'GET' | 'POST'
    path?: string
    body?: Record<string, unknown>
  }
  probeMode?: AspProbeMode
  idempotencyKey?: string
}

export type AspTrustCheckResponse = {
  action: AssuranceAction
  observations: EvidenceObservation[]
  verdict: AssuranceVerdict
  recommendation: 'BUY' | 'CAUTION' | 'AVOID'
  record: AssuranceRecordReference
}

export type SimpleCrossExaminationInput = {
  title: string
  intent: string
  valueAtRiskUsd: number
  transaction?: Omit<TransactionAssuranceActionInput, 'title' | 'valueAtRiskUsd' | 'intent'>
  tokenRiskTarget?: string
}

export type CrossExaminationPreparationRequest = {
  simple?: SimpleCrossExaminationInput
  decision?: DecisionPackage
}

export type CrossExaminationPreparationResponse = {
  action: AssuranceAction
  decision: DecisionPackage
  generatedClaims: DecisionClaim[]
  evidencePlan: EvidencePlanScope[]
  quote: {
    priceUsdt: string
    externalEvidenceBudgetUsdt: number
    minimumGrossMarginFraction: number
  }
  limitations: string[]
  /** False means CrossExam has no complete real-provider plan and will not accept payment. */
  canStart: boolean
}

export type CrossExaminationRequest = CrossExaminationPreparationRequest & {
  idempotencyKey?: string
}

export type CrossExaminationResponse = {
  jobId: string
  status: 'AWAITING_MATCH' | 'AWAITING_DELIVERIES' | 'READY_FOR_ASSURANCE' | 'FAILED' | 'CANCELLED' | 'EXPIRED'
  accessToken: string
  action: AssuranceAction
  decision: DecisionPackage
  evidencePlan: EvidencePlanScope[]
  quote: CrossExaminationPreparationResponse['quote']
  authorization: {
    endpoint: '/api/v1/review-jobs/authorize'
    method: 'POST'
    required: true
    request: { jobId: string; accessToken: string }
  }
}

/** Free verification endpoint; it never trusts an issuer supplied by the record being verified. */
export type VerifyAssuranceRecordRequest = {
  record: unknown
  expectedServiceSigner: `0x${string}`
  intent: ActionIntent
  policy?: Partial<PreActionPolicy>
}

export type VerifyAssuranceRecordResponse = {
  signatureValid: boolean
  actionBindingValid: boolean
  gate: PreActionDecision
}
