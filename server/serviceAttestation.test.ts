import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { issueDecisionAssuranceRecord } from './assuranceRecord'
import { attestDecisionAssuranceRecord, verifyDecisionAssuranceRecordAttestation } from './serviceAttestation'
import type { DecisionPackage, CrossExamResult } from '../src/domain/types'
import type { ReviewDispatch } from '../src/network/reviewNetwork'

const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123' as const
const decision: DecisionPackage = { id: 'DP-ISSUER', title: 'Issued record', valueAtRiskUsd: 1, claims: [] }
const dispatch: ReviewDispatch = { id: 'RD-ISSUER', decisionId: decision.id, status: 'DELIVERED', assignments: [] }
const result: CrossExamResult = { claims: [], action: 'PROCEED', effectiveIndependence: 0, materialRefutations: 0, materialUnresolved: 0, reversalConditions: [] }

describe('service record attestation', () => {
  it('verifies the named service issuer over the exact record', async () => {
    const record = issueDecisionAssuranceRecord(decision, dispatch, result, '2026-07-15T00:00:00.000Z')
    const signed = await attestDecisionAssuranceRecord(record, privateKey)

    await expect(verifyDecisionAssuranceRecordAttestation(signed, privateKeyToAccount(privateKey).address)).resolves.toBeUndefined()
  })

  it('rejects a record changed after CrossExam issued it', async () => {
    const record = issueDecisionAssuranceRecord(decision, dispatch, result, '2026-07-15T00:00:00.000Z')
    const signed = await attestDecisionAssuranceRecord(record, privateKey)

    await expect(verifyDecisionAssuranceRecordAttestation({ ...signed, result: { ...signed.result, action: 'HOLD' } })).rejects.toThrow('payload hash')
  })

  it('accepts a signed record returned in an API envelope with unsigned transport fields', async () => {
    const record = issueDecisionAssuranceRecord(decision, dispatch, result, '2026-07-15T00:00:00.000Z')
    const signed = await attestDecisionAssuranceRecord(record, privateKey)
    const envelope = { ...signed, persistence: 'CREATED', readAccess: { token: 'darv_private', expiresAt: '2026-07-16T00:00:00.000Z' } }

    await expect(verifyDecisionAssuranceRecordAttestation(envelope)).resolves.toBeUndefined()
  })
})
