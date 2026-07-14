import type { ReviewScope } from '../domain/reviewPlan'

export type A2APaymentOffer = {
  paymentId: string
  paymentUrl: string
  amount: string
  symbol: string
  recipient: string
  expiresAt: string
  challenge: {
    method: 'evm'
    intent: 'charge'
    chainId: number
  }
}

export type ProcurementSpendPolicy = {
  maxPerScopeUsdt: number
  maxTotalUsdt: number
  allowedSymbols: string[]
}

export type PaymentAuthorization = {
  scopeId: string
  paymentId: string
  amount: string
  symbol: string
  paymentUrl: string
  status: 'AWAITING_WALLET_SIGNATURE'
}

function parsedAmount(amount: string) {
  const value = Number(amount)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Verifies a seller-provided A2A payment offer before it ever reaches a
 * wallet. The function deliberately does not sign or submit a credential.
 * That operation belongs to a dedicated, authenticated wallet service.
 */
export function authorizeScopePayment(
  scope: ReviewScope,
  offer: A2APaymentOffer,
  policy: ProcurementSpendPolicy,
  now = new Date(),
): PaymentAuthorization {
  const amount = parsedAmount(offer.amount)
  if (!amount) throw new Error('Payment offer amount must be a positive decimal string.')
  if (offer.challenge.method !== 'evm' || offer.challenge.intent !== 'charge' || offer.challenge.chainId !== 196) {
    throw new Error('Only an X Layer EVM charge payment can fund this review scope.')
  }
  if (!policy.allowedSymbols.includes(offer.symbol)) {
    throw new Error('Payment offer uses a token outside the approved spend policy.')
  }
  if (amount > policy.maxPerScopeUsdt || amount > policy.maxTotalUsdt) {
    throw new Error('Payment offer exceeds the procurement spend policy.')
  }
  if (new Date(offer.expiresAt).getTime() <= now.getTime()) {
    throw new Error('Payment offer has expired.')
  }
  if (!offer.paymentId.trim() || !offer.recipient.trim() || !offer.paymentUrl.startsWith('https://')) {
    throw new Error('Payment offer is missing a valid payment reference.')
  }

  return {
    scopeId: scope.id,
    paymentId: offer.paymentId,
    amount: offer.amount,
    symbol: offer.symbol,
    paymentUrl: offer.paymentUrl,
    status: 'AWAITING_WALLET_SIGNATURE',
  }
}
