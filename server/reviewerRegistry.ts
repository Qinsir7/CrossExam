import type { Address } from 'viem'
import { createReviewPlan } from '../src/domain/reviewPlan'
import type { DecisionPackage } from '../src/domain/types'
import type { ReviewerProfile, ReviewDispatch } from '../src/network/reviewNetwork'
import type { ReviewerWalletRegistry } from './deliveryAttestation'

export type RegisteredReviewer = ReviewerProfile & {
  wallet: Address
  status: 'ACTIVE' | 'SUSPENDED'
  /** HTTPS x402 endpoint that accepts CrossExam blind-review procurement. */
  procurementEndpoint?: string
  /** The only protocol allowed to produce a signed NETWORK_VERIFIED delivery. */
  procurementProtocol?: 'CROSSEXAM_SIGNED_CALLBACK_V1'
}

export type ReviewerRegistry = Record<string, RegisteredReviewer>

export function reviewerWalletRegistry(registry: ReviewerRegistry): ReviewerWalletRegistry {
  return Object.fromEntries(Object.values(registry).map((reviewer) => [reviewer.id, reviewer.wallet]))
}

/**
 * Replaces every caller-provided identity field with the server-owned
 * registry record and rejects assignments that are not part of this
 * decision's canonical review plan. The requester therefore cannot buy the
 * NETWORK_VERIFIED label by naming related reviewers with invented owners.
 */
export function normalizeReviewJobDispatch(
  decision: DecisionPackage,
  dispatch: ReviewDispatch,
  registry: ReviewerRegistry,
): ReviewDispatch {
  const plan = createReviewPlan(decision)
  if (dispatch.decisionId !== decision.id || dispatch.id !== `RD-${plan.id.replace('RP-', '')}`) {
    throw new Error('Review dispatch does not match the canonical decision review plan.')
  }
  if (dispatch.assignments.length !== plan.scopes.length) {
    throw new Error('Review dispatch must cover every canonical review scope exactly once.')
  }

  const seenScopes = new Set<string>()
  const usedOwners = new Set<string>()
  const usedWallets = new Set<string>()
  const assignments = dispatch.assignments.map((assignment) => {
    const scope = plan.scopes.find((candidate) => candidate.id === assignment.scopeId)
    if (!scope || seenScopes.has(scope.id)) {
      throw new Error('Review dispatch has a duplicate or unknown review scope.')
    }
    seenScopes.add(scope.id)
    if (!assignment.reviewer) {
      if (assignment.status !== 'AWAITING_MATCH') throw new Error('Only unmatched review scopes may omit a reviewer.')
      return assignment
    }
    const reviewer = registry[assignment.reviewer.id]
    if (!reviewer || reviewer.status !== 'ACTIVE') {
      throw new Error('Network-verified dispatch uses a reviewer that is not active in the server registry.')
    }
    if (!reviewer.capabilities.includes(scope.requiredCapability)) {
      throw new Error('Registered reviewer is not authorized for this review scope.')
    }
    if (assignment.delivery && assignment.delivery.reviewerId !== reviewer.id) {
      throw new Error('Delivered review identity does not match the registered reviewer.')
    }
    if (usedOwners.has(reviewer.ownerId) || usedWallets.has(reviewer.wallet.toLowerCase())) {
      throw new Error('Network-verified dispatch cannot reuse a reviewer owner or wallet across scopes.')
    }
    usedOwners.add(reviewer.ownerId)
    usedWallets.add(reviewer.wallet.toLowerCase())
    return {
      ...assignment,
      reviewer: {
        id: reviewer.id,
        displayName: reviewer.displayName,
        ownerId: reviewer.ownerId,
        modelFamily: reviewer.modelFamily,
        evidenceRoutes: reviewer.evidenceRoutes,
      },
    }
  })

  return { ...dispatch, assignments }
}

/** Applies the stricter completeness rule required before issuing assurance. */
export function normalizeNetworkVerifiedDispatch(
  decision: DecisionPackage,
  dispatch: ReviewDispatch,
  registry: ReviewerRegistry,
): ReviewDispatch {
  const normalized = normalizeReviewJobDispatch(decision, dispatch, registry)
  if (normalized.assignments.some((assignment) => !assignment.reviewer || !assignment.delivery)) {
    throw new Error('Network-verified dispatch has an incomplete review scope.')
  }
  return normalized
}
