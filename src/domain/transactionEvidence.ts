import type { AssuranceAction, EvidenceObservation } from './assuranceAction'
import type { CompiledTransactionClaim } from './transactionClaims'
import type { Finding } from './types'

export const LIQUIDITY_SOURCE_ID = 'okx-onchainos-liquidity'
export const TOKEN_RISK_SOURCE_ID = 'goplus-xlayer-token-risk'

export type TransactionClaimEvidence = {
  claimId: string
  verdict: Finding['verdict']
  confidence: number
  materiality: number
  explanation: string
  evidenceObservationIds: string[]
}

function numericFact(observation: EvidenceObservation, key: string) {
  const candidate = observation.facts.find((fact) => fact.key === key)?.value
  const value = typeof candidate === 'number' ? candidate : typeof candidate === 'string' ? Number(candidate) : Number.NaN
  return Number.isFinite(value) ? value : undefined
}

function booleanFact(observation: EvidenceObservation, key: string) {
  const value = observation.facts.find((fact) => fact.key === key)?.value
  return typeof value === 'boolean' ? value : value === '1' || value === 'true'
}

function matching(observations: EvidenceObservation[], sourceId: string) {
  return observations.filter((observation) => observation.sourceId === sourceId)
}

function unresolved(claim: CompiledTransactionClaim, explanation: string, evidenceObservationIds: string[] = []): TransactionClaimEvidence {
  return {
    claimId: claim.id,
    verdict: 'INSUFFICIENT_EVIDENCE',
    confidence: 1,
    materiality: claim.materiality,
    explanation,
    evidenceObservationIds,
  }
}

/**
 * Converts only normalized, attributable observations into claim findings.
 * A provider must expose the named fact before policy can use it; absent or
 * ambiguous facts remain unresolved rather than being treated as safe.
 */
export function mapTransactionEvidence(
  action: AssuranceAction,
  claims: CompiledTransactionClaim[],
  observations: EvidenceObservation[],
): TransactionClaimEvidence[] {
  return claims.map((claim) => {
    if (claim.category === 'ACTION_BINDING' || claim.category === 'NATIVE_VALUE_SCOPE') {
      return {
        claimId: claim.id,
        verdict: 'SUPPORTS' as const,
        confidence: 1,
        materiality: claim.materiality,
        explanation: 'CrossExam derived this claim from the canonical action binding supplied for review.',
        evidenceObservationIds: [],
      }
    }

    if (claim.category === 'ASSET_TARGET') {
      return unresolved(claim, 'No explicit token target is bound to this trade, so liquidity and contract-risk providers cannot be safely routed.')
    }

    if (claim.category === 'EXECUTION_LIQUIDITY') {
      const sourceObservations = matching(observations, LIQUIDITY_SOURCE_ID)
      const liquidity = sourceObservations.map((observation) => numericFact(observation, 'liquidity.totalUsd')).find((value) => value !== undefined)
      if (liquidity === undefined) {
        return unresolved(claim, 'No normalized executable-liquidity observation was delivered for the bound asset.', sourceObservations.map((observation) => observation.id))
      }
      const ratio = liquidity / action.valueAtRiskUsd
      if (ratio < 10) {
        return {
          claimId: claim.id,
          verdict: 'CONTRADICTS',
          confidence: 0.9,
          materiality: claim.materiality,
          explanation: `Observed aggregate liquidity of ${liquidity.toFixed(2)} USD is only ${ratio.toFixed(2)}× the reviewed value at risk, below CrossExam's 10× hard floor.`,
          evidenceObservationIds: sourceObservations.map((observation) => observation.id),
        }
      }
      return unresolved(claim, `Observed aggregate liquidity is ${ratio.toFixed(2)}× the reviewed value, but pool liquidity alone does not prove route-specific execution or slippage.`, sourceObservations.map((observation) => observation.id))
    }

    if (claim.category === 'TOKEN_TRANSFER_SAFETY') {
      const sourceObservations = matching(observations, TOKEN_RISK_SOURCE_ID)
      if (!sourceObservations.length) return unresolved(claim, 'No normalized token-security observation was delivered for the bound asset.')
      const criticalFlags = [
        ['tokenRisk.honeypot', 'honeypot behavior'],
        ['tokenRisk.cannotBuy', 'buying disabled'],
        ['tokenRisk.cannotSellAll', 'full selling disabled'],
        ['tokenRisk.blacklist', 'blacklist controls'],
      ] as const
      const triggered: string[] = criticalFlags.filter(([key]) => sourceObservations.some((observation) => booleanFact(observation, key))).map(([, label]) => label)
      const highestTax = Math.max(...sourceObservations.map((observation) => numericFact(observation, 'tokenRisk.maxTax') ?? 0))
      if (highestTax >= 0.5) triggered.push(`tax at ${(highestTax * 100).toFixed(2)}%`)
      if (triggered.length) {
        return {
          claimId: claim.id,
          verdict: 'CONTRADICTS',
          confidence: 0.95,
          materiality: claim.materiality,
          explanation: `Token-security evidence detected material execution risk: ${triggered.join(', ')}.`,
          evidenceObservationIds: sourceObservations.map((observation) => observation.id),
        }
      }
      return unresolved(claim, 'Token-security evidence contains no deterministic critical flag, but absence of a flag is not proof of transfer safety.', sourceObservations.map((observation) => observation.id))
    }

    if (claim.category === 'APPROVAL_SCOPE') {
      const selector = action.evm?.data.slice(0, 10)
      const amountWord = action.evm?.data.slice(74, 138)
      const unlimited = amountWord?.toLowerCase() === 'f'.repeat(64)
      if (unlimited) {
        return {
          claimId: claim.id,
          verdict: 'CONTRADICTS',
          confidence: 1,
          materiality: claim.materiality,
          explanation: `The reviewed calldata uses approval selector ${selector} with a maximum uint256 allowance, which violates CrossExam's default approval policy.`,
          evidenceObservationIds: [],
        }
      }
      return unresolved(claim, 'The transaction contains an approval-shaped call. CrossExam requires an explicit operator/allowance policy before it can permit execution.')
    }

    return unresolved(claim, 'CrossExam has no deterministic evidence policy for this material transaction claim yet.')
  })
}
