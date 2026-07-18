import { describe, expect, it } from 'vitest'
import { encodePaymentRequiredHeader } from '@okxweb3/x402-core/http'
import { prepareAspTrustCheck } from './aspEndpointProbe'

const asset = '0x779ded0c9e1022225f8e0630b35a9b54be713736'
const payTo = '0xf75804470d1a746f55529b356087bc3f86bd3257'

function dependencies(response: { status: number; headers?: Record<string, string>; body?: string }) {
  return {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => ({ latencyMs: 42, body: response.body ?? '{}', headers: response.headers ?? {}, status: response.status }),
    now: () => new Date('2026-07-18T12:00:00.000Z'),
  }
}

describe('prepareAspTrustCheck', () => {
  it('returns a signed-record candidate with BUY only for a coherent bounded X Layer payment challenge', async () => {
    const paymentRequired = {
      x402Version: 2,
      resource: { url: 'https://agent.example/api' },
      accepts: [{ scheme: 'exact' as const, network: 'eip155:196' as const, asset, amount: '20000', payTo, maxTimeoutSeconds: 300, extra: {} }],
    }
    const result = await prepareAspTrustCheck({ endpoint: 'https://agent.example/api', valueAtRiskUsd: 20, expectedPriceAtomic: '20000', expectedRecipient: payTo }, dependencies({ status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(paymentRequired) } }))

    expect(result.recommendation).toBe('BUY')
    expect(result.verdict).toMatchObject({ verdict: 'PERMIT', canExecute: true })
    expect(result.record.result.action).toBe('PROCEED')
    expect(result.observations[0].facts).toContainEqual({ key: 'payment.amountAtomic', value: '20000' })
  })

  it('fails before connecting to a private target', async () => {
    let requested = false
    await expect(prepareAspTrustCheck({ endpoint: 'https://private.example', valueAtRiskUsd: 20 }, {
      resolve: async () => [{ address: '10.0.0.1', family: 4 }],
      request: async () => { requested = true; throw new Error('must not request') },
    })).rejects.toThrow('forbidden address')
    expect(requested).toBe(false)
  })

  it('returns CAUTION when a payment recipient contradicts the caller expectation', async () => {
    const paymentRequired = {
      x402Version: 2,
      resource: { url: 'https://agent.example/api' },
      accepts: [{ scheme: 'exact' as const, network: 'eip155:196' as const, asset, amount: '20000', payTo, maxTimeoutSeconds: 300, extra: {} }],
    }
    const result = await prepareAspTrustCheck({ endpoint: 'https://agent.example/api', valueAtRiskUsd: 20, expectedRecipient: '0x1111111111111111111111111111111111111111' }, dependencies({ status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(paymentRequired) } }))
    expect(result.recommendation).toBe('CAUTION')
    expect(result.verdict).toMatchObject({ verdict: 'HOLD', canExecute: false })
  })

  it('rejects redirects and refuses to perform a passive POST probe', async () => {
    const redirected = await prepareAspTrustCheck({ endpoint: 'https://agent.example/api', valueAtRiskUsd: 20 }, dependencies({ status: 302, headers: { location: 'https://other.example' } }))
    expect(redirected.recommendation).toBe('AVOID')
    await expect(prepareAspTrustCheck({ endpoint: 'https://agent.example/api', valueAtRiskUsd: 20, intendedRequest: { method: 'POST' } }, dependencies({ status: 402 }))).rejects.toThrow('only GET')
  })
})
