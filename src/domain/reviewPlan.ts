import type { DecisionPackage } from './types'

export type ReviewScope = {
  id: string
  title: string
  objective: string
  claimIds: string[]
  requiredCapability: string
  estimatedFeeUsdt: number
}

export type ReviewPlan = {
  id: string
  decisionId: string
  scopes: ReviewScope[]
  estimatedTotalUsdt: number
}

const EXECUTION_LIQUIDITY_CLAIM_ID = 'C-EXECUTION-LIQUIDITY'
const TOKEN_TRANSFER_SAFETY_CLAIM_ID = 'C-TOKEN-TRANSFER-SAFETY'

function fee(valueAtRiskUsd: number, share: number) {
  const proposed = valueAtRiskUsd * 0.00012 * share
  return Number(Math.max(0.05, Math.min(4, proposed)).toFixed(2))
}

/**
 * Produces procurement scopes, not conclusions. Each scope asks for a
 * different class of evidence so an eventual ASP network can be selected for
 * independence rather than simply asked to repeat the same opinion.
 */
export function createReviewPlan(decision: DecisionPackage): ReviewPlan {
  const claimIds = decision.claims.map((claim) => claim.id)
  if (decision.reviewProfile === 'PRETRADE_ONCHAIN') {
    const canonicalLiquidityClaims = claimIds.filter((id) => id === EXECUTION_LIQUIDITY_CLAIM_ID)
    const canonicalTokenRiskClaims = claimIds.filter((id) => id === TOKEN_TRANSFER_SAFETY_CLAIM_ID)
    const hasCanonicalPretradeClaims = canonicalLiquidityClaims.length > 0 || canonicalTokenRiskClaims.length > 0
    // Canonical transaction claims have distinct evidence owners. Do not ask a
    // liquidity endpoint to opine on token controls (or vice versa), and do
    // not send the first-party action-binding claim to either external source.
    // Older advanced PRETRADE packages without the canonical IDs retain the
    // historical all-claims scope so they remain reviewable.
    const liquidityClaimIds = hasCanonicalPretradeClaims ? canonicalLiquidityClaims : claimIds
    const tokenRiskClaimIds = hasCanonicalPretradeClaims ? canonicalTokenRiskClaims : claimIds
    const scopes: ReviewScope[] = [
      {
        id: 'execution-liquidity',
        title: 'Execution liquidity',
        objective: 'Measure executable liquidity, expected slippage, depth imbalance, and market conditions that could invalidate this exact onchain action.',
        claimIds: liquidityClaimIds,
        requiredCapability: 'execution liquidity',
        estimatedFeeUsdt: fee(decision.valueAtRiskUsd, 0.5),
      },
      {
        id: 'contract-token-risk',
        title: 'Contract and token risk',
        objective: 'Check contract controls, transfer restrictions, concentration, approval risk, and exploit signals relevant to this exact onchain action.',
        claimIds: tokenRiskClaimIds,
        requiredCapability: 'contract token risk',
        estimatedFeeUsdt: fee(decision.valueAtRiskUsd, 0.5),
      },
    ].filter((scope) => scope.claimIds.length > 0)
    return {
      id: `RP-${decision.id.replace('DP-', '')}`,
      decisionId: decision.id,
      scopes,
      estimatedTotalUsdt: Number(scopes.reduce((sum, scope) => sum + scope.estimatedFeeUsdt, 0).toFixed(2)),
    }
  }
  const scopes: ReviewScope[] = [
    {
      id: 'evidence-integrity',
      title: 'Evidence integrity',
      objective: 'Verify primary sources, timestamps, and whether each stated fact is actually supported.',
      claimIds,
      requiredCapability: 'source verification',
      estimatedFeeUsdt: fee(decision.valueAtRiskUsd, 0.4),
    },
    {
      id: 'assumption-challenge',
      title: 'Assumption challenge',
      objective: 'Search for omitted preconditions, counterexamples, and causal leaps that could reverse the proposed action.',
      claimIds,
      requiredCapability: 'adversarial research',
      estimatedFeeUsdt: fee(decision.valueAtRiskUsd, 0.3),
    },
    {
      id: 'domain-risk',
      title: 'Domain risk review',
      objective: 'Test the decision against domain-specific failure modes using tools and data sources independent from the origin agent.',
      claimIds,
      requiredCapability: 'domain specialist',
      estimatedFeeUsdt: fee(decision.valueAtRiskUsd, 0.3),
    },
  ]

  const estimatedTotalUsdt = Number(scopes.reduce((sum, scope) => sum + scope.estimatedFeeUsdt, 0).toFixed(2))

  return {
    id: `RP-${decision.id.replace('DP-', '')}`,
    decisionId: decision.id,
    scopes,
    estimatedTotalUsdt,
  }
}
