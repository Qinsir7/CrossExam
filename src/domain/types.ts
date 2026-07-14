export type ClaimVerdict = 'SURVIVED' | 'REFUTED' | 'UNRESOLVED'

export type ActionRecommendation = 'PROCEED' | 'CONDITIONAL' | 'HOLD' | 'BLOCK'

export type DecisionClaim = {
  id: string
  statement: string
  materiality: number
}

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
}

export type DecisionPackage = {
  id: string
  title: string
  valueAtRiskUsd: number
  claims: DecisionClaim[]
}

export type ExaminedClaim = {
  id: string
  text: string
  verdict: ClaimVerdict
  evidence: string
  challenger: string
}

export type CrossExamResult = {
  claims: ExaminedClaim[]
  action: ActionRecommendation
  effectiveIndependence: number
  materialRefutations: number
  materialUnresolved: number
}
