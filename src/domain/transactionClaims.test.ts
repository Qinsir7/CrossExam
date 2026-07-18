import { describe, expect, it } from 'vitest'
import { createTransactionAssuranceAction } from './assuranceAction'
import { compileTransactionClaims } from './transactionClaims'

const token = '0xcccccccccccccccccccccccccccccccccccccccc'

describe('transaction claim compiler', () => {
  it('derives bound liquidity and transfer-safety claims for a token trade', async () => {
    const action = await createTransactionAssuranceAction({
      id: 'AA-CLAIMS-1', title: 'Buy token', valueAtRiskUsd: 5_000, actionType: 'TRADE', chainId: 196,
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', data: '0x', valueWei: '0', tokenRiskTarget: `token:xlayer:${token}`,
    })
    const compiled = compileTransactionClaims(action)

    expect(compiled.claims.map((claim) => claim.id)).toEqual([
      'C-ACTION-BINDING', 'C-EXECUTION-LIQUIDITY', 'C-TOKEN-TRANSFER-SAFETY',
    ])
    expect(compiled.claims.find((claim) => claim.id === 'C-EXECUTION-LIQUIDITY')?.requiredSourceIds).toEqual(['okx-onchainos-liquidity'])
  })

  it('fails closed when router calldata does not identify a token target', async () => {
    const action = await createTransactionAssuranceAction({
      id: 'AA-CLAIMS-2', title: 'Buy through a router', valueAtRiskUsd: 5_000, actionType: 'TRADE', chainId: 196,
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', data: '0x12345678', valueWei: '0',
    })
    const compiled = compileTransactionClaims(action)

    expect(compiled.claims.map((claim) => claim.id)).toContain('C-ASSET-TARGET')
    expect(compiled.limitations[0]).toContain('No token risk target')
  })

  it('recognizes unlimited ERC-20 approvals without attempting to decode unknown calldata', async () => {
    const spender = '000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const max = 'f'.repeat(64)
    const action = await createTransactionAssuranceAction({
      id: 'AA-CLAIMS-3', title: 'Approve token', valueAtRiskUsd: 500, actionType: 'SPEND', chainId: 196,
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', data: `0x095ea7b3${spender}${max}`, valueWei: '0',
    })
    const compiled = compileTransactionClaims(action)

    expect(compiled.inspection.approval).toMatchObject({ kind: 'ERC20_APPROVE', unlimited: true, spender: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(compiled.claims.map((claim) => claim.id)).toContain('C-APPROVAL-SCOPE')
  })
})
