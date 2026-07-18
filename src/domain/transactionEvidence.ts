import type { AssuranceAction, EvidenceObservation } from './assuranceAction'
import type { CompiledTransactionClaim } from './transactionClaims'
import type { Finding } from './types'

export const LIQUIDITY_SOURCE_ID = 'okx-onchainos-liquidity'
export const TOKEN_RISK_SOURCE_ID = 'goplus-xlayer-token-risk'
/**
 * A liquidity result below this ratio is a material contradiction. A result
 * above the support floor only clears CrossExam's deliberately narrow
 * evidence-screening claim; it never promises route-specific slippage.
 */
export const LIQUIDITY_HARD_FLOOR_RATIO = 10
export const LIQUIDITY_SUPPORT_FLOOR_RATIO = 100
export const CRITICAL_TOKEN_TAX_FRACTION = 0.5

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

function optionalBooleanFact(observation: EvidenceObservation, key: string) {
  const value = observation.facts.find((fact) => fact.key === key)?.value
  if (typeof value === 'boolean') return value
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return undefined
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

type SourceAssessment = Pick<TransactionClaimEvidence, 'verdict' | 'confidence' | 'explanation'>

export function assessLiquidityEvidence(totalLiquidityUsd: number | undefined, valueAtRiskUsd: number): SourceAssessment {
  if (totalLiquidityUsd === undefined || !Number.isFinite(valueAtRiskUsd) || valueAtRiskUsd <= 0) {
    return { verdict: 'INSUFFICIENT_EVIDENCE', confidence: 1, explanation: 'No normalized executable-liquidity observation was delivered for the bound asset.' }
  }
  const ratio = totalLiquidityUsd / valueAtRiskUsd
  if (ratio < LIQUIDITY_HARD_FLOOR_RATIO) {
    return {
      verdict: 'CONTRADICTS',
      confidence: 0.9,
      explanation: `Observed aggregate liquidity of ${totalLiquidityUsd.toFixed(2)} USD is only ${ratio.toFixed(2)}× the reviewed value at risk, below CrossExam's ${LIQUIDITY_HARD_FLOOR_RATIO}× hard floor.`,
    }
  }
  if (ratio >= LIQUIDITY_SUPPORT_FLOOR_RATIO) {
    return {
      verdict: 'SUPPORTS',
      confidence: 0.8,
      explanation: `Observed aggregate liquidity of ${totalLiquidityUsd.toFixed(2)} USD is ${ratio.toFixed(2)}× the reviewed value at risk, clearing CrossExam's ${LIQUIDITY_SUPPORT_FLOOR_RATIO}× conservative evidence-screening floor. This does not represent a route-specific slippage guarantee.`,
    }
  }
  return {
    verdict: 'INSUFFICIENT_EVIDENCE',
    confidence: 1,
    explanation: `Observed aggregate liquidity is ${ratio.toFixed(2)}× the reviewed value: above CrossExam's ${LIQUIDITY_HARD_FLOOR_RATIO}× contradiction floor but below its ${LIQUIDITY_SUPPORT_FLOOR_RATIO}× conservative evidence-screening floor.`,
  }
}

export type TokenRiskFacts = {
  honeypot?: boolean
  cannotBuy?: boolean
  cannotSellAll?: boolean
  blacklist?: boolean
  sourceOpen?: boolean
  proxy?: boolean
  creatorHoneypot?: boolean
  buyTax?: number
  sellTax?: number
  transferTax?: number
}

export function assessTokenRiskEvidence(facts: TokenRiskFacts): SourceAssessment {
  const triggered = [
    facts.honeypot ? 'honeypot behavior' : '',
    facts.cannotBuy ? 'buying disabled' : '',
    facts.cannotSellAll ? 'full selling disabled' : '',
    facts.blacklist ? 'blacklist controls' : '',
    facts.sourceOpen === false ? 'contract source is not open' : '',
  ].filter(Boolean)
  const taxes = [facts.buyTax, facts.sellTax, facts.transferTax]
  const validTaxes = taxes.every((value) => value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1)
  const highestTax = validTaxes ? Math.max(...(taxes as number[])) : undefined
  if (highestTax !== undefined && highestTax >= CRITICAL_TOKEN_TAX_FRACTION) triggered.push(`tax at ${(highestTax * 100).toFixed(2)}%`)
  if (triggered.length) {
    return {
      verdict: 'CONTRADICTS',
      confidence: 0.95,
      explanation: `Token-security evidence detected material execution risk: ${triggered.join(', ')}.`,
    }
  }
  const requiredFlags = [facts.honeypot, facts.cannotBuy, facts.cannotSellAll, facts.blacklist, facts.sourceOpen, facts.proxy, facts.creatorHoneypot]
  if (requiredFlags.some((value) => value === undefined) || !validTaxes) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      confidence: 1,
      explanation: 'Token-security evidence is missing one or more required deterministic GoPlus fields, so CrossExam cannot resolve transfer safety.',
    }
  }
  if (facts.proxy) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      confidence: 1,
      explanation: "GoPlus reports an upgradeable proxy contract. CrossExam's current deterministic token adapter does not resolve proxy implementation risk.",
    }
  }
  if (facts.creatorHoneypot) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      confidence: 1,
      explanation: 'GoPlus reports a creator-linked honeypot signal. CrossExam does not treat this ecosystem-level signal as a deterministic transfer restriction, so the claim remains unresolved pending stronger token-specific evidence.',
    }
  }
  return {
    verdict: 'SUPPORTS',
    confidence: 0.85,
    explanation: `GoPlus returned every required deterministic field with no supported critical flag and all reported taxes below CrossExam's ${(CRITICAL_TOKEN_TAX_FRACTION * 100).toFixed(0)}% critical-tax threshold. This is scoped to the adapter's documented checks, not a comprehensive contract audit.`,
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
      const assessments = sourceObservations.map((observation) => assessLiquidityEvidence(numericFact(observation, 'liquidity.totalUsd'), action.valueAtRiskUsd))
      const assessment = assessments.find((item) => item.verdict === 'CONTRADICTS')
        ?? (assessments.length > 0 && assessments.every((item) => item.verdict === 'SUPPORTS') ? assessments[0] : undefined)
        ?? assessLiquidityEvidence(undefined, action.valueAtRiskUsd)
      return { claimId: claim.id, materiality: claim.materiality, evidenceObservationIds: sourceObservations.map((observation) => observation.id), ...assessment }
    }

    if (claim.category === 'TOKEN_TRANSFER_SAFETY') {
      const sourceObservations = matching(observations, TOKEN_RISK_SOURCE_ID)
      if (!sourceObservations.length) return unresolved(claim, 'No normalized token-security observation was delivered for the bound asset.')
      const assessments = sourceObservations.map((observation) => assessTokenRiskEvidence({
        honeypot: optionalBooleanFact(observation, 'tokenRisk.honeypot'),
        cannotBuy: optionalBooleanFact(observation, 'tokenRisk.cannotBuy'),
        cannotSellAll: optionalBooleanFact(observation, 'tokenRisk.cannotSellAll'),
        blacklist: optionalBooleanFact(observation, 'tokenRisk.blacklist'),
        sourceOpen: optionalBooleanFact(observation, 'tokenRisk.sourceOpen'),
        proxy: optionalBooleanFact(observation, 'tokenRisk.proxy'),
        creatorHoneypot: optionalBooleanFact(observation, 'tokenRisk.creatorHoneypot'),
        buyTax: numericFact(observation, 'tokenRisk.buyTax'),
        sellTax: numericFact(observation, 'tokenRisk.sellTax'),
        transferTax: numericFact(observation, 'tokenRisk.transferTax'),
      }))
      const assessment = assessments.find((item) => item.verdict === 'CONTRADICTS')
        ?? (assessments.every((item) => item.verdict === 'SUPPORTS') ? assessments[0] : undefined)
        ?? assessments.find((item) => item.verdict === 'INSUFFICIENT_EVIDENCE')!
      return { claimId: claim.id, materiality: claim.materiality, evidenceObservationIds: sourceObservations.map((observation) => observation.id), ...assessment }
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
