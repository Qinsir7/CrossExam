import { describe, expect, it } from 'vitest'
import { prepareCrossExamination, startCrossExamination } from './crossExamination'
import { withOkxMarketSource } from './reviewerRegistry'
import { validateTransactionPreflightInput } from './transactionPreflight'

const pricing = { authorizationPriceUsd: '0.20', minimumGrossMarginFraction: 0.4 }
const token = '0x2222222222222222222222222222222222222222'
const router = '0x1111111111111111111111111111111111111111'

describe('Deep Cross-Examination façade', () => {
  it('prepares an exact X Layer transaction from simple input and matches only configured real evidence sources', async () => {
    const prepared = await prepareCrossExamination({
      simple: {
        title: 'Buy a reviewed X Layer token',
        intent: 'Buy the specified X Layer token only if liquidity and contract risk survive review.',
        valueAtRiskUsd: 5_000,
        tokenRiskTarget: `token:xlayer:${token}`,
        transaction: { actionType: 'TRADE', chainId: 196, to: router, data: '0x', valueWei: '0' },
      },
    }, withOkxMarketSource({}), pricing)

    expect(prepared.canStart).toBe(true)
    expect(prepared.decision.reviewProfile).toBe('PRETRADE_ONCHAIN')
    expect(prepared.action.binding.target).toBe(`evm:196:${router}`)
    expect(prepared.generatedClaims.map((claim) => claim.id)).toEqual(expect.arrayContaining(['C-ACTION-BINDING', 'C-EXECUTION-LIQUIDITY', 'C-TOKEN-TRANSFER-SAFETY']))
    expect(prepared.evidencePlan).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'execution-liquidity', sourceIds: ['okx-onchainos-liquidity'] }),
      expect.objectContaining({ id: 'contract-token-risk', sourceIds: ['goplus-xlayer-token-risk'] }),
    ]))
    expect(prepared.quote).toMatchObject({ priceUsdt: '0.20', externalEvidenceBudgetUsdt: 0.005 })
  })

  it('refuses to sell a generic investigation when no real independent provider is registered', async () => {
    const input = {
      simple: {
        title: 'Approve a consequential vendor contract',
        intent: 'Approve the contract only if its material factual assumptions are independently supported.',
        valueAtRiskUsd: 20_000,
      },
    }
    const prepared = await prepareCrossExamination(input, {}, pricing)

    expect(prepared.canStart).toBe(false)
    expect(prepared.limitations.join(' ')).toContain('No active independent provider')
    await expect(startCrossExamination(input, {}, pricing)).rejects.toThrow('cannot be purchased')
  })

  it('keeps non-trade transaction scenarios outside the live pretrade purchase path', async () => {
    const input = {
      simple: {
        title: 'Approve a token spender',
        intent: 'Approve the spender only if the approval is safe.',
        valueAtRiskUsd: 5_000,
        transaction: { actionType: 'SPEND' as const, chainId: 196, to: router, data: '0x', valueWei: '0' },
      },
    }
    const prepared = await prepareCrossExamination(input, withOkxMarketSource({}), pricing)

    expect(prepared.canStart).toBe(false)
    expect(prepared.decision.reviewProfile).toBe('GENERAL')
    expect(prepared.limitations.join(' ')).toContain('only exact X Layer token trades')
    await expect(startCrossExamination(input, withOkxMarketSource({}), pricing)).rejects.toThrow('cannot be purchased')
  })

  it('rejects an unsupported direct preflight before a customer can be charged', async () => {
    await expect(validateTransactionPreflightInput({
      title: 'Approve a token spender', actionType: 'SPEND', chainId: 196, to: router, data: '0x', valueWei: '0', valueAtRiskUsd: 5_000,
    })).rejects.toThrow('will not charge')
  })

  it('does not bind a non-X-Layer token label to X Layer evidence', async () => {
    const input = {
      simple: {
        title: 'Buy a token',
        intent: 'Buy only if the token is safe.',
        valueAtRiskUsd: 5_000,
        tokenRiskTarget: `token:eth:${token}`,
        transaction: { actionType: 'TRADE' as const, chainId: 196, to: router, data: '0x', valueWei: '0' },
      },
    }
    const prepared = await prepareCrossExamination(input, withOkxMarketSource({}), pricing)

    expect(prepared.canStart).toBe(false)
    expect(prepared.decision.reviewProfile).toBe('GENERAL')
    await expect(validateTransactionPreflightInput({
      title: 'Buy a token', actionType: 'TRADE', chainId: 196, to: router, data: '0x', valueWei: '0', valueAtRiskUsd: 5_000, tokenRiskTarget: `token:eth:${token}`,
    })).rejects.toThrow('token:xlayer')
  })

  it('creates an unfunded durable pretrade job and returns the existing x402 funding capability', async () => {
    const started = await startCrossExamination({
      simple: {
        title: 'Buy a reviewed X Layer token',
        intent: 'Buy the specified X Layer token only if liquidity and contract risk survive review.',
        valueAtRiskUsd: 5_000,
        tokenRiskTarget: `token:xlayer:${token}`,
        transaction: { actionType: 'TRADE', chainId: 196, to: router, data: '0x', valueWei: '0' },
      },
    }, withOkxMarketSource({}), pricing)

    expect(started.status).toBe('AWAITING_DELIVERIES')
    expect(started.job.fundingStatus).toBe('UNFUNDED')
    expect(started.quote.priceUsdt).toBe('0.20')
    expect(started.authorization).toEqual({
      endpoint: '/api/v1/review-jobs/authorize',
      method: 'POST',
      required: true,
      request: { jobId: started.jobId, accessToken: started.accessToken },
    })
  })
})
