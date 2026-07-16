import type { Finding } from '../domain/types'
import type { ReviewPlan, ReviewScope } from '../domain/reviewPlan'

export type ReviewerProfile = {
  id: string
  displayName: string
  ownerId: string
  modelFamily: string
  evidenceRoutes: string[]
  capabilities: string[]
}

export type EvidenceArtifact = {
  id: string
  kind: 'PRIMARY_SOURCE' | 'TOOL_OUTPUT' | 'SEARCH_LOG' | 'ONCHAIN_RECORD'
  locator: string
  observedAt: string
  excerpt: string
  /** Keccak-256 of this artifact's canonical, immutable delivery fields. */
  contentHash?: `0x${string}`
}

/**
 * A paid external response can be independently tied to an x402 settlement
 * without pretending that the source signed CrossExam's reviewer delivery.
 */
export type PaidEvidenceProvenance = {
  kind: 'X402_PAID_EVIDENCE_V1'
  sourceId: string
  endpoint: string
  observedAt: string
  requestHash: `0x${string}`
  responseHash: `0x${string}`
  payment: { network: 'eip155:196'; asset: string; amountAtomic: string; transaction: string }
}

export type ReviewDelivery = {
  reviewerId: string
  deliveredAt: string
  artifacts: EvidenceArtifact[]
  findings: Finding[]
  provenance?: PaidEvidenceProvenance
}

export type AssignmentStatus = 'AWAITING_MATCH' | 'MATCHED' | 'DELIVERED'

export type ReviewAssignment = {
  scopeId: string
  status: AssignmentStatus
  reviewer?: Pick<ReviewerProfile, 'id' | 'displayName' | 'ownerId' | 'modelFamily' | 'evidenceRoutes'>
  delivery?: ReviewDelivery
  reason: string
}

export type ReviewDispatch = {
  id: string
  decisionId: string
  status: 'STAGED' | 'PARTIALLY_MATCHED' | 'MATCHED' | 'IN_REVIEW' | 'DELIVERED'
  assignments: ReviewAssignment[]
}

function compatible(scope: ReviewScope, reviewer: ReviewerProfile) {
  return reviewer.capabilities.includes(scope.requiredCapability)
}

/**
 * Stages an evidence-procurement request against an externally maintained
 * ASP registry. This deliberately performs no evidence generation and returns
 * no findings: a match is a commercial/operational state, never a verdict.
 *
 * A candidate may not be reused by owner. We also favour new model families
 * and evidence routes, because three nominal agents operated by one provider
 * are not three independent cross-examiners.
 */
export function stageReviewPlan(plan: ReviewPlan, registry: ReviewerProfile[]): ReviewDispatch {
  const usedOwners = new Set<string>()
  const usedModels = new Set<string>()
  const usedEvidenceRoutes = new Set<string>()

  const assignments = plan.scopes.map((scope) => {
    const candidates = registry
      .filter((reviewer) => compatible(scope, reviewer) && !usedOwners.has(reviewer.ownerId))
      .sort((left, right) => noveltyScore(right, usedModels, usedEvidenceRoutes) - noveltyScore(left, usedModels, usedEvidenceRoutes))

    const selected = candidates[0]
    if (!selected) {
      return {
        scopeId: scope.id,
        status: 'AWAITING_MATCH' as const,
        reason: 'No compatible, independent reviewer is currently available in the verified registry.',
      }
    }

    usedOwners.add(selected.ownerId)
    usedModels.add(selected.modelFamily)
    selected.evidenceRoutes.forEach((route) => usedEvidenceRoutes.add(route))

    return {
      scopeId: scope.id,
      status: 'MATCHED' as const,
      reviewer: {
        id: selected.id,
        displayName: selected.displayName,
        ownerId: selected.ownerId,
        modelFamily: selected.modelFamily,
        evidenceRoutes: selected.evidenceRoutes,
      },
      reason: 'Matched on required capability with a distinct reviewer owner.',
    }
  })

  const matched = assignments.filter((assignment) => assignment.status === 'MATCHED').length
  const status = matched === 0 ? 'STAGED' : matched === assignments.length ? 'MATCHED' : 'PARTIALLY_MATCHED'

  return {
    id: `RD-${plan.id.replace('RP-', '')}`,
    decisionId: plan.decisionId,
    status,
    assignments,
  }
}

function noveltyScore(reviewer: ReviewerProfile, usedModels: Set<string>, usedEvidenceRoutes: Set<string>) {
  const modelNovelty = usedModels.has(reviewer.modelFamily) ? 0 : 2
  const routeNovelty = reviewer.evidenceRoutes.filter((route) => !usedEvidenceRoutes.has(route)).length
  return modelNovelty + routeNovelty
}

/**
 * Records an externally supplied review only when it can be attributed to the
 * reviewer CrossExam actually selected and it addresses every claim in that
 * scope. A review that is merely "interesting" but incomplete remains a
 * pending review; it must not quietly become decision-grade evidence.
 */
export function acceptReviewDelivery(
  plan: ReviewPlan,
  dispatch: ReviewDispatch,
  scopeId: string,
  delivery: ReviewDelivery,
): ReviewDispatch {
  const scope = plan.scopes.find((item) => item.id === scopeId)
  const assignment = dispatch.assignments.find((item) => item.scopeId === scopeId)

  if (!scope || !assignment || assignment.status !== 'MATCHED' || !assignment.reviewer) {
    throw new Error('This scope is not matched and cannot accept a delivery.')
  }
  if (assignment.reviewer.id !== delivery.reviewerId) {
    throw new Error('A delivery can only be accepted from the reviewer assigned to this scope.')
  }
  if (delivery.artifacts.length === 0 || delivery.artifacts.some((artifact) => !artifact.locator.trim() || !artifact.excerpt.trim())) {
    throw new Error('A delivery needs at least one traceable evidence artifact.')
  }

  const artifactIds = new Set(delivery.artifacts.map((artifact) => artifact.id))
  if (artifactIds.size !== delivery.artifacts.length || delivery.artifacts.some((artifact) => !artifact.id.trim() || !artifact.contentHash)) {
    throw new Error('A delivery needs uniquely identified, content-addressed evidence artifacts.')
  }

  const expectedClaims = new Set(scope.claimIds)
  const addressedClaims = new Set(delivery.findings.map((finding) => finding.claimId))
  if (delivery.findings.some((finding) => finding.reviewerId !== delivery.reviewerId
    || !finding.evidence.trim()
    || !expectedClaims.has(finding.claimId)
    || !finding.evidenceArtifactIds?.length
    || finding.evidenceArtifactIds.some((artifactId) => !artifactIds.has(artifactId)))) {
    throw new Error('Findings must be attributable, evidenced, and limited to claims in this scope.')
  }
  if (expectedClaims.size !== addressedClaims.size || [...expectedClaims].some((claimId) => !addressedClaims.has(claimId))) {
    throw new Error('A delivery must explicitly address every claim in its scope.')
  }

  const assignments = dispatch.assignments.map((item) => item.scopeId === scopeId
    ? { ...item, status: 'DELIVERED' as const, delivery, reason: 'Delivered with attributable findings and traceable evidence artifacts.' }
    : item)
  const delivered = assignments.filter((item) => item.status === 'DELIVERED').length

  return {
    ...dispatch,
    status: delivered === assignments.length ? 'DELIVERED' : 'IN_REVIEW',
    assignments,
  }
}
