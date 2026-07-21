import { describe, expect, it } from 'vitest'
import type { AdversarialReviewResult } from '../src/domain/generalReview'
import { preparePaidAdversarialReview, type AuthoritativeSourceVerifier } from './adversarialReview'

describe('paid adversarial review record', () => {
  it('persists an honest model-only result and leaves factual claims unresolved', async () => {
    const text = 'We should invest because returns will be 30% within 90 days.'
    const prepared = await preparePaidAdversarialReview({ text, profile: 'MONEY' }, {
      async review(_text, preflight): Promise<AdversarialReviewResult> {
        return {
          verdict: 'UNRESOLVED',
          headline: 'The return premise is not established.',
          strongestAttack: 'There is no source, base rate, or downside case for the predicted return.',
          claims: preflight.claims.map((claim) => ({
            claimId: claim.id,
            verdict: 'UNRESOLVED',
            strongestAttack: 'The number has no demonstrated basis.',
            reasoning: 'The conclusion depends on a future quantitative premise.',
            blindSpot: 'The downside distribution is missing.',
            evidenceNeeded: 'Provide dated primary data and the calculation.',
            verificationStatus: 'REQUIRES_EXTERNAL_SOURCE',
          })),
          blindSpots: ['No downside distribution'],
          nextActions: ['Add dated source data'],
          sources: [],
          provenance: { provider: 'DEEPSEEK', model: 'deepseek-v4-pro', requestHash: `0x${'1'.repeat(64)}`, responseHash: `0x${'2'.repeat(64)}` },
        }
      },
    }, '2026-07-20T00:00:00.000Z')

    expect(prepared.record.attributionStatus).toBe('MODEL_ANALYZED')
    expect(prepared.record.result.action).toBe('CONDITIONAL')
    expect(prepared.record.result.effectiveIndependence).toBe(0)
    expect(prepared.record.adversarialAnalysis?.sources).toEqual([])
    expect(prepared.record.dispatch.assignments[0].reason).toContain('No external factual verification')
  })

  it('runs source retrieval and model analysis concurrently, then keeps their provenance separate', async () => {
    const text = '根据《中华人民共和国民法典》第五百七十七条，对方必须承担违约责任。'
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started: string[] = []
    const provider = {
      async review(_text: string, preflight: Parameters<Parameters<typeof preparePaidAdversarialReview>[1]['review']>[1]): Promise<AdversarialReviewResult> {
        started.push('model')
        await gate
        return {
          verdict: 'UNRESOLVED', headline: 'Application remains unresolved.', strongestAttack: 'The cited rule may not apply to these facts.',
          claims: preflight.claims.map((claim) => ({ claimId: claim.id, verdict: 'UNRESOLVED', strongestAttack: 'Elements are not mapped.', reasoning: 'The rule alone does not establish liability.', blindSpot: 'The factual elements are incomplete.', verificationStatus: 'REQUIRES_EXTERNAL_SOURCE' })),
          blindSpots: ['Missing element mapping'], nextActions: ['Map each element to evidence'], sources: [],
          provenance: { provider: 'DEEPSEEK', model: 'deepseek-v4-pro', requestHash: `0x${'3'.repeat(64)}`, responseHash: `0x${'4'.repeat(64)}` },
        }
      },
    }
    const sourceVerifier = {
      async verify(preflight: Parameters<AuthoritativeSourceVerifier['verify']>[0]) {
        started.push('source')
        await gate
        return [{
          claimId: preflight.claims[0].id, subject: 'LAW' as const, status: 'CURRENT_LAW_CONFIRMED' as const,
          statement: 'Current source status confirmed only.', checkedAt: '2026-07-22T00:00:00.000Z', provider: 'TAVILY' as const,
          authorityDomains: ['flk.npc.gov.cn'], requestHash: `0x${'5'.repeat(64)}` as const, responseHash: `0x${'6'.repeat(64)}` as const,
          source: { label: '中华人民共和国民法典', url: 'https://flk.npc.gov.cn/detail2.html', authorityDomain: 'flk.npc.gov.cn', excerpt: '效力状态：有效' },
        }]
      },
    }

    const pending = preparePaidAdversarialReview({ text, profile: 'LEGAL' }, provider, '2026-07-22T00:00:00.000Z', sourceVerifier)
    await Promise.resolve()
    expect(started.sort()).toEqual(['model', 'source'])
    release()
    const prepared = await pending

    expect(prepared.analysis.claims[0]).toMatchObject({ verdict: 'UNRESOLVED', verificationStatus: 'AUTHORITATIVE_SOURCE_PARTIAL' })
    expect(prepared.analysis.sources[0]).toMatchObject({ authorityDomain: 'flk.npc.gov.cn', status: 'CURRENT_LAW_CONFIRMED' })
    expect(prepared.record.dispatch.assignments).toHaveLength(2)
  })
})
