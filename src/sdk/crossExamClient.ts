import { evaluatePreAction, type ActionIntent, type AssuredDecision, type PreActionDecision, type PreActionPolicy } from '../domain/preActionGate'
import type { CrossExamResult, DecisionPackage } from '../domain/types'

export type RecordAccess = {
  recordId: string
  token: string
}

export type RemoteDecisionAssuranceRecord = {
  recordId: string
  attributionStatus: AssuredDecision['attributionStatus']
  decision: DecisionPackage
  result: CrossExamResult
}

export class CrossExamRecordAccessError extends Error {
  readonly status: number

  constructor(status: number) {
    super(status === 404 ? 'CrossExam record is unavailable or access has expired.' : `CrossExam record request failed with status ${status}.`)
    this.name = 'CrossExamRecordAccessError'
    this.status = status
  }
}

export class CrossExamClient {
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch

  constructor(options: { baseUrl: string; fetcher?: typeof fetch }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.fetcher = options.fetcher ?? fetch
  }

  async getRecord(access: RecordAccess): Promise<RemoteDecisionAssuranceRecord> {
    const response = await this.fetcher(`${this.baseUrl}/api/v1/assurance/records/${encodeURIComponent(access.recordId)}`, {
      headers: { authorization: `Bearer ${access.token}` },
    })
    if (!response.ok) throw new CrossExamRecordAccessError(response.status)
    const record = await response.json() as RemoteDecisionAssuranceRecord
    if (!record || record.recordId !== access.recordId || !record.decision || !record.result || !record.attributionStatus) {
      throw new Error('CrossExam returned an invalid Decision Assurance Record.')
    }
    return record
  }

  async preflight(access: RecordAccess, intent: ActionIntent, policy?: PreActionPolicy): Promise<PreActionDecision> {
    const record = await this.getRecord(access)
    return evaluatePreAction({
      recordId: record.recordId,
      decisionId: record.decision.id,
      valueAtRiskUsd: record.decision.valueAtRiskUsd,
      attributionStatus: record.attributionStatus,
      result: record.result,
      actionBinding: record.decision.actionBinding,
    }, intent, policy)
  }
}
