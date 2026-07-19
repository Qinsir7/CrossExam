import { keccak256, recoverMessageAddress, stringToHex, type Address } from 'viem'
import type { RemoteDecisionAssuranceRecord } from './crossExamClient'

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

export type RemoteServiceAttestation = {
  scheme: 'EIP191'
  payloadHash: `0x${string}`
  signer: Address
  signature: `0x${string}`
}

export class CrossExamRecordAttestationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CrossExamRecordAttestationError'
  }
}

function attestableRemoteRecord(record: RemoteDecisionAssuranceRecord) {
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

/** Verifies the complete returned record against the issuer published in the service manifest. */
export async function verifyRemoteRecordAttestation(record: RemoteDecisionAssuranceRecord, expectedSigner: Address): Promise<void> {
  const attestation = record.serviceAttestation
  if (!attestation) throw new CrossExamRecordAttestationError('CrossExam record is missing a service attestation.')
  const payloadHash = keccak256(stringToHex(canonicalize(attestableRemoteRecord(record))))
  if (payloadHash !== attestation.payloadHash) throw new CrossExamRecordAttestationError('CrossExam record attestation hash does not match its payload.')
  const signer = await recoverMessageAddress({ message: { raw: payloadHash }, signature: attestation.signature })
  if (signer.toLowerCase() !== attestation.signer.toLowerCase() || signer.toLowerCase() !== expectedSigner.toLowerCase()) {
    throw new CrossExamRecordAttestationError('CrossExam record was not issued by the expected service signer.')
  }
}
