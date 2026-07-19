import { describe, expect, it } from 'vitest'
import { prepareReviewPreflight } from './generalReview'

describe('generic review preflight', () => {
  it('detects and decomposes a legal document without claiming legal verification', () => {
    const result = prepareReviewPreflight({
      text: '上诉状\n依据《中华人民共和国民法典》第五百七十七条，被上诉人应承担违约责任。原审判决因此适用法律错误。请求二审法院撤销原判并改判。',
    })

    expect(result.profile).toBe('LEGAL')
    expect(result.inferredDocumentType).toBe('Appeal brief')
    expect(result.claimCount).toBeGreaterThanOrEqual(2)
    expect(result.verifiableClaimCount).toBeGreaterThan(0)
    expect(result.claims.find((claim) => claim.kind === 'LEGAL_CITATION')).toMatchObject({ verificationRoute: 'SOURCE_REQUIRED' })
    expect(result.limitations[0]).toContain('not marked verified')
  })

  it('marks an exact contract address as tool-ready in the money profile', () => {
    const address = '0x1234567890abcdef1234567890abcdef12345678'
    const result = prepareReviewPreflight({
      text: `I plan to buy this token because liquidity will grow. Contract ${address}. I expect a 30% return within 90 days.`,
      profile: 'MONEY',
    })

    expect(result.detected.contractAddresses).toEqual([address])
    expect(result.claims.some((claim) => claim.kind === 'ONCHAIN_FACT' && claim.verificationRoute === 'TOOL_READY')).toBe(true)
    expect(result.claims.some((claim) => claim.kind === 'QUANTITATIVE')).toBe(true)
  })

  it('turns missing evidence into an explicit request instead of rejecting the review', () => {
    const result = prepareReviewPreflight({
      text: 'We should launch this product next quarter because enterprise demand is strong. The team can deliver the architecture on time, and adoption will grow quickly.',
      profile: 'PLAN',
    })

    expect(result.claims).toHaveLength(2)
    expect(result.claims.every((claim) => typeof claim.evidenceNeeded === 'string')).toBe(true)
  })

  it('rejects empty and oversized input at the boundary', () => {
    expect(() => prepareReviewPreflight({ text: 'too short' })).toThrow(/more detail/)
    expect(() => prepareReviewPreflight({ text: 'A'.repeat(200_001) })).toThrow(/character limit/)
  })
})
