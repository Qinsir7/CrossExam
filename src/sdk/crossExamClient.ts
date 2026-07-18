import { evaluatePreAction, type ActionIntent, type AssuredDecision, type PreActionDecision, type PreActionPolicy } from '../domain/preActionGate'
import { createActionBinding } from '../domain/actionBinding'
import { canonicalizeEvmTransaction, createEvmActionBinding, type CanonicalEvmTransaction, type EvmActionInput } from '../domain/evmAction'
import type { ActionType, CrossExamResult, DecisionPackage } from '../domain/types'
import type { ReviewDispatch } from '../network/reviewNetwork'
import type { Address } from 'viem'
import { verifyRemoteRecordAttestation, type RemoteServiceAttestation } from './recordAttestation'
import type { VerifyAssuranceRecordResponse } from '../domain/assuranceContracts'

export type RecordAccess = {
  recordId: string
  token: string
}

export type RemoteDecisionAssuranceRecord = {
  schemaVersion: '0.1'
  recordId: string
  issuedAt: string
  attributionStatus: AssuredDecision['attributionStatus']
  decision: DecisionPackage
  dispatch: ReviewDispatch
  result: CrossExamResult
  serviceAttestation?: RemoteServiceAttestation
}

export type BoundActionInput<T> = {
  access: RecordAccess
  decisionId: string
  valueAtRiskUsd: number
  actionType: ActionType
  target: string
  /** Canonical action payload that will be hashed and handed unchanged to the executor. */
  parameters: string
  policy?: PreActionPolicy
  execute: (boundAction: Readonly<Pick<BoundActionInput<T>, 'actionType' | 'target' | 'parameters'>>) => Promise<T> | T
}

export type VerifiedBoundActionInput<T> = BoundActionInput<T> & {
  expectedServiceSigner: Address
}

/**
 * Production execution boundary for an EVM wallet or smart account. The SDK
 * first re-derives the exact reviewed transaction binding, verifies the
 * CrossExam issuer, then exposes only normalized transaction fields to the
 * wallet callback.
 */
export type VerifiedEvmActionInput<T> = Pick<VerifiedBoundActionInput<T>, 'access' | 'decisionId' | 'valueAtRiskUsd' | 'expectedServiceSigner' | 'policy'>
  & EvmActionInput
  & { execute: (transaction: Readonly<CanonicalEvmTransaction>) => Promise<T> | T }

export class CrossExamRecordAccessError extends Error {
  readonly status: number

  constructor(status: number) {
    super(status === 404 ? 'CrossExam record is unavailable or access has expired.' : `CrossExam record request failed with status ${status}.`)
    this.name = 'CrossExamRecordAccessError'
    this.status = status
  }
}

export class CrossExamActionBlockedError extends Error {
  readonly gate: PreActionDecision

  constructor(gate: PreActionDecision) {
    super(`CrossExam prevented execution: ${gate.reasons.join(' ')}`)
    this.name = 'CrossExamActionBlockedError'
    this.gate = gate
  }
}

export class CrossExamClient {
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch

  constructor(options: { baseUrl: string; fetcher?: typeof fetch }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init))
  }

  async getRecord(access: RecordAccess): Promise<RemoteDecisionAssuranceRecord> {
    const response = await this.fetcher(`${this.baseUrl}/api/v1/assurance/records/${encodeURIComponent(access.recordId)}`, {
      headers: { authorization: `Bearer ${access.token}` },
    })
    if (!response.ok) throw new CrossExamRecordAccessError(response.status)
    const record = await response.json() as RemoteDecisionAssuranceRecord
    if (!record || record.recordId !== access.recordId || !record.schemaVersion || !record.issuedAt || !record.decision || !record.dispatch || !record.result || !record.attributionStatus) {
      throw new Error('CrossExam returned an invalid Decision Assurance Record.')
    }
    return record
  }

  async preflight(access: RecordAccess, intent: ActionIntent, policy?: PreActionPolicy): Promise<PreActionDecision> {
    const record = await this.getRecord(access)
    return evaluatePreAction({
      recordId: record.recordId,
      issuedAt: record.issuedAt,
      decisionId: record.decision.id,
      valueAtRiskUsd: record.decision.valueAtRiskUsd,
      attributionStatus: record.attributionStatus,
      result: record.result,
      actionBinding: record.decision.actionBinding,
    }, intent, policy)
  }

  async getVerifiedRecord(access: RecordAccess, expectedServiceSigner: Address): Promise<RemoteDecisionAssuranceRecord> {
    const record = await this.getRecord(access)
    await verifyRemoteRecordAttestation(record, expectedServiceSigner)
    return record
  }

  async preflightVerified(access: RecordAccess, intent: ActionIntent, expectedServiceSigner: Address, policy?: PreActionPolicy): Promise<PreActionDecision> {
    const record = await this.getVerifiedRecord(access, expectedServiceSigner)
    return evaluatePreAction({
      recordId: record.recordId,
      issuedAt: record.issuedAt,
      decisionId: record.decision.id,
      valueAtRiskUsd: record.decision.valueAtRiskUsd,
      attributionStatus: record.attributionStatus,
      result: record.result,
      actionBinding: record.decision.actionBinding,
    }, intent, policy)
  }

  /** Verify a supplied record offline against a caller-pinned issuer and exact proposed action. */
  async verifyRecord(record: RemoteDecisionAssuranceRecord, intent: ActionIntent, expectedServiceSigner: Address, policy?: PreActionPolicy): Promise<VerifyAssuranceRecordResponse> {
    try {
      await verifyRemoteRecordAttestation(record, expectedServiceSigner)
    } catch (error) {
      return {
        signatureValid: false,
        actionBindingValid: Boolean(record.decision?.actionBinding
          && record.decision.actionBinding.actionType === intent.actionType
          && record.decision.actionBinding.target === intent.target
          && record.decision.actionBinding.parametersHash === intent.parametersHash),
        gate: { status: 'DENY', executable: false, reasons: [error instanceof Error ? error.message : 'Record signature is invalid.'], requiredClaimIds: [] },
      }
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
    const binding = record.decision.actionBinding
    return {
      signatureValid: true,
      actionBindingValid: Boolean(binding && binding.actionType === intent.actionType && binding.target === intent.target && binding.parametersHash === intent.parametersHash),
      gate,
    }
  }

  /**
   * Hashes the exact execution payload, applies the assurance gate, then hands
   * the same frozen payload to the external executor. This concentrates the
   * otherwise easy-to-miss pre-action check at the execution boundary.
   */
  async executeBoundAction<T>(input: BoundActionInput<T>): Promise<T> {
    const binding = await createActionBinding(input.actionType, input.target, input.parameters)
    const gate = await this.preflight(input.access, {
      decisionId: input.decisionId,
      valueAtRiskUsd: input.valueAtRiskUsd,
      ...binding,
    }, input.policy)
    if (!gate.executable) throw new CrossExamActionBlockedError(gate)
    return input.execute(Object.freeze({
      actionType: binding.actionType,
      target: binding.target,
      parameters: input.parameters.trim(),
    }))
  }

  /** Production executor path: verify CrossExam's issuer before applying the fresh-record gate. */
  async executeVerifiedBoundAction<T>(input: VerifiedBoundActionInput<T>): Promise<T> {
    const binding = await createActionBinding(input.actionType, input.target, input.parameters)
    const gate = await this.preflightVerified(input.access, {
      decisionId: input.decisionId,
      valueAtRiskUsd: input.valueAtRiskUsd,
      ...binding,
    }, input.expectedServiceSigner, input.policy)
    if (!gate.executable) throw new CrossExamActionBlockedError(gate)
    return input.execute(Object.freeze({
      actionType: binding.actionType,
      target: binding.target,
      parameters: input.parameters.trim(),
    }))
  }

  /**
   * EVM-native variation of executeVerifiedBoundAction. Use this immediately
   * before walletClient.sendTransaction, writeContract, or a smart-account
   * user-operation submission; do not preflight at an earlier UI step.
   */
  async executeVerifiedEvmAction<T>(input: VerifiedEvmActionInput<T>): Promise<T> {
    const transaction = canonicalizeEvmTransaction(input)
    const { actionBinding } = await createEvmActionBinding(input)
    const gate = await this.preflightVerified(input.access, {
      decisionId: input.decisionId,
      valueAtRiskUsd: input.valueAtRiskUsd,
      ...actionBinding,
    }, input.expectedServiceSigner, input.policy)
    if (!gate.executable) throw new CrossExamActionBlockedError(gate)
    return input.execute(Object.freeze(transaction))
  }
}
