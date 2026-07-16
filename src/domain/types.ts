export type ClaimVerdict = 'SURVIVED' | 'REFUTED' | 'UNRESOLVED'

export type ActionRecommendation = 'PROCEED' | 'CONDITIONAL' | 'HOLD' | 'BLOCK'

export type DecisionClaim = {
  id: string
  statement: string
  materiality: number
}

export type ActionType = 'SPEND' | 'TRADE' | 'DEPLOY' | 'PUBLISH' | 'OTHER'

export type ActionBinding = {
  actionType: ActionType
  target: string
  parametersHash: string
}

/** Additional evidence target bound into a Decision Package, never inferred by a provider. */
export type ReviewEvidenceContext = {
  /** Provider-readable token identifier, e.g. token:eth:0x…; may differ from a router execution target. */
  tokenRiskTarget?: string
}

/** A product-level route that determines which independent evidence scopes buy. */
export type ReviewProfile = 'GENERAL' | 'PRETRADE_ONCHAIN'

export type Reviewer = {
  id: string
  name: string
  ownerId: string
  modelFamily: string
  evidenceRoute: string
}

export type Finding = {
  claimId: string
  reviewerId: string
  verdict: 'SUPPORTS' | 'CONTRADICTS' | 'INSUFFICIENT_EVIDENCE'
  confidence: number
  materiality: number
  evidence: string
  /**
   * Traceable evidence references are required when a finding is submitted as
   * a network delivery. Kept optional here so pure aggregation can still be
   * used to reason about abstract findings without inventing artifacts.
   */
  evidenceArtifactIds?: string[]
}

export type DecisionPackage = {
  id: string
  title: string
  valueAtRiskUsd: number
  claims: DecisionClaim[]
  actionBinding?: ActionBinding
  reviewEvidenceContext?: ReviewEvidenceContext
  reviewProfile?: ReviewProfile
}

export type ExaminedClaim = {
  id: string
  text: string
  verdict: ClaimVerdict
  evidence: string
  challenger: string
}

export type ReversalCondition = {
  claimId: string
  kind: 'OVERTURN_CONTRADICTION' | 'RESOLVE_UNCERTAINTY'
  requirement: string
  basedOnEvidence: string
}

export type CrossExamResult = {
  claims: ExaminedClaim[]
  action: ActionRecommendation
  effectiveIndependence: number
  materialRefutations: number
  materialUnresolved: number
  reversalConditions: ReversalCondition[]
}
