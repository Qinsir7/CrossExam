import { describe, expect, it, vi } from 'vitest'
import { ReviewJobClient } from './reviewJobClient'

describe('ReviewJobClient', () => {
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
})
