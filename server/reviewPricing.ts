import type { ReviewPlan } from '../src/domain/reviewPlan'

export type ReviewQuote = {
  currency: 'USDT'
  authorizationPriceUsdt: number
  estimatedExternalCostUsdt: number
  minimumGrossMarginFraction: number
  minimumAuthorizationPriceUsdt: number
  estimatedGrossMarginUsdt: number
  estimatedGrossMarginFraction: number
  economicallyAuthorized: boolean
}

function cents(value: number) {
  return Number(value.toFixed(2))
}

/**
 * A quote is deliberately deterministic and conservative: reviewer spend is
 * capped by the plan, while the configured authorization price acts as a
 * commercial floor. Higher-cost reviews are quoted up automatically so every
 * job preserves the declared minimum gross margin instead of being rejected.
 */
export function quoteReview(plan: ReviewPlan, authorizationPriceFloorUsd: string, minimumGrossMarginFraction: number): ReviewQuote {
  const authorizationPriceFloorUsdt = Number(authorizationPriceFloorUsd)
  if (!Number.isFinite(authorizationPriceFloorUsdt) || authorizationPriceFloorUsdt <= 0) throw new Error('Review authorization price floor must be positive.')
  if (!Number.isFinite(minimumGrossMarginFraction) || minimumGrossMarginFraction < 0 || minimumGrossMarginFraction >= 1) {
    throw new Error('Minimum gross margin must be a fraction from zero up to (but not including) one.')
  }
  const estimatedExternalCostUsdt = plan.estimatedTotalUsdt
  const minimumAuthorizationPriceUsdt = cents(estimatedExternalCostUsdt / (1 - minimumGrossMarginFraction))
  const authorizationPriceUsdt = Math.max(authorizationPriceFloorUsdt, minimumAuthorizationPriceUsdt)
  const estimatedGrossMarginUsdt = cents(authorizationPriceUsdt - estimatedExternalCostUsdt)
  const estimatedGrossMarginFraction = authorizationPriceUsdt === 0 ? 0 : Number((estimatedGrossMarginUsdt / authorizationPriceUsdt).toFixed(4))
  return {
    currency: 'USDT',
    authorizationPriceUsdt,
    estimatedExternalCostUsdt,
    minimumGrossMarginFraction,
    minimumAuthorizationPriceUsdt,
    estimatedGrossMarginUsdt,
    estimatedGrossMarginFraction,
    economicallyAuthorized: true,
  }
}
