import { createHash } from 'node:crypto'
import type { DecisionAssuranceRecord } from './assuranceRecord'
import { issueDecisionAssuranceRecord } from './assuranceRecord'
import type { AggregateAssuranceRequest } from './assuranceService'
import type { ActionBinding, DecisionClaim, DecisionPackage } from '../src/domain/types'
import type { ReviewDispatch } from '../src/network/reviewNetwork'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function text(value: unknown, maximum = 2_000): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized ? normalized.slice(0, maximum) : undefined
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function stableId(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex').slice(0, 16)
}

function normalizeClaims(value: unknown, fallback: string): DecisionClaim[] {
  const candidates = Array.isArray(value) ? value.slice(0, 24) : []
  const claims = candidates.flatMap((candidate, index) => {
    const candidateObject = object(candidate)
    const statement = text(candidateObject?.statement ?? candidateObject?.text ?? candidateObject?.claim ?? candidate)
    if (!statement) return []
    return [{
      id: text(candidateObject?.id, 80) ?? `CLAIM-${index + 1}`,
      statement,
      materiality: Math.min(1, number(candidateObject?.materiality) ?? 1),
    }]
  })
  return claims.length > 0 ? claims : [{ id: 'CLAIM-1', statement: fallback, materiality: 1 }]
}

function normalizeActionBinding(value: unknown): ActionBinding | undefined {
  const candidate = object(value)
  const actionType = candidate?.actionType
  const target = text(candidate?.target, 512)
  const parametersHash = text(candidate?.parametersHash, 66)
  if (!['SPEND', 'TRADE', 'DEPLOY', 'PUBLISH', 'OTHER'].includes(String(actionType))
    || !target || !parametersHash || !/^0x[0-9a-fA-F]{64}$/.test(parametersHash)) return undefined
  return { actionType: actionType as ActionBinding['actionType'], target, parametersHash }
}

function promptFrom(input: JsonObject) {
  const direct = text(input.prompt ?? input.query ?? input.message ?? input.input ?? input.description ?? input.summary)
  if (direct) return direct
  const nestedInput = object(input.input)
  return nestedInput ? text(nestedInput.prompt ?? nestedInput.query ?? nestedInput.message ?? nestedInput.description) : undefined
}

function normalizeDecision(input: unknown): { decision: DecisionPackage; missingContext: boolean } {
  const root = object(input) ?? {}
  const suppliedDecision = object(root.decision)
  const prompt = promptFrom(root)
  const title = text(suppliedDecision?.title ?? suppliedDecision?.summary ?? root.title ?? prompt, 240)
  const missingContext = !title && !Array.isArray(suppliedDecision?.claims ?? root.claims)
  const fallback = missingContext
    ? 'No decision, material claim, or intended action was supplied for examination.'
    : title ?? 'The supplied decision has no explicit material claim.'
  const rawClaims = suppliedDecision?.claims ?? root.claims
  const id = text(suppliedDecision?.id ?? root.id, 96) ?? `DP-INTAKE-${stableId(input)}`
  const actionBinding = normalizeActionBinding(suppliedDecision?.actionBinding ?? root.actionBinding)
  return {
    missingContext,
    decision: {
      id,
      title: title ?? 'Decision context missing',
      valueAtRiskUsd: number(suppliedDecision?.valueAtRiskUsd ?? root.valueAtRiskUsd) ?? 0,
      claims: normalizeClaims(rawClaims, fallback),
      ...(actionBinding ? { actionBinding } : {}),
    },
  }
}

export function isAggregateAssuranceRequest(value: unknown): value is AggregateAssuranceRequest {
  const root = object(value)
  const decision = object(root?.decision)
  const dispatch = object(root?.dispatch)
  return Boolean(decision && dispatch && Array.isArray(decision.claims) && Array.isArray(dispatch.assignments))
}

/**
 * Fail-closed A2MCP intake for callers that do not yet have a delivered review
 * dispatch. It returns a real, deterministic gate result instead of timing out
 * or pretending that caller-supplied material is independently verified.
 */
export function issueAssuranceIntake(input: unknown, issuedAt = new Date().toISOString()): DecisionAssuranceRecord {
  const { decision, missingContext } = normalizeDecision(input)
  const dispatch: ReviewDispatch = {
    id: `RD-INTAKE-${stableId({ decisionId: decision.id, issuedAt })}`,
    decisionId: decision.id,
    status: 'STAGED',
    assignments: [],
  }
  const evidence = missingContext
    ? 'CrossExam cannot release an action without a decision context.'
    : 'No independently delivered evidence dispatch was supplied; caller-provided claims remain unverified.'
  const result = {
    claims: decision.claims.map((claim) => ({
      id: claim.id,
      text: claim.statement,
      verdict: 'UNRESOLVED' as const,
      evidence,
      challenger: 'CrossExam intake gate',
    })),
    action: 'HOLD' as const,
    effectiveIndependence: 0,
    materialRefutations: 0,
    materialUnresolved: decision.claims.filter((claim) => claim.materiality > 0).length,
    reversalConditions: decision.claims.map((claim) => ({
      claimId: claim.id,
      kind: 'RESOLVE_UNCERTAINTY' as const,
      requirement: 'Provide independently attributable evidence and a completed review dispatch for this material claim.',
      basedOnEvidence: evidence,
    })),
  }
  return issueDecisionAssuranceRecord(decision, dispatch, result, issuedAt)
}
