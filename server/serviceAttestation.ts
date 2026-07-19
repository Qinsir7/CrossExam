import { keccak256, recoverMessageAddress, stringToHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { DecisionAssuranceRecord } from './assuranceRecord'

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

type AttestableRecord = Omit<DecisionAssuranceRecord, 'serviceAttestation'>

/**
 * Only these persisted record fields are signed. API envelopes may add
 * transport metadata (for example a temporary read capability), which must
 * neither invalidate a real signature nor become accidentally signed.
 */
export function attestableAssuranceRecord(record: DecisionAssuranceRecord): AttestableRecord {
  return {
    schemaVersion: record.schemaVersion,
    recordId: record.recordId,
    issuedAt: record.issuedAt,
    attributionStatus: record.attributionStatus,
    decision: record.decision,
    dispatch: record.dispatch,
    result: record.result,
    ...(record.reviewPreflight ? { reviewPreflight: record.reviewPreflight } : {}),
    ...(record.adversarialAnalysis ? { adversarialAnalysis: record.adversarialAnalysis } : {}),
  }
}

export function assuranceRecordPayloadHash(record: DecisionAssuranceRecord): Hex {
  return keccak256(stringToHex(canonicalize(attestableAssuranceRecord(record))))
}

/** Signs the exact issued record after its content-derived record ID exists. */
export async function attestDecisionAssuranceRecord(record: DecisionAssuranceRecord, privateKey: Hex): Promise<DecisionAssuranceRecord> {
  const account = privateKeyToAccount(privateKey)
  const payloadHash = assuranceRecordPayloadHash(record)
  const signature = await account.signMessage({ message: { raw: payloadHash } })
  return {
    ...record,
    serviceAttestation: { scheme: 'EIP191', payloadHash, signer: account.address, signature },
  }
}

/** Verifies issuer identity and the complete record payload, not just its ID. */
export async function verifyDecisionAssuranceRecordAttestation(record: DecisionAssuranceRecord, expectedSigner?: Address): Promise<void> {
  const attestation = record.serviceAttestation
  if (!attestation) throw new Error('Decision Assurance Record has no service attestation.')
  const computedHash = assuranceRecordPayloadHash(record)
  if (computedHash !== attestation.payloadHash) throw new Error('Service attestation payload hash does not match the record.')
  const signer = await recoverMessageAddress({ message: { raw: computedHash }, signature: attestation.signature })
  if (signer.toLowerCase() !== attestation.signer.toLowerCase()) throw new Error('Service attestation signature does not match its declared signer.')
  if (expectedSigner && signer.toLowerCase() !== expectedSigner.toLowerCase()) throw new Error('Service attestation signer does not match the expected CrossExam issuer.')
}
