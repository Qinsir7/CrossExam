import type {
  ActionRecommendation,
  ClaimVerdict,
  CrossExamResult,
  DecisionPackage,
  Finding,
  ReversalCondition,
  Reviewer,
} from './types'

export type DeterministicFinding = {
  finding: Finding
  sourceLabel: string
}

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

function reversalCondition(claimText: string, claimId: string, verdict: ClaimVerdict, findings: Finding[]): ReversalCondition | null {
  if (verdict === 'SURVIVED') return null
  const relevant = findings.filter((finding) => verdict === 'REFUTED' ? finding.verdict === 'CONTRADICTS' : finding.verdict === 'INSUFFICIENT_EVIDENCE')
  const lead = [...relevant].sort((left, right) => right.confidence * right.materiality - left.confidence * left.materiality)[0]
  const basedOnEvidence = lead?.evidence ?? 'No independent evidence was delivered for this claim.'

  if (verdict === 'REFUTED') {
    return {
      claimId,
      kind: 'OVERTURN_CONTRADICTION',
      requirement: `Provide independently verifiable evidence that directly overturns the documented contradiction to: ${claimText}`,
      basedOnEvidence,
    }
  }
  return {
    claimId,
    kind: 'RESOLVE_UNCERTAINTY',
    requirement: `Provide a traceable primary source or independent tool output that resolves the uncertainty in: ${claimText}`,
    basedOnEvidence,
  }
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
  deterministicFindings: DeterministicFinding[] = [],
): CrossExamResult {
  const firstPartyLabels = new Map(deterministicFindings.map((item) => [item.finding.reviewerId, item.sourceLabel]))
  const allFindings = [...findings, ...deterministicFindings.map((item) => item.finding)]
  const examinedClaims = decision.claims.map((claim) => {
    const claimFindings = allFindings.filter((finding) => finding.claimId === claim.id)
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
      challenger: reviewer?.name ?? (leadFinding ? firstPartyLabels.get(leadFinding.reviewerId) ?? 'No reviewer assigned' : 'No reviewer assigned'),
    }
  })

  const materialRefutations = examinedClaims.filter((claim) => claim.verdict === 'REFUTED').length
  const materialUnresolved = examinedClaims.filter((claim) => claim.verdict === 'UNRESOLVED').length
  const reversalConditions = decision.claims.flatMap((claim) => {
    const examined = examinedClaims.find((candidate) => candidate.id === claim.id)!
    const condition = reversalCondition(claim.statement, claim.id, examined.verdict, allFindings.filter((finding) => finding.claimId === claim.id))
    return condition ? [condition] : []
  })

  return {
    claims: examinedClaims,
    action: recommendation(materialRefutations, materialUnresolved),
    effectiveIndependence: effectiveIndependence(reviewers),
    materialRefutations,
    materialUnresolved,
    reversalConditions,
  }
}
