import type { ClaimVerdict, CrossExamResult } from '../domain/types'

export type TruthLabeledClaim = {
  id: string
  expectedVerdict: ClaimVerdict
  materiality: number
}

export type TruthLabeledDecision = {
  id: string
  claims: TruthLabeledClaim[]
}

export type DecisionEvaluation = {
  decisionId: string
  materialContradictionsExpected: number
  materialContradictionsDetected: number
  unsafeAction: boolean
  overblockedAction: boolean
  reversalCoverage: number
}

export type BenchmarkSummary = {
  decisions: number
  materialContradictionRecall: number
  unsafeActionRate: number
  overblockingRate: number
  reversalCoverage: number
}

const MATERIAL_THRESHOLD = 0.7

function allowsExecution(action: CrossExamResult['action']) {
  return action === 'PROCEED' || action === 'CONDITIONAL'
}

/**
 * Scores an assurance result only against ex-post truth labels. It measures
 * safety and calibration, never agreement between reviewers or models.
 */
export function evaluateDecisionResult(truth: TruthLabeledDecision, result: CrossExamResult): DecisionEvaluation {
  const materialRefutations = truth.claims.filter((claim) => claim.expectedVerdict === 'REFUTED' && claim.materiality >= MATERIAL_THRESHOLD)
  const detected = materialRefutations.filter((claim) => result.claims.find((examined) => examined.id === claim.id)?.verdict === 'REFUTED')
  const blockingClaims = truth.claims.filter((claim) => claim.expectedVerdict !== 'SURVIVED' && claim.materiality >= MATERIAL_THRESHOLD)
  const covered = blockingClaims.filter((claim) => result.reversalConditions.some((condition) => condition.claimId === claim.id))
  const hasMaterialRisk = blockingClaims.length > 0
  const allMaterialSurvived = truth.claims.filter((claim) => claim.materiality >= MATERIAL_THRESHOLD).every((claim) => claim.expectedVerdict === 'SURVIVED')

  return {
    decisionId: truth.id,
    materialContradictionsExpected: materialRefutations.length,
    materialContradictionsDetected: detected.length,
    unsafeAction: hasMaterialRisk && allowsExecution(result.action),
    overblockedAction: allMaterialSurvived && !allowsExecution(result.action),
    reversalCoverage: blockingClaims.length === 0 ? 1 : Number((covered.length / blockingClaims.length).toFixed(3)),
  }
}

export function summarizeBenchmark(evaluations: DecisionEvaluation[]): BenchmarkSummary {
  const expected = evaluations.reduce((sum, evaluation) => sum + evaluation.materialContradictionsExpected, 0)
  const detected = evaluations.reduce((sum, evaluation) => sum + evaluation.materialContradictionsDetected, 0)
  const count = evaluations.length
  return {
    decisions: count,
    materialContradictionRecall: expected === 0 ? 1 : Number((detected / expected).toFixed(3)),
    unsafeActionRate: count === 0 ? 0 : Number((evaluations.filter((evaluation) => evaluation.unsafeAction).length / count).toFixed(3)),
    overblockingRate: count === 0 ? 0 : Number((evaluations.filter((evaluation) => evaluation.overblockedAction).length / count).toFixed(3)),
    reversalCoverage: count === 0 ? 1 : Number((evaluations.reduce((sum, evaluation) => sum + evaluation.reversalCoverage, 0) / count).toFixed(3)),
  }
}
