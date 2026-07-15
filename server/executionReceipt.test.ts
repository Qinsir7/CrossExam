import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { issueDecisionAssuranceRecord } from './assuranceRecord'
import { executionReceiptPayloadHash, validateExecutionReceipt, verifyExecutionReceiptAttestation, type SignedExecutionReceipt } from './executionReceipt'
import type { CrossExamResult, DecisionPackage } from '../src/domain/types'
import type { ReviewDispatch } from '../src/network/reviewNetwork'

const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123' as const
const account = privateKeyToAccount(privateKey)
const decision: DecisionPackage = {
  id: 'DP-EXECUTION', title: 'Execute', valueAtRiskUsd: 500,
  actionBinding: { actionType: 'TRADE', target: 'dex:demo', parametersHash: '0xbound' }, claims: [],
}
const dispatch: ReviewDispatch = { id: 'RD-EXECUTION', decisionId: decision.id, status: 'DELIVERED', assignments: [] }
const result: CrossExamResult = { claims: [], action: 'PROCEED', effectiveIndependence: 1, materialRefutations: 0, materialUnresolved: 0, reversalConditions: [] }

async function receipt(recordId: string): Promise<SignedExecutionReceipt> {
  const unsigned = {
    schemaVersion: '0.1' as const, recordId,
    decisionId: decision.id, executorId: 'trade-executor', actionBinding: decision.actionBinding!, status: 'EXECUTED' as const,
    executedAt: '2026-07-15T00:01:00.000Z', transactionReference: 'xlayer://tx/0xexecuted',
  }
  const payloadHash = executionReceiptPayloadHash(unsigned)
  return { ...unsigned, attestation: { scheme: 'EIP191', payloadHash, signature: await account.signMessage({ message: { raw: payloadHash } }) } }
}

describe('execution receipt', () => {
  it('accepts a registered executor receipt only for the exact permitted action', async () => {
    const record = issueDecisionAssuranceRecord(decision, dispatch, result, '2026-07-15T00:00:00.000Z', 'NETWORK_VERIFIED')
    const signed = await receipt(record.recordId)

    await expect(verifyExecutionReceiptAttestation(signed, { 'trade-executor': account.address })).resolves.toBeUndefined()
    expect(() => validateExecutionReceipt(record, signed)).not.toThrow()
  })

  it('rejects execution when the reviewed record was not executable', async () => {
    const held = issueDecisionAssuranceRecord(decision, dispatch, { ...result, action: 'HOLD' }, '2026-07-15T00:00:00.000Z', 'NETWORK_VERIFIED')
    const signed = await receipt(held.recordId)

    expect(() => validateExecutionReceipt(held, signed)).toThrow('conflicts with CrossExam gate')
  })
})
