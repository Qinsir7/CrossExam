import { createHash } from 'node:crypto'
import type { AuthoritativeSourceCheck, ReviewClaim, ReviewPreflight } from '../src/domain/generalReview'

export type TavilySourceVerifierConfig = {
  apiKey: string
  baseUrl: 'https://api.tavily.com'
}

type SearchResult = {
  title: string
  url: string
  content: string
  rawContent: string
  score: number
  domain: string
}

const CHINA_LAW_DOMAINS = ['flk.npc.gov.cn', 'npc.gov.cn', 'gov.cn', 'court.gov.cn', 'wenshu.court.gov.cn', 'spp.gov.cn']
const HONG_KONG_LAW_DOMAINS = ['elegislation.gov.hk', 'judiciary.hk', 'doj.gov.hk']
const US_LAW_DOMAINS = ['congress.gov', 'govinfo.gov', 'uscode.house.gov', 'supremecourt.gov', 'uscourts.gov']
const EU_LAW_DOMAINS = ['eur-lex.europa.eu', 'curia.europa.eu']
const UK_LAW_DOMAINS = ['legislation.gov.uk', 'judiciary.uk', 'supremecourt.uk']
const OTHER_LAW_DOMAINS = ['laws-lois.justice.gc.ca', 'scc-csc.ca', 'legislation.gov.au', 'fedcourt.gov.au', 'sso.agc.gov.sg', 'judiciary.gov.sg', 'legislative.gov.in', 'sci.gov.in']
const CASE_REFERENCE = /(?:[（(]\d{4}[）)][\u4e00-\u9fffA-Za-z0-9]{1,24}(?:民|刑|行|商|知|执|赔|破|非诉)[\u4e00-\u9fffA-Za-z0-9]{0,16}号|\b\d{1,4}\s+[A-Z][A-Za-z.]{0,12}\s+\d{1,6}\b|\b[A-Z][A-Za-z.&' -]{1,60}\s+v\.?\s+[A-Z][A-Za-z.&' -]{1,60}(?:\s+\(\d{4}\))?)/i
const CURRENT_STATUS = /(?:现行有效|效力(?:状态|级别|属性)\s*[:：]?\s*有效|时效性\s*[:：]?\s*现行有效|currently\s+in\s+force|current\s+through|effective\s+as\s+of)/i
const REPEALED_STATUS = /(?:效力(?:状态|属性)\s*[:：]?\s*(?:失效|废止)|时效性\s*[:：]?\s*(?:失效|废止)|废止日期\s*[:：]|已被(?:废止|废除)|status\s*[:：]?\s*(?:repealed|revoked|superseded)|repealed\s+(?:on|by)|revoked\s+(?:on|by))/i

function hash(value: string): `0x${string}` {
  return `0x${createHash('sha256').update(value).digest('hex')}`
}

function normalized(value: string) {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function exactOrSubdomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

function jurisdictionDomains(text: string) {
  const lower = text.toLowerCase()
  if (/香港|hong\s+kong/.test(lower)) return HONG_KONG_LAW_DOMAINS
  if (/欧盟|欧洲联盟|european\s+union|\beu\b/.test(lower)) return EU_LAW_DOMAINS
  if (/英国|united\s+kingdom|\buk\b|england|wales|scotland/.test(lower)) return UK_LAW_DOMAINS
  if (/美国|united\s+states|\bu\.?s\.?\b|federal\s+court/.test(lower)) return US_LAW_DOMAINS
  if (/[\u3400-\u9fff]/.test(text) || /中国|中华人民共和国|最高人民法院/.test(text)) return CHINA_LAW_DOMAINS
  return [...US_LAW_DOMAINS, ...EU_LAW_DOMAINS, ...UK_LAW_DOMAINS, ...OTHER_LAW_DOMAINS]
}

function eligible(claim: ReviewClaim) {
  return claim.kind === 'LEGAL_CITATION' || claim.kind === 'SOURCE_CITATION' || claim.kind === 'QUANTITATIVE'
}

function subjectFor(claim: ReviewClaim): AuthoritativeSourceCheck['subject'] {
  if (claim.kind !== 'LEGAL_CITATION') return 'PRIMARY_SOURCE'
  return CASE_REFERENCE.test(claim.text) || /判例|案例|裁判|判决|裁定|precedent|case\s+law/i.test(claim.text) ? 'CASE' : 'LAW'
}

function claimReferences(preflight: ReviewPreflight, claim: ReviewClaim, subject: AuthoritativeSourceCheck['subject']) {
  const references = subject === 'CASE' ? preflight.detected.caseReferences : preflight.detected.legalReferences
  return references.filter((reference) => claim.text.includes(reference))
}

function queryFor(preflight: ReviewPreflight, claim: ReviewClaim, subject: AuthoritativeSourceCheck['subject']) {
  const references = claimReferences(preflight, claim, subject)
  if (references.length) return `${references.slice(0, 3).map((item) => `"${item}"`).join(' ')} ${subject === 'LAW' ? '现行有效 效力状态' : subject === 'CASE' ? '裁判文书 判决' : 'official source'}`.slice(0, 600)
  return claim.text.replace(/\s+/g, ' ').slice(0, 560)
}

function parseSearchResults(value: unknown, domains: string[]): SearchResult[] {
  if (!value || Array.isArray(value) || typeof value !== 'object') return []
  const results = (value as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  const parsed: SearchResult[] = []
  for (const item of results.slice(0, 10)) {
    if (!item || Array.isArray(item) || typeof item !== 'object') continue
    const candidate = item as Record<string, unknown>
    if (typeof candidate.url !== 'string' || typeof candidate.title !== 'string') continue
    let url: URL
    try { url = new URL(candidate.url) } catch { continue }
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    const authorityDomain = domains.find((domain) => exactOrSubdomain(hostname, domain))
    if (url.protocol !== 'https:' || !authorityDomain) continue
    const score = typeof candidate.score === 'number' && Number.isFinite(candidate.score) ? candidate.score : 0
    if (score < 0.25) continue
    parsed.push({
      title: candidate.title.trim().slice(0, 300),
      url: url.toString(),
      content: typeof candidate.content === 'string' ? candidate.content.slice(0, 8_000) : '',
      rawContent: typeof candidate.raw_content === 'string' ? candidate.raw_content.slice(0, 80_000) : '',
      score,
      domain: authorityDomain,
    })
  }
  return parsed
}

function bestMatchingResult(results: SearchResult[], references: string[]) {
  if (!references.length) return results[0]
  const normalizedReferences = references.map(normalized).filter((item) => item.length >= 4)
  return results.find((result) => {
    const haystack = normalized(`${result.title}\n${result.rawContent || result.content}`)
    return normalizedReferences.some((reference) => haystack.includes(reference))
  })
}

function excerptFor(result: SearchResult, references: string[]) {
  const content = (result.rawContent || result.content).replace(/\s+/g, ' ').trim()
  if (!content) return result.title
  const reference = references.find((item) => content.toLowerCase().includes(item.toLowerCase()))
  const start = reference ? Math.max(0, content.toLowerCase().indexOf(reference.toLowerCase()) - 140) : 0
  return content.slice(start, start + 520)
}

function classify(subject: AuthoritativeSourceCheck['subject'], result: SearchResult | undefined, references: string[]) {
  if (!result) {
    return subject === 'CASE'
      ? { status: 'NOT_CONFIRMED_IN_PUBLIC_SOURCES' as const, statement: 'This case could not be confirmed in the searched public official sources. Human verification is recommended.' }
      : { status: 'NOT_CONFIRMED_IN_PUBLIC_SOURCES' as const, statement: 'No matching authoritative public source was confirmed for this claim. Treat it as unresolved.' }
  }
  const fullText = result.rawContent || result.content
  // Status words elsewhere on a long index page must not be laundered into
  // the matched citation. Inspect only the source heading and a bounded window
  // around the exact reference.
  const sourceText = `${result.title}\n${fullText.slice(0, 1_500)}\n${excerptFor(result, references)}`
  if (subject === 'CASE') return { status: 'CASE_PUBLIC_SOURCE_CONFIRMED' as const, statement: 'A matching case record was located on a public official court source. This confirms public-source existence, not legal applicability or precedential weight.' }
  if (subject === 'PRIMARY_SOURCE') return { status: 'AUTHORITATIVE_SOURCE_LOCATED' as const, statement: 'A relevant authoritative source was located. The link is evidence provenance, not automatic proof of the full claim.' }
  if (REPEALED_STATUS.test(sourceText)) return { status: 'REPEALED_OR_SUPERSEDED' as const, statement: 'The official source contains an explicit repealed, invalid, or superseded status signal. The cited rule must not be treated as current without date-specific legal review.' }
  if (CURRENT_STATUS.test(sourceText)) return { status: 'CURRENT_LAW_CONFIRMED' as const, statement: 'The matching official source contains an explicit current or in-force status signal. This confirms source status only, not jurisdiction, applicability, interpretation, or outcome.' }
  return { status: 'OFFICIAL_SOURCE_FOUND_STATUS_UNCLEAR' as const, statement: `A matching official source was found${references.length ? '' : ', but the exact cited provision was not extracted'}. Its current force was not explicit in the retrieved text, so status remains unresolved.` }
}

export class TavilyAuthoritativeSourceVerifier {
  private readonly config: TavilySourceVerifierConfig
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(config: TavilySourceVerifierConfig, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()) {
    this.config = config
    this.fetchImpl = fetchImpl
    this.now = now
  }

  async verify(preflight: ReviewPreflight): Promise<AuthoritativeSourceCheck[]> {
    const claims = preflight.claims.filter(eligible)
      .sort((left, right) => (left.materiality === right.materiality ? 0 : left.materiality === 'MATERIAL' ? -1 : 1))
      .slice(0, 6)
    return Promise.all(claims.map(async (claim) => {
      const subject = subjectFor(claim)
      const domains = jurisdictionDomains(`${preflight.title}\n${claim.text}`)
      const references = claimReferences(preflight, claim, subject)
      const body = JSON.stringify({
        query: queryFor(preflight, claim, subject),
        search_depth: 'basic',
        max_results: 5,
        topic: 'general',
        include_answer: false,
        include_raw_content: 'text',
        include_images: false,
        include_domains: domains,
        safe_search: true,
      })
      const base = {
        claimId: claim.id,
        subject,
        checkedAt: this.now().toISOString(),
        provider: 'TAVILY' as const,
        authorityDomains: domains,
        requestHash: hash(body),
      }
      try {
        const response = await this.fetchImpl(`${this.config.baseUrl}/search`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(20_000),
        })
        const raw = await response.text()
        if (raw.length > 2_000_000) throw new Error('Search response exceeded the 2 MB safety limit.')
        const responseHash = hash(raw)
        if (!response.ok) throw new Error(`Search API returned HTTP ${response.status}.`)
        let envelope: unknown
        try { envelope = JSON.parse(raw) } catch { throw new Error('Search API returned malformed JSON.') }
        const result = bestMatchingResult(parseSearchResults(envelope, domains), references)
        const classified = classify(subject, result, references)
        return {
          ...base,
          ...classified,
          responseHash,
          ...(result ? { source: { label: result.title, url: result.url, authorityDomain: result.domain, excerpt: excerptFor(result, references) } } : {}),
        }
      } catch {
        return {
          ...base,
          status: 'SEARCH_UNAVAILABLE' as const,
          statement: subject === 'CASE'
            ? 'Public official-source search was unavailable, so this case was not confirmed. Human verification is recommended.'
            : 'Authoritative-source search was unavailable. This claim remains unresolved and no verification is implied.',
        }
      }
    }))
  }
}
