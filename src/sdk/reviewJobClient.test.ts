import { describe, expect, it, vi } from 'vitest'
import { ReviewJobClient, resolveCrossExamApiUrl } from './reviewJobClient'

describe('ReviewJobClient', () => {
  it('uses the same-origin Vercel API proxy for public web deployments', () => {
    expect(resolveCrossExamApiUrl(undefined, 'https://www.cross-exam.xyz')).toBe('https://www.cross-exam.xyz/review-service')
    expect(resolveCrossExamApiUrl('https://stale-preview.example/', 'https://www.cross-exam.xyz')).toBe('https://www.cross-exam.xyz/review-service')
    expect(resolveCrossExamApiUrl(undefined, 'https://cross-exam-git-main-qinsir7.vercel.app')).toBe('https://cross-exam-git-main-qinsir7.vercel.app/review-service')
    expect(resolveCrossExamApiUrl('https://configured.example/', 'http://localhost:5173')).toBe('http://localhost:5173/review-service')
    expect(resolveCrossExamApiUrl(undefined, 'http://localhost:5173')).toBe('http://localhost:5173/review-service')
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

  it('prepares and starts the simple Cross-Examination façade without internal dispatch input', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ canStart: true }), { status: 200 }))
    const client = new ReviewJobClient({ baseUrl: 'https://api.cross.exam', fetchImpl })
    const input = { simple: { title: 'Review a trade', intent: 'Trade only if evidence survives.', valueAtRiskUsd: 5000 } }

    await client.prepareCrossExamination(input)
    await client.startCrossExamination(input)

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://api.cross.exam/api/v1/cross-examinations/prepare', expect.objectContaining({ method: 'POST' }))
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://api.cross.exam/api/v1/cross-examinations', expect.objectContaining({ method: 'POST' }))
  })

  it('requests a read-only exact X Layer transaction quote before any review payment', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ transaction: { chainId: 196 }, route: { protocols: ['DYORSwap'] } }), { status: 200 }))
    const client = new ReviewJobClient({ baseUrl: 'https://api.cross.exam', fetchImpl })
    const input = {
      fromTokenAddress: '0x779ded0c9e1022225f8e0630b35a9b54be713736' as const,
      toTokenAddress: '0x095c1a875b985be6e2c86b2cae0b66a3df702e6a' as const,
      amount: '10000000000', slippagePercent: '0.5', userWalletAddress: '0x1111111111111111111111111111111111111111' as const,
    }

    await expect(client.quoteTransaction(input)).resolves.toMatchObject({ transaction: { chainId: 196 } })
    expect(fetchImpl).toHaveBeenCalledWith('https://api.cross.exam/api/v1/transactions/quote', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }))
  })

  it('extracts an uploaded file and preflights its claims through the additive generic routes', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ filename: 'plan.txt', mediaType: 'text/plain', text: 'A sufficiently detailed plan.', warnings: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ profile: 'PLAN', claimCount: 1, claims: [] }), { status: 200 }))
    const client = new ReviewJobClient({ baseUrl: 'https://api.cross.exam', fetchImpl })
    const file = new File(['A sufficiently detailed plan.'], 'plan.txt', { type: 'text/plain' })

    await expect(client.extractFile(file)).resolves.toMatchObject({ filename: 'plan.txt', mediaType: 'text/plain' })
    await expect(client.preflightReview({ text: 'A sufficiently detailed plan.', profile: 'PLAN' })).resolves.toMatchObject({ profile: 'PLAN' })
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://api.cross.exam/api/v1/intake/files?name=plan.txt', expect.objectContaining({ method: 'POST', body: file }))
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://api.cross.exam/api/v1/reviews/preflight', expect.objectContaining({ method: 'POST' }))
  })

  it('submits record verification with an explicitly pinned issuer', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ signatureValid: true, actionBindingValid: true, gate: { status: 'PERMIT', executable: true, reasons: [], requiredClaimIds: [] } }), { status: 200 }))
    const client = new ReviewJobClient({ baseUrl: 'https://api.cross.exam', fetchImpl })
    const input = {
      record: { recordId: 'dar_123' }, expectedServiceSigner: '0x1111111111111111111111111111111111111111' as const,
      intent: { decisionId: 'DP-1', valueAtRiskUsd: 1, actionType: 'OTHER' as const, target: 'test', parametersHash: '0xabc' },
    }

    await expect(client.verifyAssuranceRecord(input)).resolves.toMatchObject({ signatureValid: true, actionBindingValid: true })
    expect(fetchImpl).toHaveBeenCalledWith('https://api.cross.exam/api/v1/assurance/verify', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }))
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

  it('creates a share link only with the private record capability', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'darshare_test', url: 'https://www.cross-exam.xyz/share/darshare_test' }), { status: 201 }))
    const client = new ReviewJobClient({ baseUrl: 'https://api.cross.exam', fetchImpl })
    await expect(client.createPublicShare('dar_1234567890abcdef12345678', 'darv_private')).resolves.toMatchObject({ token: 'darshare_test' })
    expect(fetchImpl).toHaveBeenCalledWith('https://api.cross.exam/api/v1/assurance/records/dar_1234567890abcdef12345678/share', {
      method: 'POST', headers: { authorization: 'Bearer darv_private' },
    })
  })

  it('delegates paid authorization to a caller-owned x402-capable fetcher', async () => {
    const paymentFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'rj_1', fundingStatus: 'AUTHORIZED' }), { status: 200 }))
    const client = new ReviewJobClient({ baseUrl: 'https://api.cross.exam' })
    await expect(client.authorize('rj_1', 'rjv_owner', paymentFetch)).resolves.toMatchObject({ fundingStatus: 'AUTHORIZED' })
    expect(paymentFetch).toHaveBeenCalledWith('https://api.cross.exam/api/v1/review-jobs/authorize', expect.objectContaining({ method: 'POST' }))
  })

  it('reconciles a confirmed payment response instead of leaving the job unfunded', async () => {
    const transaction = `0x${'a'.repeat(64)}`
    const paymentResponse = btoa(JSON.stringify({ success: true, status: 'success', transaction }))
    const paymentFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'rj_1', fundingStatus: 'UNFUNDED' }), {
      status: 202,
      headers: { 'payment-response': paymentResponse },
    }))
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'rj_1', fundingStatus: 'AUTHORIZED' }), { status: 200 }))
    const client = new ReviewJobClient({ baseUrl: 'https://api.cross.exam', fetchImpl })

    await expect(client.authorize('rj_1', 'rjv_owner', paymentFetch)).resolves.toMatchObject({ fundingStatus: 'AUTHORIZED' })
    expect(fetchImpl).toHaveBeenCalledWith('https://api.cross.exam/api/v1/review-jobs/rj_1/reconcile-funding', expect.objectContaining({
      method: 'POST',
      headers: { authorization: 'Bearer rjv_owner', 'content-type': 'application/json' },
      body: JSON.stringify({ transaction }),
    }))
  })
})
