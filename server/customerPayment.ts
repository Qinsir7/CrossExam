import type { ReviewJob } from './reviewJob'
import { recordReviewJobFundingSettlement } from './reviewJob'
import type { ReviewJobStore } from './reviewJobStore'

export const XLAYER_USDT0 = '0x779ded0c9e1022225f8e0630b35a9b54be713736'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

type JsonRpcReceipt = {
  status?: unknown
  logs?: Array<{ address?: unknown; topics?: unknown; data?: unknown }>
}

type SettlementStatus = {
  success: boolean
  status?: 'pending' | 'success' | 'failed'
  transaction?: string
  network?: string
}

function addressTopic(address: string) {
  return `0x${address.toLowerCase().slice(2).padStart(64, '0')}`
}

export async function verifyUsdt0Transfer(input: {
  transaction: string
  payTo: string
  amountAtomic: string
  rpcUrl?: string
  fetchImpl?: typeof fetch
}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.transaction)
    || !/^0x[0-9a-fA-F]{40}$/.test(input.payTo)
    || !/^[1-9][0-9]*$/.test(input.amountAtomic)) {
    throw new Error('Customer settlement proof is malformed.')
  }
  const fetchImpl = input.fetchImpl ?? ((request, init) => globalThis.fetch(request, init))
  const response = await fetchImpl(input.rpcUrl ?? 'https://rpc.xlayer.tech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [input.transaction] }),
  })
  if (!response.ok) throw new Error('X Layer receipt lookup failed.')
  const payload = await response.json() as { result?: JsonRpcReceipt | null }
  const receipt = payload.result
  if (!receipt || receipt.status !== '0x1' || !Array.isArray(receipt.logs)) throw new Error('Customer settlement is not confirmed on X Layer.')
  const recipientTopic = addressTopic(input.payTo)
  const expectedAmount = BigInt(input.amountAtomic)
  const matched = receipt.logs.some((log) => {
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== XLAYER_USDT0) return false
    if (!Array.isArray(log.topics) || log.topics.length < 3) return false
    if (typeof log.topics[0] !== 'string' || log.topics[0].toLowerCase() !== TRANSFER_TOPIC) return false
    if (typeof log.topics[2] !== 'string' || log.topics[2].toLowerCase() !== recipientTopic) return false
    if (typeof log.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(log.data)) return false
    return BigInt(log.data) === expectedAmount
  })
  if (!matched) throw new Error('Transaction does not contain the required CrossExam USDT0 transfer.')
}

export async function reconcileReviewJobFunding(input: {
  job: ReviewJob
  transaction: string
  payTo: string
  expectedAmountAtomic: string
  jobStore: ReviewJobStore
  getSettleStatus: (transaction: string) => Promise<SettlementStatus>
  rpcUrl?: string
  fetchImpl?: typeof fetch
  now?: string
}) {
  if (input.job.fundingStatus === 'AUTHORIZED') {
    if (input.job.customerPayment?.transaction.toLowerCase() !== input.transaction.toLowerCase()) {
      throw new Error('Review job is already funded by a different settlement.')
    }
    return input.job
  }
  const existing = await input.jobStore.findJobByCustomerPaymentTransaction(input.transaction)
  if (existing && existing.id !== input.job.id) throw new Error('Customer settlement is already assigned to another review job.')
  const status = await input.getSettleStatus(input.transaction)
  if (!status.success || status.status !== 'success'
    || (status.transaction !== undefined && status.transaction.toLowerCase() !== input.transaction.toLowerCase())
    || (status.network !== undefined && status.network !== 'eip155:196')) {
    throw new Error('Facilitator has not confirmed this customer settlement.')
  }
  await verifyUsdt0Transfer({
    transaction: input.transaction,
    payTo: input.payTo,
    amountAtomic: input.expectedAmountAtomic,
    ...(input.rpcUrl ? { rpcUrl: input.rpcUrl } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  })
  const authorized = recordReviewJobFundingSettlement(input.job, {
    network: 'eip155:196',
    asset: XLAYER_USDT0,
    amountAtomic: input.expectedAmountAtomic,
    transaction: input.transaction,
  }, input.now)
  if (authorized !== input.job) await input.jobStore.updateJob(authorized, input.job.revision)
  return authorized
}
