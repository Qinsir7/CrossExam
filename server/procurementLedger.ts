import type { ReviewJob } from './reviewJob'
import type { ReviewQuote } from './reviewPricing'

export type ProcurementLedger = {
  jobId: string
  commercial: {
    customerAuthorization: 'UNFUNDED' | 'AUTHORIZED'
    quote: ReviewQuote
    /** Actual reviewer spend stays token-denominated until an accounting asset is configured. */
    grossMarginStatus: 'ESTIMATED_ONLY' | 'AWAITING_REVIEWER_SETTLEMENTS'
  }
  estimatedTotalUsdt: number
  scopes: Array<{
    scopeId: string
    title: string
    estimatedFeeUsdt: number
    procurementStatus: string
    externalRequestId?: string
    settlement?: { network: 'eip155:196'; asset: string; amountAtomic: string; transaction: string }
  }>
  settledByAsset: Array<{ asset: string; amountAtomic: string; payments: number }>
  outstandingScopeIds: string[]
}

/** Produces an auditable cost view without pretending that different token assets share a price. */
export function buildProcurementLedger(job: ReviewJob): ProcurementLedger {
  const totals = new Map<string, { amount: bigint; payments: number }>()
  const scopes = job.plan.scopes.map((scope) => {
    const procurement = job.procurements.find((item) => item.scopeId === scope.id)
    const payment = procurement?.payment
    if (payment) {
      const previous = totals.get(payment.asset) ?? { amount: 0n, payments: 0 }
      totals.set(payment.asset, { amount: previous.amount + BigInt(payment.amountAtomic), payments: previous.payments + 1 })
    }
    return {
      scopeId: scope.id,
      title: scope.title,
      estimatedFeeUsdt: scope.estimatedFeeUsdt,
      procurementStatus: procurement?.status ?? 'UNMATCHED',
      ...(procurement?.externalRequestId ? { externalRequestId: procurement.externalRequestId } : {}),
      ...(payment ? { settlement: payment } : {}),
    }
  })
  return {
    jobId: job.id,
    commercial: {
      customerAuthorization: job.fundingStatus,
      quote: job.quote,
      grossMarginStatus: totals.size === 0 ? 'ESTIMATED_ONLY' : 'AWAITING_REVIEWER_SETTLEMENTS',
    },
    estimatedTotalUsdt: job.plan.estimatedTotalUsdt,
    scopes,
    settledByAsset: [...totals.entries()].map(([asset, total]) => ({ asset, amountAtomic: total.amount.toString(), payments: total.payments })).sort((left, right) => left.asset.localeCompare(right.asset)),
    outstandingScopeIds: scopes.filter((scope) => scope.procurementStatus !== 'REQUESTED').map((scope) => scope.scopeId),
  }
}
