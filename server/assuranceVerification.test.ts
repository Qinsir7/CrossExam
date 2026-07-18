import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { issueDecisionAssuranceRecord } from './assuranceRecord'
import { attestDecisionAssuranceRecord } from './serviceAttestation'
import { verifyAssuranceRecord } from './assuranceVerification'

const signingKey = '0x0123456789012345678901234567890123456789012345678901234567890123' as const
const signer = privateKeyToAccount(signingKey)

async function signedRecord() {
  return attestDecisionAssuranceRecord(issueDecisionAssuranceRecord({
    id: 'DP-VERIFY', title: 'Bound trade', valueAtRiskUsd: 100,
    actionBinding: { actionType: 'TRADE', target: 'evm:196:0x1111111111111111111111111111111111111111', parametersHash: '0xbound' },
    claims: [],
  }, { id: 'RD-VERIFY', decisionId: 'DP-VERIFY', status: 'DELIVERED', assignments: [] }, {
    claims: [], action: 'PROCEED', effectiveIndependence: 1, materialRefutations: 0, materialUnresolved: 0, reversalConditions: [],
  }, new Date().toISOString(), 'NETWORK_VERIFIED'), signingKey)
}

describe('verifyAssuranceRecord', () => {
  it('verifies a pinned issuer and exact action binding', async () => {
    const record = await signedRecord()
    await expect(verifyAssuranceRecord({ record, expectedServiceSigner: signer.address, intent: {
      decisionId: 'DP-VERIFY', valueAtRiskUsd: 100, actionType: 'TRADE', target: 'evm:196:0x1111111111111111111111111111111111111111', parametersHash: '0xbound',
    } })).resolves.toMatchObject({ signatureValid: true, actionBindingValid: true, gate: { status: 'PERMIT', executable: true } })
  })

  it('rejects an untrusted issuer and reports a mismatched proposed action', async () => {
    const record = await signedRecord()
    const result = await verifyAssuranceRecord({ record, expectedServiceSigner: '0x2222222222222222222222222222222222222222', intent: {
      decisionId: 'DP-VERIFY', valueAtRiskUsd: 100, actionType: 'TRADE', target: 'evm:196:0x2222222222222222222222222222222222222222', parametersHash: '0xsubstituted',
    } })
    expect(result).toMatchObject({ signatureValid: false, actionBindingValid: false, gate: { status: 'DENY', executable: false } })
  })

  it('verifies the signed portion of a real API result without trusting its transport metadata', async () => {
    const record = await signedRecord()
    await expect(verifyAssuranceRecord({ record: { ...record, persistence: 'CREATED', readAccess: { token: 'darv_private' } }, expectedServiceSigner: signer.address, intent: {
      decisionId: 'DP-VERIFY', valueAtRiskUsd: 100, actionType: 'TRADE', target: 'evm:196:0x1111111111111111111111111111111111111111', parametersHash: '0xbound',
    } })).resolves.toMatchObject({ signatureValid: true, actionBindingValid: true })
  })
})
