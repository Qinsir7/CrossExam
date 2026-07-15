import { createHash } from 'node:crypto'
import type { CrossExamResult, DecisionPackage } from '../src/domain/types'
import type { ReviewDispatch } from '../src/network/reviewNetwork'
import type { Address, Hex } from 'viem'

export type ServiceAttestation = {
  scheme: 'EIP191'
  payloadHash: Hex
  signer: Address
  signature: Hex
}

export type DecisionAssuranceRecord = {
  schemaVersion: '0.1'
  recordId: string
  issuedAt: string
  attributionStatus: 'DECLARED_BY_CALLER' | 'NETWORK_VERIFIED'
  decision: DecisionPackage
  dispatch: ReviewDispatch
  result: CrossExamResult
  serviceAttestation?: ServiceAttestation
}

type RecordPayload = Omit<DecisionAssuranceRecord, 'recordId'>

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`

  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

function recordId(payload: RecordPayload) {
  const hash = createHash('sha256').update(canonicalize(payload)).digest('hex')
  return `dar_${hash.slice(0, 24)}`
}

/**
 * Captures exactly what was submitted, who was declared as reviewer, and what
 * deterministic result followed. The first API version labels attribution as
 * caller-declared; it never implies that CrossExam has independently verified
 * an external ASP identity when it has not.
 */
export function issueDecisionAssuranceRecord(
  decision: DecisionPackage,
  dispatch: ReviewDispatch,
  result: CrossExamResult,
  issuedAt: string,
  attributionStatus: DecisionAssuranceRecord['attributionStatus'] = 'DECLARED_BY_CALLER',
): DecisionAssuranceRecord {
  const payload: RecordPayload = {
    schemaVersion: '0.1',
    issuedAt,
    attributionStatus,
    decision,
    dispatch,
    result,
  }

  return { ...payload, recordId: recordId(payload) }
}
