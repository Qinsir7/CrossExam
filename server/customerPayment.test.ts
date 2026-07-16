import { describe, expect, it, vi } from 'vitest'
import { verifyUsdt0Transfer, XLAYER_USDT0 } from './customerPayment'

describe('customer settlement verification', () => {
  it('accepts only a confirmed exact USDT0 transfer to the configured recipient', async () => {
    const payTo = '0xf75804470d1a746f55529b356087bc3f86bd3257'
    const payer = '0xffc6c6162ceb6ad082ea0ecf1fe6106d955e2827'
    const recipientTopic = `0x${payTo.slice(2).padStart(64, '0')}`
    const payerTopic = `0x${payer.slice(2).padStart(64, '0')}`
    const receiptPayload = JSON.stringify({
      result: {
        status: '0x1',
        logs: [{
          address: XLAYER_USDT0,
          topics: [
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            payerTopic,
            recipientTopic,
          ],
          data: '0x1e8480',
        }],
      },
    })
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(receiptPayload, { status: 200 }))

    await expect(verifyUsdt0Transfer({
      transaction: `0x${'a'.repeat(64)}`,
      payTo,
      amountAtomic: '2000000',
      fetchImpl,
    })).resolves.toBe(payer)
    await expect(verifyUsdt0Transfer({
      transaction: `0x${'a'.repeat(64)}`,
      payTo,
      amountAtomic: '2000001',
      fetchImpl,
    })).rejects.toThrow('required CrossExam USDT0 transfer')
  })
})
