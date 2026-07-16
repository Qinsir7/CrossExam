import { describe, expect, it, vi } from 'vitest'
import { ReviewJobClient, resolveCrossExamApiUrl } from './reviewJobClient'

describe('ReviewJobClient', () => {
  it('uses the same-origin Vercel API proxy for public web deployments', () => {
    expect(resolveCrossExamApiUrl(undefined, 'https://www.cross-exam.xyz')).toBe('https://www.cross-exam.xyz/review-service')
    expect(resolveCrossExamApiUrl('https://stale-preview.example/', 'https://www.cross-exam.xyz')).toBe('https://www.cross-exam.xyz/review-service')
    expect(resolveCrossExamApiUrl(undefined, 'https://cross-exam-git-main-qinsir7.vercel.app')).toBe('https://cross-exam-git-main-qinsir7.vercel.app/review-service')
    expect(resolveCrossExamApiUrl('https://configured.example/', 'http://localhost:5173')).toBe('https://configured.example')
    expect(resolveCrossExamApiUrl(undefined, 'http://localhost:5173')).toBe('http://localhost:5173')
  })

  it('removes the blocked public API path segment when using the same-origin proxy', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'rj_1', accessToken: 'rjv_owner' }), { status: 201 }))
    const client = new ReviewJobClient({ baseUrl: 'https://www.cross-exam.xyz/review-service', fetchImpl })
    await client.create({ id: 'DP-1', title: 'Review this', valueAtRiskUsd: 100, claims: [{ id: 'C-1', statement: 'A premise.', materiality: 0.8 }] })
    expect(fetchImpl).toHaveBeenCalledWith('https://www.cross-exam.xyz/review-service/v1/review-jobs', expect.objectContaining({ method: 'POST' }))
  })

  it('calls the native fetch through globalThis instead of with the client instance as its receiver', async () => {
    const originalFetch = globalThis.fetch
    const receiverCheckedFetch = vi.fn(function (this: typeof globalThis, _input: RequestInfo | URL, _init?: RequestInit) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(new Response(JSON.stringify({ id: 'rj_1', accessToken: 'rjv_owner' }), { status: 201 }))
    }) as typeof fetch
    globalThis.fetch = receiverCheckedFetch
    try {
      const client = new ReviewJobClient({ baseUrl: 'https://api.example' })
      await expect(client.create({ id: 'DP-1', title: 'Review this', valueAtRiskUsd: 100, claims: [{ id: 'C-1', statement: 'A premise.', materiality: 0.8 }] })).resolves.toMatchObject({ id: 'rj_1' })
      expect(receiverCheckedFetch).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('sends a decision package to the real job endpoint and preserves the returned owner capability', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'rj_11111111-1111-4111-8111-111111111111', accessToken: 'rjv_capability-00000000000000000000000000000000' }), { status: 201 }))
    const client = new ReviewJobClient({ baseUrl: 'https://api.example/', fetchImpl })
    const result = await client.create({ id: 'DP-1', title: 'Review this', valueAtRiskUsd: 100, claims: [{ id: 'C-1', statement: 'A premise.', materiality: 0.8 }] })

    expect(fetchImpl).toHaveBeenCalledWith('https://api.example/api/v1/review-jobs', expect.objectContaining({ method: 'POST' }))
    expect(result.accessToken).toMatch(/^rjv_/)
  })

  it('surfaces a server rejection instead of inventing a queued job', async () => {
    const client = new ReviewJobClient({ fetchImpl: async () => new Response(JSON.stringify({ message: 'No independent reviewer is active.' }), { status: 422 }) })
    await expect(client.create({ id: 'DP-1', title: 'Review this', valueAtRiskUsd: 100, claims: [{ id: 'C-1', statement: 'A premise.', materiality: 0.8 }] })).rejects.toThrow('No independent reviewer')
  })

  it('retrieves the signed result of a completed review job with the owner capability', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: '0.1',
      recordId: 'dar_1234567890abcdef12345678',
      issuedAt: '2026-07-16T00:00:00.000Z',
      attributionStatus: 'NETWORK_VERIFIED',
      decision: { id: 'DP-1' },
      dispatch: { id: 'dispatch-1' },
      result: { action: 'HOLD' },
      persistence: 'CREATED',
      readAccess: { token: 'darv_result', expiresAt: '2026-08-16T00:00:00.000Z' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = new ReviewJobClient({ baseUrl: 'https://api.cross.exam', fetchImpl })

    await expect(client.getResult('rj_1', 'rjv_owner')).resolves.toMatchObject({
      recordId: 'dar_1234567890abcdef12345678',
      attributionStatus: 'NETWORK_VERIFIED',
      persistence: 'CREATED',
    })
    expect(fetchImpl).toHaveBeenCalledWith('https://api.cross.exam/api/v1/review-jobs/rj_1/result', {
      headers: { authorization: 'Bearer rjv_owner' },
    })
  })

  it('delegates paid authorization to a caller-owned x402-capable fetcher', async () => {
    const paymentFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'rj_1', fundingStatus: 'AUTHORIZED' }), { status: 200 }))
    const client = new ReviewJobClient({ baseUrl: 'https://api.cross.exam' })
    await expect(client.authorize('rj_1', 'rjv_owner', paymentFetch)).resolves.toMatchObject({ fundingStatus: 'AUTHORIZED' })
    expect(paymentFetch).toHaveBeenCalledWith('https://api.cross.exam/api/v1/review-jobs/authorize', expect.objectContaining({ method: 'POST' }))
  })
})
