import { describe, expect, it, vi } from 'vitest'
import { CrossExamClient, CrossExamRecordAccessError } from './crossExamClient'

const record = {
  recordId: 'dar_1234567890abcdef12345678',
  attributionStatus: 'NETWORK_VERIFIED' as const,
  decision: { id: 'DP-1', title: 'Execute', valueAtRiskUsd: 2000, claims: [], actionBinding: { actionType: 'TRADE' as const, target: 'dex:demo', parametersHash: '0xdemo' } },
  result: { claims: [], action: 'PROCEED' as const, effectiveIndependence: 2.7, materialRefutations: 0, materialUnresolved: 0, reversalConditions: [] },
}

describe('CrossExamClient', () => {
  it('retrieves a protected record using its bearer token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(record), { status: 200 }))
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam/', fetcher })

    await expect(client.getRecord({ recordId: record.recordId, token: 'darv_token' })).resolves.toEqual(record)
    expect(fetcher).toHaveBeenCalledWith('https://cross.exam/api/v1/assurance/records/dar_1234567890abcdef12345678', {
      headers: { authorization: 'Bearer darv_token' },
    })
  })

  it('turns a fetched record into an executable preflight decision', async () => {
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam', fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(record), { status: 200 })) })

    await expect(client.preflight({ recordId: record.recordId, token: 'darv_token' }, { decisionId: 'DP-1', valueAtRiskUsd: 2000, actionType: 'TRADE', target: 'dex:demo', parametersHash: '0xdemo' })).resolves.toMatchObject({
      status: 'PERMIT', executable: true,
    })
  })

  it('does not conceal expired or unauthorized access', async () => {
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam', fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })) })

    await expect(client.getRecord({ recordId: record.recordId, token: 'expired' })).rejects.toEqual(expect.objectContaining({
      name: 'CrossExamRecordAccessError', status: 404,
    } satisfies Partial<CrossExamRecordAccessError>))
  })
})
