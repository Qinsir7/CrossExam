import { keccak256, recoverMessageAddress, stringToHex, type Address, type Hex } from 'viem'
import { evaluatePreAction } from '../src/domain/preActionGate'
import type { ActionBinding } from '../src/domain/types'
import type { DecisionAssuranceRecord } from './assuranceRecord'

export type ExecutionReceipt = {
  schemaVersion: '0.1'
  recordId: string
  decisionId: string
  executorId: string
  actionBinding: ActionBinding
  status: 'EXECUTED' | 'FAILED' | 'BLOCKED_BY_GATE'
  executedAt: string
  transactionReference?: string
  failureReason?: string
}

export type SignedExecutionReceipt = ExecutionReceipt & {
  attestation: { scheme: 'EIP191'; payloadHash: Hex; signature: Hex }
}

export type ExecutorWalletRegistry = Record<string, Address>

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

export function executionReceiptPayloadHash(receipt: ExecutionReceipt): Hex {
  const { attestation: _attestation, ...payload } = receipt as SignedExecutionReceipt
  return keccak256(stringToHex(canonicalize(payload)))
}

export async function verifyExecutionReceiptAttestation(receipt: SignedExecutionReceipt, executorWallets: ExecutorWalletRegistry): Promise<void> {
  const expectedWallet = executorWallets[receipt.executorId]
  if (!expectedWallet) throw new Error('Executor is not present in the verified wallet registry.')
  const payloadHash = executionReceiptPayloadHash(receipt)
  if (payloadHash !== receipt.attestation.payloadHash) throw new Error('Execution receipt payload hash does not match the submitted receipt.')
  const signer = await recoverMessageAddress({ message: { raw: payloadHash }, signature: receipt.attestation.signature })
  if (signer.toLowerCase() !== expectedWallet.toLowerCase()) throw new Error('Execution receipt signature does not match the verified executor wallet.')
}

/** Binds an execution fact to the exact reviewed action and enforces the recorded gate at execution time. */
export function validateExecutionReceipt(record: DecisionAssuranceRecord, receipt: ExecutionReceipt) {
  if (record.recordId !== receipt.recordId || record.decision.id !== receipt.decisionId) throw new Error('Execution receipt is not bound to this assurance record.')
  const binding = record.decision.actionBinding
  if (!binding || binding.actionType !== receipt.actionBinding.actionType || binding.target !== receipt.actionBinding.target || binding.parametersHash !== receipt.actionBinding.parametersHash) {
    throw new Error('Execution receipt action does not match the reviewed action binding.')
  }
  const executedAt = new Date(receipt.executedAt)
  if (Number.isNaN(executedAt.getTime())) throw new Error('Execution receipt requires a valid execution timestamp.')
  if (receipt.status === 'EXECUTED') {
    if (!receipt.transactionReference?.trim()) throw new Error('An executed action requires a transaction or execution reference.')
    const gate = evaluatePreAction({ recordId: record.recordId, issuedAt: record.issuedAt, decisionId: record.decision.id, valueAtRiskUsd: record.decision.valueAtRiskUsd, attributionStatus: record.attributionStatus, result: record.result, actionBinding: binding }, {
      decisionId: record.decision.id, valueAtRiskUsd: record.decision.valueAtRiskUsd, ...binding,
    }, undefined, executedAt)
    if (!gate.executable) throw new Error(`Execution receipt conflicts with CrossExam gate: ${gate.status}.`)
  }
  if (receipt.status === 'FAILED' && !receipt.failureReason?.trim()) throw new Error('A failed action requires a failure reason.')
}
