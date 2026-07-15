import { describe, expect, it, vi } from 'vitest'
import { CrossExamActionBlockedError, CrossExamClient, CrossExamRecordAccessError } from './crossExamClient'
import { createActionBinding } from '../domain/actionBinding'
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

  it('verifies that a fetched record was signed by the expected CrossExam issuer', async () => {
    const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123' as const
    const signed = await attestDecisionAssuranceRecord(record, privateKey)
    const client = new CrossExamClient({ baseUrl: 'https://cross.exam', fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(signed), { status: 200 })) })

    await expect(client.getVerifiedRecord({ recordId: record.recordId, token: 'darv_token' }, privateKeyToAccount(privateKey).address)).resolves.toMatchObject({ recordId: record.recordId })
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
