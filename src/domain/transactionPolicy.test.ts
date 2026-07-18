import { describe, expect, it } from 'vitest'
import { createTransactionAssuranceAction } from './assuranceAction'
import { compileTransactionClaims } from './transactionClaims'
import { mapTransactionEvidence, type TransactionClaimEvidence } from './transactionEvidence'
import { evaluateTransactionPreflight } from './transactionPolicy'

const token = '0xcccccccccccccccccccccccccccccccccccccccc'

async function trade() {
  return createTransactionAssuranceAction({
    id: 'AA-POLICY-1', title: 'Buy token', valueAtRiskUsd: 5_000, actionType: 'TRADE', chainId: 196,
    to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', data: '0x', valueWei: '0', tokenRiskTarget: `token:xlayer:${token}`,
  })
}

describe('transaction evidence mapping and policy', () => {
  it('blocks a trade when real-shaped liquidity evidence contradicts the reviewed size', async () => {
    const action = await trade()
    const compiled = compileTransactionClaims(action)
    const evidence = mapTransactionEvidence(action, compiled.claims, [{
      id: 'E-LIQUIDITY', scopeId: 'execution-liquidity', sourceId: 'okx-onchainos-liquidity', sourceOwner: 'okx-onchainos-market', kind: 'AUTHENTICATED_API',
      observedAt: '2026-07-18T00:00:00.000Z', requestHash: '0x1111', responseHash: '0x2222', locator: 'https://example.test/liquidity', addressedClaimIds: ['C-EXECUTION-LIQUIDITY'],
      facts: [{ key: 'liquidity.totalUsd', value: 1_000 }],
    }])
    const verdict = evaluateTransactionPreflight(action, compiled.claims, evidence, 'PROCUREMENT_VERIFIED')

    expect(verdict).toMatchObject({ verdict: 'BLOCK', canExecute: false, strongestContradiction: { claimId: 'C-EXECUTION-LIQUIDITY' } })
  })

  it('holds when no independent evidence was delivered, even though action binding is valid', async () => {
    const action = await trade()
    const compiled = compileTransactionClaims(action)
    const evidence = mapTransactionEvidence(action, compiled.claims, [])
    const verdict = evaluateTransactionPreflight(action, compiled.claims, evidence, 'PROCUREMENT_VERIFIED')

    expect(verdict).toMatchObject({ verdict: 'HOLD', canExecute: false })
    expect(verdict.reasons.join(' ')).toContain('No normalized executable-liquidity')
  })

  it('blocks an unlimited approval before an executor can send it', async () => {
    const max = 'f'.repeat(64)
    const action = await createTransactionAssuranceAction({
      id: 'AA-POLICY-2', title: 'Approve token', valueAtRiskUsd: 500, actionType: 'SPEND', chainId: 196,
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', data: `0x095ea7b3${'0'.repeat(24)}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${max}`, valueWei: '0',
    })
    const compiled = compileTransactionClaims(action)
    const evidence = mapTransactionEvidence(action, compiled.claims, [])
    const verdict = evaluateTransactionPreflight(action, compiled.claims, evidence, 'DECLARED_BY_CALLER')

    expect(verdict).toMatchObject({ verdict: 'BLOCK', canExecute: false, strongestContradiction: { claimId: 'C-APPROVAL-SCOPE' } })
  })

  it('requires network verification before permitting a high-value fully-supported action', async () => {
    const action = await createTransactionAssuranceAction({
      id: 'AA-POLICY-3', title: 'Send native value', valueAtRiskUsd: 5_000, actionType: 'SPEND', chainId: 196,
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', data: '0x', valueWei: '1',
    })
    const compiled = compileTransactionClaims(action)
    const supported: TransactionClaimEvidence[] = compiled.claims.map((claim) => ({
      claimId: claim.id, verdict: 'SUPPORTS', confidence: 1, materiality: 1, explanation: 'Independent policy evidence satisfied this claim.', evidenceObservationIds: [],
    }))

    expect(evaluateTransactionPreflight(action, compiled.claims, supported, 'PROCUREMENT_VERIFIED')).toMatchObject({ verdict: 'HOLD', canExecute: false })
    expect(evaluateTransactionPreflight(action, compiled.claims, supported, 'NETWORK_VERIFIED')).toMatchObject({ verdict: 'PERMIT', canExecute: true })
  })
})
