import type { Address } from 'viem'
import { createReviewPlan } from '../src/domain/reviewPlan'
import type { DecisionPackage } from '../src/domain/types'
import type { ReviewerProfile, ReviewDispatch } from '../src/network/reviewNetwork'
import type { ReviewerWalletRegistry } from './deliveryAttestation'

export type RegisteredReviewer = ReviewerProfile & {
  wallet?: Address
  status: 'ACTIVE' | 'SUSPENDED'
  /** HTTPS x402 endpoint that accepts CrossExam blind-review procurement. */
  procurementEndpoint?: string
  /** Signed callbacks are network-verifiable; paid evidence is intentionally weaker. */
  procurementProtocol?: 'CROSSEXAM_SIGNED_CALLBACK_V1' | 'PAID_EVIDENCE_V1' | 'AUTHENTICATED_API_EVIDENCE_V1'
  /** Controls a server-owned, deterministic normalizer for a paid response. */
  responseAdapter?: 'OPAQUE_JSON_V1' | 'CERTIK_TOKEN_SCAN_V1' | 'OKX_TOKEN_LIQUIDITY_V1'
  /** Immutable x402 merchant recipient expected from a paid-evidence source. */
  paymentRecipient?: Address
  /** Conservative USDT estimate supplied from the provider's public x402 quote. */
  estimatedUnitCostUsdt?: number
  /** Static JSON body for ordinary HTTP evidence APIs that do not accept a review task. */
  evidenceRequestBody?: Record<string, unknown>
}

export type ReviewerRegistry = Record<string, RegisteredReviewer>

export const OKX_MARKET_SOURCE_ID = 'okx-onchainos-liquidity'

/** Built-in official market source; HMAC credentials remain worker-only. */
export function withOkxMarketSource(registry: ReviewerRegistry): ReviewerRegistry {
  return {
    ...registry,
    [OKX_MARKET_SOURCE_ID]: {
      id: OKX_MARKET_SOURCE_ID,
      displayName: 'OKX Onchain OS Market',
      ownerId: 'okx-onchainos-market',
      modelFamily: 'aggregated-onchain-market-data',
      evidenceRoutes: ['okx-market-token-liquidity'],
      capabilities: ['execution liquidity'],
      selectionPriority: 100,
      status: 'ACTIVE',
      procurementEndpoint: 'https://web3.okx.com/api/v6/dex/market/token/top-liquidity',
      procurementProtocol: 'AUTHENTICATED_API_EVIDENCE_V1',
      responseAdapter: 'OKX_TOKEN_LIQUIDITY_V1',
      estimatedUnitCostUsdt: 0.005,
    },
  }
}

export function reviewerWalletRegistry(registry: ReviewerRegistry): ReviewerWalletRegistry {
  return Object.fromEntries(Object.values(registry).filter((reviewer) => reviewer.wallet).map((reviewer) => [reviewer.id, reviewer.wallet!]))
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
    if (usedOwners.has(reviewer.ownerId) || (reviewer.wallet && usedWallets.has(reviewer.wallet.toLowerCase()))) {
      throw new Error('Network-verified dispatch cannot reuse a reviewer owner or wallet across scopes.')
    }
    usedOwners.add(reviewer.ownerId)
    if (reviewer.wallet) usedWallets.add(reviewer.wallet.toLowerCase())
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
  if (normalized.assignments.some((assignment) => {
    const protocol = registry[assignment.reviewer!.id]?.procurementProtocol
    return protocol === 'PAID_EVIDENCE_V1' || protocol === 'AUTHENTICATED_API_EVIDENCE_V1'
  })) {
    throw new Error('A paid evidence source cannot be represented as a network-verified reviewer.')
  }
  return normalized
}

/** Re-prices a canonical plan only from server-owned provider cost bindings. */
export function applyMatchedProviderCosts(plan: ReturnType<typeof createReviewPlan>, dispatch: ReviewDispatch, registry: ReviewerRegistry) {
  const scopes = plan.scopes.map((scope) => {
    const reviewerId = dispatch.assignments.find((assignment) => assignment.scopeId === scope.id)?.reviewer?.id
    const configuredCost = reviewerId ? registry[reviewerId]?.estimatedUnitCostUsdt : undefined
    return configuredCost === undefined ? scope : { ...scope, estimatedFeeUsdt: configuredCost }
  })
  return { ...plan, scopes, estimatedTotalUsdt: Number(scopes.reduce((sum, scope) => sum + scope.estimatedFeeUsdt, 0).toFixed(6)) }
}
