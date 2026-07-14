import type {
  ActionRecommendation,
  ClaimVerdict,
  CrossExamResult,
  DecisionPackage,
  Finding,
  Reviewer,
} from './types'

const VERIFIED_CONTRADICTION_THRESHOLD = 0.7
const MATERIAL_THRESHOLD = 0.7

function verdictFor(findings: Finding[]): ClaimVerdict {
  const materialContradiction = findings.some(
    (finding) =>
      finding.verdict === 'CONTRADICTS' &&
      finding.confidence >= VERIFIED_CONTRADICTION_THRESHOLD &&
      finding.materiality >= MATERIAL_THRESHOLD,
  )

  if (materialContradiction) return 'REFUTED'

  const verifiedSupport = findings.some(
    (finding) =>
      finding.verdict === 'SUPPORTS' &&
      finding.confidence >= VERIFIED_CONTRADICTION_THRESHOLD,
  )

  const unresolved = findings.some((finding) => finding.verdict === 'INSUFFICIENT_EVIDENCE')

  if (verifiedSupport && !unresolved) return 'SURVIVED'
  return 'UNRESOLVED'
}

function recommendation(refutations: number, unresolved: number): ActionRecommendation {
  if (refutations >= 3) return 'BLOCK'
  if (refutations >= 1) return 'HOLD'
  if (unresolved >= 1) return 'CONDITIONAL'
  return 'PROCEED'
}

/**
 * Measures reviewer diversity by independent ownership, model families, and
 * evidence routes. It intentionally does not reward redundant reviewers.
 */
function effectiveIndependence(reviewers: Reviewer[]): number {
  const owners = new Set(reviewers.map((reviewer) => reviewer.ownerId)).size
  const models = new Set(reviewers.map((reviewer) => reviewer.modelFamily)).size
  const routes = new Set(reviewers.map((reviewer) => reviewer.evidenceRoute)).size
  const reviewerCount = reviewers.length

  if (reviewerCount === 0) return 0

  const diversity = (owners + models + routes) / (reviewerCount * 3)
  return Number((reviewerCount * diversity * 0.9).toFixed(1))
}

export function runCrossExam(
  decision: DecisionPackage,
  reviewers: Reviewer[],
  findings: Finding[],
): CrossExamResult {
  const examinedClaims = decision.claims.map((claim) => {
    const claimFindings = findings.filter((finding) => finding.claimId === claim.id)
    const verdict = verdictFor(claimFindings)
    const leadFinding = [...claimFindings].sort(
      (left, right) => right.confidence * right.materiality - left.confidence * left.materiality,
    )[0]
    const reviewer = reviewers.find((candidate) => candidate.id === leadFinding?.reviewerId)

    return {
      id: claim.id,
      text: claim.statement,
      verdict,
      evidence: leadFinding?.evidence ?? 'No independent evidence was delivered for this claim.',
      challenger: reviewer?.name ?? 'No reviewer assigned',
    }
  })

  const materialRefutations = examinedClaims.filter((claim) => claim.verdict === 'REFUTED').length
  const materialUnresolved = examinedClaims.filter((claim) => claim.verdict === 'UNRESOLVED').length

  return {
    claims: examinedClaims,
    action: recommendation(materialRefutations, materialUnresolved),
    effectiveIndependence: effectiveIndependence(reviewers),
    materialRefutations,
    materialUnresolved,
  }
}
