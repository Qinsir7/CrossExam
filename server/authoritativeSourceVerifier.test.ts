import { describe, expect, it, vi } from 'vitest'
import { prepareReviewPreflight } from '../src/domain/generalReview'
import { TavilyAuthoritativeSourceVerifier } from './authoritativeSourceVerifier'

const config = { apiKey: 'tvly-test-not-a-real-key-1234567890', baseUrl: 'https://api.tavily.com' as const }

describe('authority-domain source verifier', () => {
  it('confirms only an explicit current-law signal from an allowed official domain', async () => {
    const preflight = prepareReviewPreflight({ text: '根据《中华人民共和国民法典》第五百七十七条，对方必须承担违约责任。', profile: 'LEGAL' })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [{
      title: '中华人民共和国民法典',
      url: 'https://flk.npc.gov.cn/detail2.html',
      content: '中华人民共和国民法典 第五百七十七条',
      raw_content: '效力状态：有效 现行有效 中华人民共和国民法典 第五百七十七条 当事人一方不履行合同义务。',
      score: 0.91,
    }] }), { status: 200 }))
    const checks = await new TavilyAuthoritativeSourceVerifier(config, fetchImpl, () => new Date('2026-07-20T00:00:00.000Z')).verify(preflight)

    expect(checks[0]).toMatchObject({ status: 'CURRENT_LAW_CONFIRMED', subject: 'LAW', source: { authorityDomain: 'flk.npc.gov.cn' } })
    expect(checks[0].statement).toContain('status only')
  })

  it('rejects a convincing result from a non-authority domain', async () => {
    const preflight = prepareReviewPreflight({ text: '根据《中华人民共和国民法典》第五百七十七条，对方必须承担违约责任。', profile: 'LEGAL' })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [{
      title: '民法典现行有效', url: 'https://law-blog.example/civil-code', content: '现行有效', raw_content: '现行有效', score: 0.99,
    }] }), { status: 200 }))
    const checks = await new TavilyAuthoritativeSourceVerifier(config, fetchImpl).verify(preflight)

    expect(checks[0].status).toBe('NOT_CONFIRMED_IN_PUBLIC_SOURCES')
    expect(checks[0].source).toBeUndefined()
  })

  it('uses the explicit case-citation fallback when no public official record is found', async () => {
    const preflight = prepareReviewPreflight({ text: '（2024）京01民终1234号判决支持相同观点，因此本案必然胜诉。', profile: 'LEGAL' })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }))
    const checks = await new TavilyAuthoritativeSourceVerifier(config, fetchImpl).verify(preflight)

    expect(checks[0]).toMatchObject({ subject: 'CASE', status: 'NOT_CONFIRMED_IN_PUBLIC_SOURCES' })
    expect(checks[0].statement).toContain('Human verification is recommended')
  })

  it('fails closed when search is unavailable', async () => {
    const preflight = prepareReviewPreflight({ text: '数据显示该项目将在一年内增长30%，因此现在应当投资。', profile: 'MONEY' })
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout'))
    const checks = await new TavilyAuthoritativeSourceVerifier(config, fetchImpl).verify(preflight)

    expect(checks[0].status).toBe('SEARCH_UNAVAILABLE')
    expect(checks[0].source).toBeUndefined()
  })

  it('uses only documented Tavily search fields and keeps the bounded query below 400 characters', async () => {
    const preflight = prepareReviewPreflight({ text: `根据《${'中华人民共和国'.repeat(60)}民法典》第五百七十七条，对方必须承担违约责任。`, profile: 'LEGAL' })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }))

    await new TavilyAuthoritativeSourceVerifier(config, fetchImpl).verify(preflight)

    const request = fetchImpl.mock.calls[0]?.[1]
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>
    expect(String(body.query).length).toBeLessThanOrEqual(380)
    expect(body).not.toHaveProperty('safe_search')
    expect(body).toMatchObject({ search_depth: 'basic', max_results: 5, include_raw_content: 'text' })
  })
})
