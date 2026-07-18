import { describe, expect, it, vi } from 'vitest'
import { CrossExamActionBlockedError, CrossExamApiError, CrossExamClient, CrossExamRecordAccessError } from './crossExamClient'
import { createActionBinding } from '../domain/actionBinding'
import { createEvmActionBinding } from '../domain/evmAction'
import { privateKeyToAccount } from 'viem/accounts'
import { attestDecisionAssuranceRecord } from '../../server/serviceAttestation'

const record = {
  schemaVersion: '0.1' as const,
  recordId: 'dar_1234567890abcdef12345678',
  issuedAt: new Date().toISOString(),
  attributionStatus: 'NETWORK_VERIFIED' as const,
  decision: { id: 'DP-1', title: 'Execute', valueAtRiskUsd: 2000, claims: [], actionBinding: { actionType: 'TRADE' as const, target: 'dex:demo', parametersHash: '0xdemo' } },
  dispatch: { id: 'RD-1', decisionId: 'DP-1', status: 'DELIVERED' as const, assignments: [] },
  result: { claims: [], action: 'PROCEED' as const, effectiveIndependence: 2.7, materialRefutations: 0, materialUnresolved: 0, reversalConditions: [] },
}

describe('CrossExamClient', () => {
  it('preserves the native fetch receiver when no custom fetcher is supplied', async () => {
    const originalFetch = globalThis.fetch
    const receiverCheckedFetch = vi.fn(function (this: typeof globalThis, _input: RequestInfo | URL, _init?: RequestInit) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(new Response(JSON.stringify(record), { status: 200 }))
    }) as typeof fetch
    globalThis.fetch = receiverCheckedFetch
    try {
      const client = new CrossExamClient({ baseUrl: 'https://cross.exam' })
      await expect(client.getRecord({ recordId: record.recordId, token: 'darv_token' })).resolves.toMatchObject({ recordId: record.recordId })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retrieves a protected record using its bearer token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(record), { status: 200 }))
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam/', fetcher })

    await expect(client.getRecord({ recordId: record.recordId, token: 'darv_token' })).resolves.toEqual(record)
    expect(fetcher).toHaveBeenCalledWith('https://cross.exam/api/v1/assurance/records/dar_1234567890abcdef12345678', {
      headers: { authorization: 'Bearer darv_token' },
    })
  })

  it('exposes the product endpoints through ergonomic SDK methods and preserves idempotency', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ canStart: true }), { status: 200 }))
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam', fetcher })

    await client.prepareAction({ simple: { title: 'Review', intent: 'Check this action.', valueAtRiskUsd: 1 } })
    await client.startDeepReview({ simple: { title: 'Review', intent: 'Check this action.', valueAtRiskUsd: 1 }, idempotencyKey: 'deep-review-1' })
    await client.preflightTransaction({ title: 'Trade', intent: 'Trade safely.', valueAtRiskUsd: 1, actionType: 'TRADE', chainId: 196, to: '0x1111111111111111111111111111111111111111', data: '0x', idempotencyKey: 'preflight-1' })
    await client.checkAsp({ endpoint: 'https://agent.example', valueAtRiskUsd: 1, idempotencyKey: 'asp-1' })
    await client.getReview('rj_1', 'rjv_owner')

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://cross.exam/api/v1/cross-examinations/prepare',
      'https://cross.exam/api/v1/cross-examinations',
      'https://cross.exam/api/v1/preflight/transaction',
      'https://cross.exam/api/v1/preflight/asp',
      'https://cross.exam/api/v1/review-jobs/rj_1',
    ])
    expect(fetcher.mock.calls[1][1]).toMatchObject({ headers: { 'idempotency-key': 'deep-review-1' } })
    expect(fetcher.mock.calls[4][1]).toMatchObject({ headers: { authorization: 'Bearer rjv_owner' } })
  })

  it('preserves API status and a safe server message for product endpoint failures', async () => {
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam', fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: 'No real source matches this action.' }), { status: 422 })) })
    await expect(client.prepareAction({ simple: { title: 'Review', intent: 'Check this action.', valueAtRiskUsd: 1 } })).rejects.toEqual(expect.objectContaining({
      name: 'CrossExamApiError', status: 422, message: 'No real source matches this action.',
    } satisfies Partial<CrossExamApiError>))
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

  it('verifies that a fetched record was signed by the expected CrossExam issuer', async () => {
    const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123' as const
    const signed = await attestDecisionAssuranceRecord(record, privateKey)
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam', fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(signed), { status: 200 })) })

    await expect(client.getVerifiedRecord({ recordId: record.recordId, token: 'darv_token' }, privateKeyToAccount(privateKey).address)).resolves.toMatchObject({ recordId: record.recordId })
  })

  it('verifies a supplied record offline against a pinned issuer and exact action', async () => {
    const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123' as const
    const signed = await attestDecisionAssuranceRecord(record, privateKey)
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam' })
    await expect(client.verifyRecord(signed, {
      decisionId: 'DP-1', valueAtRiskUsd: 2000, actionType: 'TRADE', target: 'dex:demo', parametersHash: '0xdemo',
    }, privateKeyToAccount(privateKey).address)).resolves.toMatchObject({ signatureValid: true, actionBindingValid: true, gate: { executable: true } })
  })

  it('verifies a job-result envelope without including its private access capability in the signed payload', async () => {
    const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123' as const
    const signed = await attestDecisionAssuranceRecord(record, privateKey)
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam' })
    const envelope = { ...signed, persistence: 'CREATED' as const, readAccess: { token: 'darv_private', expiresAt: '2026-08-01T00:00:00.000Z' } }
    await expect(client.verifyRecord(envelope, {
      decisionId: 'DP-1', valueAtRiskUsd: 2000, actionType: 'TRADE', target: 'dex:demo', parametersHash: '0xdemo',
    }, privateKeyToAccount(privateKey).address)).resolves.toMatchObject({ signatureValid: true, actionBindingValid: true })
  })

  it('hands the exact payload to an executor only after a matching assurance preflight', async () => {
    const parameters = '{"side":"buy","amount":"1"}'
    const binding = await createActionBinding('TRADE', 'dex:demo', parameters)
    const boundRecord = { ...record, decision: { ...record.decision, actionBinding: binding } }
    const execute = vi.fn().mockResolvedValue({ txHash: '0xexecuted' })
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam', fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(boundRecord), { status: 200 })) })

    await expect(client.executeBoundAction({
      access: { recordId: record.recordId, token: 'darv_token' }, decisionId: 'DP-1', valueAtRiskUsd: 2000,
      actionType: 'TRADE', target: 'dex:demo', parameters, execute,
    })).resolves.toEqual({ txHash: '0xexecuted' })
    expect(execute).toHaveBeenCalledWith({ actionType: 'TRADE', target: 'dex:demo', parameters })
  })

  it('requires the expected CrossExam issuer before calling a production executor', async () => {
    const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123' as const
    const parameters = '{"side":"buy","amount":"1"}'
    const actionBinding = await createActionBinding('TRADE', 'dex:demo', parameters)
    const signed = await attestDecisionAssuranceRecord({ ...record, decision: { ...record.decision, actionBinding } }, privateKey)
    const execute = vi.fn().mockResolvedValue({ txHash: '0xverified' })
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam', fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(signed), { status: 200 })) })

    await expect(client.executeVerifiedBoundAction({
      access: { recordId: record.recordId, token: 'darv_token' }, expectedServiceSigner: privateKeyToAccount(privateKey).address,
      decisionId: 'DP-1', valueAtRiskUsd: 2000, actionType: 'TRADE', target: 'dex:demo', parameters, execute,
    })).resolves.toEqual({ txHash: '0xverified' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('only exposes a canonical EVM transaction to a verified production executor', async () => {
    const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123' as const
    const input = { actionType: 'TRADE' as const, chainId: 196, to: '0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', data: '0xAABB', valueWei: '0' }
    const { actionBinding } = await createEvmActionBinding(input)
    const signed = await attestDecisionAssuranceRecord({ ...record, decision: { ...record.decision, actionBinding } }, privateKey)
    const execute = vi.fn().mockResolvedValue({ txHash: '0xevm' })
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam', fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(signed), { status: 200 })) })

    await expect(client.executeVerifiedEvmAction({
      access: { recordId: record.recordId, token: 'darv_token' }, expectedServiceSigner: privateKeyToAccount(privateKey).address,
      decisionId: 'DP-1', valueAtRiskUsd: 2000, ...input, execute,
    })).resolves.toEqual({ txHash: '0xevm' })
    expect(execute).toHaveBeenCalledWith({ chainId: 196, to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', data: '0xaabb', valueWei: '0' })
  })

  it('does not call the executor when the payload differs from the reviewed binding', async () => {
    const execute = vi.fn()
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam', fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(record), { status: 200 })) })

    await expect(client.executeBoundAction({
      access: { recordId: record.recordId, token: 'darv_token' }, decisionId: 'DP-1', valueAtRiskUsd: 2000,
      actionType: 'TRADE', target: 'dex:demo', parameters: '{"side":"sell"}', execute,
    })).rejects.toBeInstanceOf(CrossExamActionBlockedError)
    expect(execute).not.toHaveBeenCalled()
  })
})
