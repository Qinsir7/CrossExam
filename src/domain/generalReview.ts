export type ReviewProfile = 'LEGAL' | 'MONEY' | 'PLAN' | 'GENERAL'

export type ReviewClaimKind =
  | 'LEGAL_CITATION'
  | 'ONCHAIN_FACT'
  | 'SOURCE_CITATION'
  | 'QUANTITATIVE'
  | 'CAUSAL'
  | 'PREDICTION'
  | 'COMMITMENT'
  | 'ASSERTION'

export type ClaimVerificationRoute = 'TOOL_READY' | 'SOURCE_REQUIRED' | 'ARGUMENT_ONLY'

export type ReviewClaim = {
  id: string
  text: string
  kind: ReviewClaimKind
  materiality: 'MATERIAL' | 'SUPPORTING'
  verificationRoute: ClaimVerificationRoute
  reviewTask: string
  attackAngle: string
  evidenceNeeded?: string
}

export type ReviewPreflight = {
  profile: ReviewProfile
  inferredDocumentType: string
  title: string
  characterCount: number
  claimCount: number
  verifiableClaimCount: number
  claims: ReviewClaim[]
  detected: {
    contractAddresses: `0x${string}`[]
    urls: string[]
    legalReferences: string[]
  }
  limitations: string[]
  paidReview?: {
    available: boolean
    priceUsd: string
    provider?: 'DEEPSEEK'
  }
}

export type ReviewPreflightInput = {
  text: string
  profile?: ReviewProfile
  filename?: string
}

export type AdversarialClaimResult = {
  claimId: string
  verdict: 'SURVIVED' | 'REFUTED' | 'UNRESOLVED'
  strongestAttack: string
  reasoning: string
  blindSpot: string
  evidenceNeeded?: string
  verificationStatus: 'MODEL_REASONING_ONLY' | 'REQUIRES_EXTERNAL_SOURCE' | 'TOOL_CHECK_REQUIRED'
}

export type AdversarialReviewResult = {
  verdict: 'SURVIVED' | 'REFUTED' | 'UNRESOLVED'
  headline: string
  strongestAttack: string
  claims: AdversarialClaimResult[]
  blindSpots: string[]
  nextActions: string[]
  sources: Array<{ label: string; url: string; verifiedAt: string }>
  provenance: {
    provider: 'DEEPSEEK'
    model: string
    responseId?: string
    inputTokens?: number
    outputTokens?: number
    requestHash: `0x${string}`
    responseHash: `0x${string}`
  }
}

const MAX_INPUT_CHARACTERS = 200_000
const MAX_CLAIMS = 30
const MAX_CLAIM_CHARACTERS = 560

const LEGAL_WORDS = /起诉状|答辩状|上诉状|代理意见|判决书|裁定书|合同|协议|甲方|乙方|法院|仲裁|诉讼|违约|law|legal|agreement|contract|plaintiff|defendant|appeal|court|arbitration/i
const MONEY_WORDS = /投资|买入|卖出|交易|收益|估值|仓位|止损|代币|合约地址|流动性|回报率|investment|invest|trade|buy|sell|token|portfolio|valuation|return|liquidity/i
const PLAN_WORDS = /方案|计划|路线图|产品|架构|预算|里程碑|上线|增长|商业模式|strategy|plan|roadmap|architecture|budget|milestone|launch|growth|business model/i
const LEGAL_REFERENCE = /(?:《[^》]{1,80}》(?:第[一二三四五六七八九十百千万\d]+条)?|第[一二三四五六七八九十百千万\d]+条|(?:article|section)\s+\d+[a-z0-9().-]*)/gi
const CONTRACT_ADDRESS = /0x[a-fA-F0-9]{40}/g
const URL_PATTERN = /https?:\/\/[^\s<>"'，。；）)\]]+/gi

function normalizeText(value: string) {
  return value.replace(/\r\n?/g, '\n').replace(/[\t\f\v]+/g, ' ').replace(/[ \u00a0]+/g, ' ').trim()
}

function unique<T>(items: T[]) {
  return [...new Set(items)]
}

function inferProfile(text: string, filename?: string): ReviewProfile {
  const sample = `${filename ?? ''}\n${text.slice(0, 12_000)}`
  const legal = (sample.match(new RegExp(LEGAL_WORDS.source, 'gi')) ?? []).length
  const money = (sample.match(new RegExp(MONEY_WORDS.source, 'gi')) ?? []).length + (sample.match(CONTRACT_ADDRESS) ?? []).length * 3
  const plan = (sample.match(new RegExp(PLAN_WORDS.source, 'gi')) ?? []).length
  const highest = Math.max(legal, money, plan)
  if (highest === 0) return 'GENERAL'
  if (legal === highest) return 'LEGAL'
  if (money === highest) return 'MONEY'
  return 'PLAN'
}

function inferDocumentType(profile: ReviewProfile, text: string, filename?: string) {
  const sample = `${filename ?? ''}\n${text.slice(0, 8_000)}`
  if (/上诉状|appeal brief/i.test(sample)) return 'Appeal brief'
  if (/起诉状|complaint|statement of claim/i.test(sample)) return 'Statement of claim'
  if (/答辩状|defence|defense brief/i.test(sample)) return 'Defence brief'
  if (/代理意见|legal opinion/i.test(sample)) return 'Legal opinion'
  if (/合同|协议|agreement|contract/i.test(sample)) return 'Contract draft'
  if (/商业计划|business plan/i.test(sample)) return 'Business plan'
  if (/技术架构|system architecture|technical architecture/i.test(sample)) return 'Technical architecture'
  if (profile === 'MONEY') return 'Investment or trade thesis'
  if (profile === 'PLAN') return 'Plan or proposal'
  if (profile === 'LEGAL') return 'Legal document'
  return 'Decision document'
}

function extractTitle(text: string, documentType: string) {
  const first = text.split('\n').map((line) => line.trim()).find((line) => line.length >= 3)
  if (!first) return documentType
  const withoutListMarker = first.replace(/^(?:[-*•]|\d+[.)、]|[一二三四五六七八九十]+[、.])\s*/, '')
  return withoutListMarker.slice(0, 96)
}

function candidateSentences(text: string) {
  const candidates: string[] = []
  for (const paragraph of text.split(/\n{1,}/)) {
    const clean = paragraph.trim().replace(/^(?:[-*•]|\d+[.)、]|[一二三四五六七八九十]+[、.])\s*/, '')
    if (!clean) continue
    const fragments = clean.split(/(?<=[。！？!?；;])\s*|(?<=[.])\s+(?=[A-Z0-9“"'])/)
    for (const fragment of fragments) {
      const value = fragment.trim().replace(/^[，,;；:：]+|[，,;；]+$/g, '')
      if (value.length >= 10) candidates.push(value.slice(0, MAX_CLAIM_CHARACTERS))
    }
  }
  return unique(candidates)
}

function classifyClaim(text: string, profile: ReviewProfile): Omit<ReviewClaim, 'id' | 'text' | 'materiality'> {
  if (CONTRACT_ADDRESS.test(text)) {
    CONTRACT_ADDRESS.lastIndex = 0
    return {
      kind: 'ONCHAIN_FACT',
      verificationRoute: profile === 'MONEY' ? 'TOOL_READY' : 'SOURCE_REQUIRED',
      reviewTask: 'Verify the contract and available onchain facts for the exact address.',
      attackAngle: 'Check whether the thesis survives liquidity, transfer-control, concentration, and identity evidence.',
      evidenceNeeded: profile === 'MONEY' ? 'The target chain and intended trade size improve the onchain check.' : 'Identify the target chain and why this address matters.',
    }
  }
  CONTRACT_ADDRESS.lastIndex = 0
  if (LEGAL_REFERENCE.test(text) || /法律|法规|法条|司法解释|statute|regulation|precedent/i.test(text)) {
    LEGAL_REFERENCE.lastIndex = 0
    return {
      kind: 'LEGAL_CITATION',
      verificationRoute: 'SOURCE_REQUIRED',
      reviewTask: 'Check whether the cited rule is authentic, current, and applicable to the stated jurisdiction and date.',
      attackAngle: 'Test for amendment, repeal, hierarchy, exception, and a stronger contrary interpretation.',
      evidenceNeeded: 'Provide the jurisdiction, relevant date, and official law or case source to make this independently verifiable.',
    }
  }
  LEGAL_REFERENCE.lastIndex = 0
  if (URL_PATTERN.test(text) || /doi:|报告|研究|数据显示|according to|study|report|source/i.test(text)) {
    URL_PATTERN.lastIndex = 0
    return {
      kind: 'SOURCE_CITATION',
      verificationRoute: 'SOURCE_REQUIRED',
      reviewTask: 'Open the cited source and check that it exists and supports this exact proposition.',
      attackAngle: 'Look for quotation drift, stale data, selection bias, and contrary primary sources.',
      evidenceNeeded: 'Add the primary-source URL, document, author, and publication date if absent.',
    }
  }
  URL_PATTERN.lastIndex = 0
  if (/(?:\d[\d,.]*\s*(?:%|％|元|万元|亿元|美元|USDT|USD|days?|天|个月|年)|[$¥]\s*\d)/i.test(text)) {
    return {
      kind: 'QUANTITATIVE',
      verificationRoute: 'SOURCE_REQUIRED',
      reviewTask: 'Recompute the number and test the data source, denominator, date, and units.',
      attackAngle: 'Stress-test the conclusion against adverse ranges and base-rate alternatives.',
      evidenceNeeded: 'Provide the calculation, source data, measurement date, and units.',
    }
  }
  if (/因为|因此|导致|从而|由于|所以|because|therefore|causes?|leads? to|results? in/i.test(text)) {
    return {
      kind: 'CAUSAL',
      verificationRoute: 'ARGUMENT_ONLY',
      reviewTask: 'Test whether the stated cause is necessary, sufficient, or merely correlated.',
      attackAngle: 'Search for confounders, reverse causality, and a simpler competing explanation.',
      evidenceNeeded: 'Provide comparison cases or evidence that separates correlation from causation.',
    }
  }
  if (/预计|预期|将会|增长|可能|目标|预测|forecast|expect|will|likely|target/i.test(text)) {
    return {
      kind: 'PREDICTION',
      verificationRoute: 'ARGUMENT_ONLY',
      reviewTask: 'Identify the assumptions that must hold for this forecast and test adverse scenarios.',
      attackAngle: 'Compare the forecast with base rates and the strongest plausible failure path.',
      evidenceNeeded: 'Add the forecast horizon, baseline, measurable threshold, and invalidation condition.',
    }
  }
  if (/应当|必须|需要|计划|拟|决定|建议|should|must|need to|plan to|recommend/i.test(text)) {
    return {
      kind: 'COMMITMENT',
      verificationRoute: 'ARGUMENT_ONLY',
      reviewTask: 'Test whether this action follows from the goal and stated constraints.',
      attackAngle: 'Look for hidden dependencies, opportunity cost, reversibility, and cheaper alternatives.',
      evidenceNeeded: 'Add the objective, constraints, owner, timing, and success criterion.',
    }
  }
  return {
    kind: 'ASSERTION',
    verificationRoute: 'ARGUMENT_ONLY',
    reviewTask: 'State the strongest version of this claim, then construct the strongest good-faith objection.',
    attackAngle: 'Look for hidden assumptions, counterexamples, ambiguity, and evidence that would change the decision.',
    evidenceNeeded: 'Add the underlying source or observation that would let an independent reviewer test this claim.',
  }
}

function materiality(text: string, index: number): ReviewClaim['materiality'] {
  if (index < 8 || /核心|关键|必须|结论|请求|金额|期限|目标|because|therefore|must|critical|primary/i.test(text)) return 'MATERIAL'
  return 'SUPPORTING'
}

export function prepareReviewPreflight(input: ReviewPreflightInput): ReviewPreflight {
  if (typeof input.text !== 'string') throw new Error('Review text is required.')
  const text = normalizeText(input.text)
  if (text.length < 20) throw new Error('Add a little more detail so CrossExam can identify a decision and its premises.')
  if (text.length > MAX_INPUT_CHARACTERS) throw new Error(`Review text exceeds the ${MAX_INPUT_CHARACTERS.toLocaleString('en-US')} character limit.`)
  const profile = input.profile ?? inferProfile(text, input.filename)
  const inferredDocumentType = inferDocumentType(profile, text, input.filename)
  const sentences = candidateSentences(text).slice(0, MAX_CLAIMS)
  if (!sentences.length) throw new Error('CrossExam could not identify a reviewable proposition in this material.')
  const claims = sentences.map((claimText, index): ReviewClaim => ({
    id: `C-${String(index + 1).padStart(3, '0')}`,
    text: claimText,
    materiality: materiality(claimText, index),
    ...classifyClaim(claimText, profile),
  }))
  const contractAddresses = unique((text.match(CONTRACT_ADDRESS) ?? []).map((address) => address.toLowerCase() as `0x${string}`))
  const urls = unique(text.match(URL_PATTERN) ?? [])
  const legalReferences = unique(text.match(LEGAL_REFERENCE) ?? [])
  const limitations: string[] = []
  if (profile === 'LEGAL') limitations.push('Legal citations are not marked verified until an authoritative jurisdiction-specific source answers the check.')
  if (profile === 'MONEY' && !contractAddresses.length) limitations.push('No contract address was detected; CrossExam can attack the thesis but cannot bind onchain evidence to an exact asset yet.')
  if (profile === 'GENERAL') limitations.push('This domain has no dedicated verification adapter yet; factual claims remain source-required unless a traceable source is supplied.')

  return {
    profile,
    inferredDocumentType,
    title: extractTitle(text, inferredDocumentType),
    characterCount: text.length,
    claimCount: claims.length,
    verifiableClaimCount: claims.filter((claim) => claim.verificationRoute !== 'ARGUMENT_ONLY').length,
    claims,
    detected: { contractAddresses, urls, legalReferences },
    limitations,
  }
}
