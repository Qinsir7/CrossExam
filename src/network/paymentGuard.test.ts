import { describe, expect, it } from 'vitest'
import { createReviewPlan } from '../domain/reviewPlan'
import type { DecisionPackage } from '../domain/types'
import { authorizeScopePayment, type A2APaymentOffer, type ProcurementSpendPolicy } from './paymentGuard'

const decision: DecisionPackage = {
  id: 'DP-PAY',
  title: 'Review a procurement action',
  valueAtRiskUsd: 15_000,
  claims: [{ id: 'C-1', statement: 'The proposed supplier is suitable.', materiality: 0.8 }],
}
const scope = createReviewPlan(decision).scopes[0]
const policy: ProcurementSpendPolicy = { maxPerScopeUsdt: 1, maxTotalUsdt: 3, allowedSymbols: ['USDT'] }
const offer: A2APaymentOffer = {
  paymentId: 'a2a_payment_1',
  paymentUrl: 'https://pay.okx.com/p/a2a_payment_1',
  amount: '0.60',
  symbol: 'USDT',
  recipient: '0xSeller',
  expiresAt: '2026-07-14T16:00:00.000Z',
  challenge: { method: 'evm', intent: 'charge', chainId: 196 },
}

describe('authorizeScopePayment', () => {
  it('creates a wallet-signature request only after policy validation', () => {
    const authorization = authorizeScopePayment(scope, offer, policy, new Date('2026-07-14T15:00:00.000Z'))

    expect(authorization.status).toBe('AWAITING_WALLET_SIGNATURE')
    expect(authorization.scopeId).toBe(scope.id)
  })

  it('rejects a payment from a different chain before a wallet sees it', () => {
    expect(() => authorizeScopePayment(scope, { ...offer, challenge: { ...offer.challenge, chainId: 1 } }, policy, new Date('2026-07-14T15:00:00.000Z'))).toThrow('X Layer')
  })

  it('rejects offers that exceed the configured spend policy', () => {
    expect(() => authorizeScopePayment(scope, { ...offer, amount: '1.01' }, policy, new Date('2026-07-14T15:00:00.000Z'))).toThrow('spend policy')
  })

  it('rejects expired offers', () => {
    expect(() => authorizeScopePayment(scope, offer, policy, new Date('2026-07-14T17:00:00.000Z'))).toThrow('expired')
  })
})
