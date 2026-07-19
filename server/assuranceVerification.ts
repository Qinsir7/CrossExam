import { evaluatePreAction, defaultPreActionPolicy, type ActionIntent, type PreActionDecision, type PreActionPolicy } from '../src/domain/preActionGate'
import type { VerifyAssuranceRecordRequest, VerifyAssuranceRecordResponse } from '../src/domain/assuranceContracts'
import type { DecisionAssuranceRecord } from './assuranceRecord'
import { verifyDecisionAssuranceRecordAttestation } from './serviceAttestation'

function deny(reason: string): PreActionDecision {
  return { status: 'DENY', executable: false, reasons: [reason], requiredClaimIds: [] }
}

function recordInput(value: unknown): DecisionAssuranceRecord {
  if (!value || typeof value !== 'object') throw new Error('A Decision Assurance Record is required.')
  const record = value as Partial<DecisionAssuranceRecord>
  if (record.schemaVersion !== '0.1' || typeof record.recordId !== 'string' || typeof record.issuedAt !== 'string'
    || !record.decision || !record.dispatch || !record.result || !record.serviceAttestation) {
    throw new Error('Record does not have the required signed assurance shape.')
  }
  // Deliberately normalize the envelope: read capabilities, persistence flags,
  // or arbitrary caller properties are not part of the signed record payload.
  return {
    schemaVersion: record.schemaVersion,
    recordId: record.recordId,
    issuedAt: record.issuedAt,
    attributionStatus: record.attributionStatus as DecisionAssuranceRecord['attributionStatus'],
    decision: record.decision as DecisionAssuranceRecord['decision'],
    dispatch: record.dispatch as DecisionAssuranceRecord['dispatch'],
    result: record.result as DecisionAssuranceRecord['result'],
    ...(record.reviewPreflight ? { reviewPreflight: record.reviewPreflight as DecisionAssuranceRecord['reviewPreflight'] } : {}),
    ...(record.adversarialAnalysis ? { adversarialAnalysis: record.adversarialAnalysis as DecisionAssuranceRecord['adversarialAnalysis'] } : {}),
    serviceAttestation: record.serviceAttestation as NonNullable<DecisionAssuranceRecord['serviceAttestation']>,
  }
}

function actionBindingMatches(record: DecisionAssuranceRecord, intent: ActionIntent) {
  const binding = record.decision.actionBinding
  return Boolean(binding && binding.actionType === intent.actionType && binding.target === intent.target && binding.parametersHash === intent.parametersHash)
}

/** Free, stateless verification. It never trusts the record's declared signer as an issuer pin. */
export async function verifyAssuranceRecord(input: VerifyAssuranceRecordRequest): Promise<VerifyAssuranceRecordResponse> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.expectedServiceSigner)) throw new Error('expectedServiceSigner must be a 20-byte EVM address.')
  const record = recordInput(input.record)
  const policy: PreActionPolicy = { ...defaultPreActionPolicy, ...(input.policy ?? {}) }
  const intent = input.intent
  if (!intent || typeof intent.decisionId !== 'string' || !Number.isFinite(intent.valueAtRiskUsd)
    || !['SPEND', 'TRADE', 'DEPLOY', 'PUBLISH', 'OTHER'].includes(intent.actionType)
    || typeof intent.target !== 'string' || typeof intent.parametersHash !== 'string') {
    throw new Error('A complete proposed action intent is required.')
  }
  const actionBindingValid = actionBindingMatches(record, intent)
  try {
    await verifyDecisionAssuranceRecordAttestation(record, input.expectedServiceSigner)
  } catch (error) {
    return { signatureValid: false, actionBindingValid, gate: deny(error instanceof Error ? error.message : 'Record signature is invalid.') }
  }
  const gate = evaluatePreAction({
    recordId: record.recordId,
    issuedAt: record.issuedAt,
    decisionId: record.decision.id,
    valueAtRiskUsd: record.decision.valueAtRiskUsd,
    attributionStatus: record.attributionStatus,
    result: record.result,
    actionBinding: record.decision.actionBinding,
  }, intent, policy)
  return { signatureValid: true, actionBindingValid, gate }
}
