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

  it('resolves only the documented liquidity screen and deterministic GoPlus checks when every required source fact is present', async () => {
    const action = await trade()
    const compiled = compileTransactionClaims(action)
    const evidence = mapTransactionEvidence(action, compiled.claims, [
      {
        id: 'E-LIQUIDITY-SUPPORT', scopeId: 'execution-liquidity', sourceId: 'okx-onchainos-liquidity', sourceOwner: 'okx-onchainos-market', kind: 'AUTHENTICATED_API',
        observedAt: '2026-07-18T00:00:00.000Z', requestHash: '0x1111', responseHash: '0x2222', locator: 'https://example.test/liquidity', addressedClaimIds: ['C-EXECUTION-LIQUIDITY'],
        facts: [{ key: 'liquidity.totalUsd', value: 500_000, unit: 'USD' }],
      },
      {
        id: 'E-TOKEN-SUPPORT', scopeId: 'contract-token-risk', sourceId: 'goplus-xlayer-token-risk', sourceOwner: 'goplus', kind: 'PUBLIC_API',
        observedAt: '2026-07-18T00:00:00.000Z', requestHash: '0x3333', responseHash: '0x4444', locator: 'https://example.test/token-risk', addressedClaimIds: ['C-TOKEN-TRANSFER-SAFETY'],
        facts: [
          { key: 'tokenRisk.honeypot', value: false }, { key: 'tokenRisk.cannotBuy', value: false }, { key: 'tokenRisk.cannotSellAll', value: false },
          { key: 'tokenRisk.blacklist', value: false }, { key: 'tokenRisk.sourceOpen', value: true }, { key: 'tokenRisk.proxy', value: false },
          { key: 'tokenRisk.creatorHoneypot', value: false }, { key: 'tokenRisk.buyTax', value: 0 }, { key: 'tokenRisk.sellTax', value: 0.01 }, { key: 'tokenRisk.transferTax', value: 0 },
        ],
      },
    ])

    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: 'C-ACTION-BINDING', verdict: 'SUPPORTS' }),
      expect.objectContaining({ claimId: 'C-EXECUTION-LIQUIDITY', verdict: 'SUPPORTS' }),
      expect.objectContaining({ claimId: 'C-TOKEN-TRANSFER-SAFETY', verdict: 'SUPPORTS' }),
    ]))
    expect(evaluateTransactionPreflight(action, compiled.claims, evidence, 'PROCUREMENT_VERIFIED')).toMatchObject({ verdict: 'HOLD', canExecute: false })
  })

  it('keeps intermediate liquidity and incomplete or proxy token evidence unresolved', async () => {
    const action = await trade()
    const compiled = compileTransactionClaims(action)
    const evidence = mapTransactionEvidence(action, compiled.claims, [
      {
        id: 'E-LIQUIDITY-MID', scopeId: 'execution-liquidity', sourceId: 'okx-onchainos-liquidity', sourceOwner: 'okx-onchainos-market', kind: 'AUTHENTICATED_API',
        observedAt: '2026-07-18T00:00:00.000Z', requestHash: '0x1111', responseHash: '0x2222', locator: 'https://example.test/liquidity', addressedClaimIds: ['C-EXECUTION-LIQUIDITY'],
        facts: [{ key: 'liquidity.totalUsd', value: 75_000, unit: 'USD' }],
      },
      {
        id: 'E-TOKEN-PROXY', scopeId: 'contract-token-risk', sourceId: 'goplus-xlayer-token-risk', sourceOwner: 'goplus', kind: 'PUBLIC_API',
        observedAt: '2026-07-18T00:00:00.000Z', requestHash: '0x3333', responseHash: '0x4444', locator: 'https://example.test/token-risk', addressedClaimIds: ['C-TOKEN-TRANSFER-SAFETY'],
        facts: [
          { key: 'tokenRisk.honeypot', value: false }, { key: 'tokenRisk.cannotBuy', value: false }, { key: 'tokenRisk.cannotSellAll', value: false },
          { key: 'tokenRisk.blacklist', value: false }, { key: 'tokenRisk.sourceOpen', value: true }, { key: 'tokenRisk.proxy', value: true },
          { key: 'tokenRisk.creatorHoneypot', value: false }, { key: 'tokenRisk.buyTax', value: 0 }, { key: 'tokenRisk.sellTax', value: 0 }, { key: 'tokenRisk.transferTax', value: 0 },
        ],
      },
    ])

    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: 'C-EXECUTION-LIQUIDITY', verdict: 'INSUFFICIENT_EVIDENCE' }),
      expect.objectContaining({ claimId: 'C-TOKEN-TRANSFER-SAFETY', verdict: 'INSUFFICIENT_EVIDENCE' }),
    ]))
  })

  it('contradicts a deterministic token control even if other fields are absent', async () => {
    const action = await trade()
    const compiled = compileTransactionClaims(action)
    const evidence = mapTransactionEvidence(action, compiled.claims, [{
      id: 'E-TOKEN-HONEYPOT', scopeId: 'contract-token-risk', sourceId: 'goplus-xlayer-token-risk', sourceOwner: 'goplus', kind: 'PUBLIC_API',
      observedAt: '2026-07-18T00:00:00.000Z', requestHash: '0x1111', responseHash: '0x2222', locator: 'https://example.test/token-risk', addressedClaimIds: ['C-TOKEN-TRANSFER-SAFETY'],
      facts: [{ key: 'tokenRisk.honeypot', value: true }],
    }])

    expect(evidence).toEqual(expect.arrayContaining([expect.objectContaining({ claimId: 'C-TOKEN-TRANSFER-SAFETY', verdict: 'CONTRADICTS' })]))
    expect(evaluateTransactionPreflight(action, compiled.claims, evidence, 'PROCUREMENT_VERIFIED')).toMatchObject({ verdict: 'BLOCK', canExecute: false, strongestContradiction: { claimId: 'C-TOKEN-TRANSFER-SAFETY' } })
  })

  it('does not mislabel a creator-linked signal as a deterministic transfer restriction', async () => {
    const action = await trade()
    const compiled = compileTransactionClaims(action)
    const evidence = mapTransactionEvidence(action, compiled.claims, [{
      id: 'E-TOKEN-CREATOR-SIGNAL', scopeId: 'contract-token-risk', sourceId: 'goplus-xlayer-token-risk', sourceOwner: 'goplus', kind: 'PUBLIC_API',
      observedAt: '2026-07-18T00:00:00.000Z', requestHash: '0x1111', responseHash: '0x2222', locator: 'https://example.test/token-risk', addressedClaimIds: ['C-TOKEN-TRANSFER-SAFETY'],
      facts: [{ key: 'tokenRisk.creatorHoneypot', value: true }],
    }])

    expect(evidence).toEqual(expect.arrayContaining([expect.objectContaining({ claimId: 'C-TOKEN-TRANSFER-SAFETY', verdict: 'INSUFFICIENT_EVIDENCE' })]))
    expect(evaluateTransactionPreflight(action, compiled.claims, evidence, 'PROCUREMENT_VERIFIED')).toMatchObject({ verdict: 'HOLD', canExecute: false })
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
