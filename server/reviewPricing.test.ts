import { describe, expect, it } from 'vitest'
import { quoteReview } from './reviewPricing'

describe('quoteReview', () => {
  it('raises the authorization price to cover the capped external budget and margin floor', () => {
    const quote = quoteReview({ id: 'RP-1', decisionId: 'DP-1', estimatedTotalUsdt: 1.2, scopes: [] }, '0.50', 0.4)
    expect(quote.minimumAuthorizationPriceUsdt).toBe(2)
    expect(quote.authorizationPriceUsdt).toBe(2)
    expect(quote.estimatedGrossMarginUsdt).toBe(0.8)
    expect(quote.economicallyAuthorized).toBe(true)
  })

  it('keeps quoted revenue and estimated gross margin explicit', () => {
    const quote = quoteReview({ id: 'RP-1', decisionId: 'DP-1', estimatedTotalUsdt: 0.005, scopes: [] }, '2.00', 0.4)
    expect(quote).toMatchObject({ authorizationPriceUsdt: 2, estimatedExternalCostUsdt: 0.005, minimumAuthorizationPriceUsdt: 0.01, estimatedGrossMarginUsdt: 1.995, estimatedGrossMarginFraction: 0.9975, economicallyAuthorized: true })
  })

  it('rounds the minimum viable customer price upward instead of violating the margin floor', () => {
    const quote = quoteReview({ id: 'RP-1', decisionId: 'DP-1', estimatedTotalUsdt: 1, scopes: [] }, '0.50', 0.34)
    expect(quote.minimumAuthorizationPriceUsdt).toBe(1.52)
    expect(quote.authorizationPriceUsdt).toBe(1.52)
    expect(quote.estimatedGrossMarginFraction).toBeGreaterThanOrEqual(0.34)
  })
})
