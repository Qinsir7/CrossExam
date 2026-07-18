import { describe, expect, it } from 'vitest'
import { createTransactionAssuranceAction, toDecisionPackage } from './assuranceAction'
import { createEvmActionBinding } from './evmAction'

const transaction = {
  id: 'AA-TRADE-1',
  title: 'Buy a token on X Layer',
  valueAtRiskUsd: 5_000,
  intent: 'Buy TOKEN with 5,000 USDT only if executable liquidity and transfer safety survive independent review.',
  actionType: 'TRADE' as const,
  chainId: 196,
  from: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  to: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  data: '0xAABB',
  valueWei: '0',
  tokenRiskTarget: 'token:xlayer:0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
}

describe('AssuranceAction', () => {
  it('uses the exact existing EVM binding rather than a parallel action hash', async () => {
    const action = await createTransactionAssuranceAction(transaction)
    const existingBinding = await createEvmActionBinding(transaction)

    expect(action.kind).toBe('TRANSACTION')
    expect(action.binding).toEqual(existingBinding.actionBinding)
    expect(action.evm).toEqual({
      chainId: 196,
      from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      data: '0xaabb',
      valueWei: '0',
    })
    expect(action.reviewEvidenceContext).toEqual(existingBinding.reviewEvidenceContext)
  })

  it('maps explicit material claims into the existing durable DecisionPackage contract', async () => {
    const action = await createTransactionAssuranceAction(transaction)
    const decision = toDecisionPackage(action, [
      { id: 'C-LIQUIDITY', statement: 'Executable liquidity can absorb the intended order size.', materiality: 1 },
      { id: 'C-TRANSFER', statement: 'The token can be transferred as expected after purchase.', materiality: 1 },
    ], 'PRETRADE_ONCHAIN')

    expect(decision).toMatchObject({
      id: 'DP-TRADE-1',
      title: transaction.title,
      valueAtRiskUsd: 5_000,
      actionBinding: action.binding,
      reviewEvidenceContext: { tokenRiskTarget: 'token:xlayer:0xcccccccccccccccccccccccccccccccccccccccc' },
      reviewProfile: 'PRETRADE_ONCHAIN',
    })
  })

  it('rejects malformed sender addresses and duplicate claim IDs before a review can begin', async () => {
    await expect(createTransactionAssuranceAction({ ...transaction, from: 'not-an-address' })).rejects.toThrow('EVM sender')
    const action = await createTransactionAssuranceAction(transaction)
    expect(() => toDecisionPackage(action, [
      { id: 'C-1', statement: 'First', materiality: 1 },
      { id: 'C-1', statement: 'Second', materiality: 1 },
    ])).toThrow('unique')
  })
})
