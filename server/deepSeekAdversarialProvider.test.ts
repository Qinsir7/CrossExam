import { describe, expect, it, vi } from 'vitest'
import { prepareReviewPreflight } from '../src/domain/generalReview'
import { DeepSeekAdversarialProvider } from './deepSeekAdversarialProvider'

const config = { apiKey: ['sk', 'test', 'not-a-real-key', '1234567890'].join('-'), baseUrl: 'https://api.deepseek.com' as const, model: 'deepseek-v4-pro' }

describe('DeepSeek adversarial provider', () => {
  it('returns bounded reasoning and forces externally verifiable claims unresolved', async () => {
    const preflight = prepareReviewPreflight({ text: 'We should invest because returns will reach 30% within 90 days. Contract 0x1234567890abcdef1234567890abcdef12345678.', profile: 'MONEY' })
    const claims = preflight.claims.map((claim) => ({ claimId: claim.id, verdict: 'SURVIVED', strongestAttack: 'The base rate is absent.', reasoning: 'The inference depends on an untested growth assumption.', blindSpot: 'No adverse case is quantified.', evidenceNeeded: 'Provide current primary data.' }))
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'response-1', choices: [{ message: { content: JSON.stringify({ headline: 'Not proven', strongestAttack: 'The return assumption is unsupported.', claims, blindSpots: ['Base rate missing'], nextActions: ['Obtain current evidence'] }) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200 }))
    const result = await new DeepSeekAdversarialProvider(config, fetchImpl).review('We should invest because returns will reach 30% within 90 days. Contract 0x1234567890abcdef1234567890abcdef12345678.', preflight)

    expect(result.verdict).toBe('UNRESOLVED')
    expect(result.claims.some((claim) => claim.verificationStatus === 'TOOL_CHECK_REQUIRED' && claim.verdict === 'UNRESOLVED')).toBe(true)
    expect(result.sources).toEqual([])
    expect(result.provenance).toMatchObject({ provider: 'DEEPSEEK', model: 'deepseek-v4-pro', inputTokens: 100 })
    expect(fetchImpl).toHaveBeenCalledWith('https://api.deepseek.com/chat/completions', expect.objectContaining({ method: 'POST' }))
  })

  it('accepts a logical refutation only for argument-only claims', async () => {
    const text = 'We must launch both before and after the same fixed deadline, and neither schedule can change. Therefore the plan is feasible.'
    const preflight = prepareReviewPreflight({ text, profile: 'PLAN' })
    const claims = preflight.claims.map((claim) => ({ claimId: claim.id, verdict: 'REFUTED', strongestAttack: 'The requirements conflict.', reasoning: 'Both fixed schedules cannot hold simultaneously.', blindSpot: 'The plan has no precedence rule.' }))
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ headline: 'Contradictory', strongestAttack: 'The schedule is impossible.', claims, blindSpots: ['No conflict rule'], nextActions: ['Choose one schedule'] }) } }] }), { status: 200 }))
    const result = await new DeepSeekAdversarialProvider(config, fetchImpl).review(text, preflight)
    expect(result.verdict).toBe('REFUTED')
  })

  it('keeps a law claim unresolved while exposing only the verified source-status slice', async () => {
    const text = '根据《中华人民共和国民法典》第五百七十七条，对方必须承担违约责任。'
    const preflight = prepareReviewPreflight({ text, profile: 'LEGAL' })
    const claims = preflight.claims.map((claim) => ({ claimId: claim.id, verdict: 'SURVIVED', strongestAttack: 'Applicability still depends on the facts.', reasoning: 'Current status does not establish that every element is met.', blindSpot: 'Jurisdiction and elements are incomplete.' }))
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ headline: 'Current source, unresolved application', strongestAttack: 'The cited rule may not apply to the stated facts.', claims, blindSpots: ['Elements not mapped'], nextActions: ['Map each element to evidence'] }) } }] }), { status: 200 }))
    const check = {
      claimId: preflight.claims[0].id, subject: 'LAW' as const, status: 'CURRENT_LAW_CONFIRMED' as const,
      statement: 'Current status confirmed only.', checkedAt: '2026-07-20T00:00:00.000Z', provider: 'TAVILY' as const,
      authorityDomains: ['flk.npc.gov.cn'], requestHash: `0x${'1'.repeat(64)}` as const, responseHash: `0x${'2'.repeat(64)}` as const,
      source: { label: '中华人民共和国民法典', url: 'https://flk.npc.gov.cn/detail2.html', authorityDomain: 'flk.npc.gov.cn', excerpt: '效力状态：有效' },
    }
    const result = await new DeepSeekAdversarialProvider(config, fetchImpl).review(text, preflight, [check])

    expect(result.claims[0]).toMatchObject({ verdict: 'UNRESOLVED', verificationStatus: 'AUTHORITATIVE_SOURCE_PARTIAL' })
    expect(result.sources[0]).toMatchObject({ status: 'CURRENT_LAW_CONFIRMED', authorityDomain: 'flk.npc.gov.cn' })
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string) as { messages: Array<{ content: string }> }
    expect(requestBody.messages[1].content).toContain('CURRENT_LAW_CONFIRMED')
  })

  it('rejects missing claims and does not leak response content in its error', async () => {
    const preflight = prepareReviewPreflight({ text: 'We should launch next quarter because customer demand is strong and the architecture is ready.', profile: 'PLAN' })
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"headline":"bad","claims":[]}' } }] }), { status: 200 }))
    await expect(new DeepSeekAdversarialProvider(config, fetchImpl).review('We should launch next quarter because customer demand is strong and the architecture is ready.', preflight)).rejects.toThrow(/address every claim/)
  })
})
