import { describe, expect, it } from 'vitest'
import { quoteReview } from './reviewPricing'

describe('quoteReview', () => {
  it('refuses authorization pricing that cannot cover the capped external budget and margin floor', () => {
    const quote = quoteReview({ id: 'RP-1', decisionId: 'DP-1', estimatedTotalUsdt: 1.2, scopes: [] }, '0.50', 0.4)
    expect(quote.minimumAuthorizationPriceUsdt).toBe(2)
    expect(quote.economicallyAuthorized).toBe(false)
  })

  it('keeps quoted revenue and estimated gross margin explicit', () => {
    const quote = quoteReview({ id: 'RP-1', decisionId: 'DP-1', estimatedTotalUsdt: 0.1, scopes: [] }, '2.00', 0.4)
    expect(quote).toMatchObject({ authorizationPriceUsdt: 2, estimatedExternalCostUsdt: 0.1, estimatedGrossMarginUsdt: 1.9, economicallyAuthorized: true })
  })
})
