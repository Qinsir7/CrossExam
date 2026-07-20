import { createHash } from 'node:crypto'
import type { Finding, CrossExamResult, DecisionPackage } from '../src/domain/types'
import { prepareReviewPreflight, type AdversarialReviewResult, type AuthoritativeSourceCheck, type ReviewPreflightInput } from '../src/domain/generalReview'
import type { ReviewDispatch } from '../src/network/reviewNetwork'
import { issueDecisionAssuranceRecord } from './assuranceRecord'

export type AdversarialReviewProvider = {
  review(text: string, preflight: ReturnType<typeof prepareReviewPreflight>, sourceChecks?: AuthoritativeSourceCheck[]): Promise<AdversarialReviewResult>
}

export type AuthoritativeSourceVerifier = {
  verify(preflight: ReturnType<typeof prepareReviewPreflight>): Promise<AuthoritativeSourceCheck[]>
}

function stableId(prefix: string, value: string) {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

function actionFor(analysis: AdversarialReviewResult): CrossExamResult['action'] {
  if (analysis.verdict === 'REFUTED') return 'HOLD'
  if (analysis.verdict === 'UNRESOLVED') return 'CONDITIONAL'
  return 'PROCEED'
}

/**
 * Converts a bounded model-only adversarial pass into a signed assurance
 * record without laundering model reasoning into independently verified
 * evidence. Source- and tool-bound claims remain UNRESOLVED by construction.
 */
export async function preparePaidAdversarialReview(
  input: ReviewPreflightInput,
  provider: AdversarialReviewProvider,
  issuedAt = new Date().toISOString(),
  sourceVerifier?: AuthoritativeSourceVerifier,
) {
  const preflight = prepareReviewPreflight(input)
  if (preflight.characterCount > 120_000) throw new Error('Paid adversarial review currently accepts at most 120,000 extracted characters.')
  const sourceChecks = sourceVerifier ? await sourceVerifier.verify(preflight) : []
  const analysis = await provider.review(input.text, preflight, sourceChecks)
  const decisionId = stableId('DP-GENERAL', `${preflight.profile}\n${preflight.title}\n${input.text}`)
  const decision: DecisionPackage = {
    id: decisionId,
    title: preflight.title,
    valueAtRiskUsd: 0,
    claims: preflight.claims.map((claim) => ({ id: claim.id, statement: claim.text, materiality: claim.materiality === 'MATERIAL' ? 1 : 0.5 })),
    reviewProfile: 'GENERAL',
  }
  const artifactId = stableId('EA-MODEL', analysis.provenance.responseHash)
  const sourceArtifactIds = new Map(analysis.sourceChecks?.map((check) => [check.claimId, stableId('EA-SOURCE', `${check.claimId}\n${check.responseHash ?? check.requestHash}`)]) ?? [])
  const findings: Finding[] = analysis.claims.map((claim) => ({
    claimId: claim.claimId,
    reviewerId: 'deepseek-adversarial-reasoning',
    verdict: claim.verdict === 'REFUTED' ? 'CONTRADICTS' : claim.verdict === 'SURVIVED' ? 'SUPPORTS' : 'INSUFFICIENT_EVIDENCE',
    confidence: 0.5,
    materiality: preflight.claims.find((item) => item.id === claim.claimId)?.materiality === 'MATERIAL' ? 1 : 0.5,
    evidence: `${claim.strongestAttack} ${claim.reasoning}`,
    evidenceArtifactIds: [artifactId, ...(sourceArtifactIds.get(claim.claimId) ? [sourceArtifactIds.get(claim.claimId)!] : [])],
  }))
  const sourceArtifacts = (analysis.sourceChecks ?? []).map((check) => ({
    id: sourceArtifactIds.get(check.claimId)!,
    kind: check.source ? 'PRIMARY_SOURCE' as const : 'SEARCH_LOG' as const,
    locator: check.source?.url ?? `tavily:search:${check.requestHash}`,
    observedAt: check.checkedAt,
    excerpt: `${check.status}: ${check.statement}${check.source?.excerpt ? ` ${check.source.excerpt}` : ''}`.slice(0, 1_400),
    contentHash: check.responseHash ?? check.requestHash,
  }))
  const dispatch: ReviewDispatch = {
    id: stableId('RD-GENERAL', decisionId),
    decisionId,
    status: 'DELIVERED',
    assignments: [{
      scopeId: 'SCOPE-ADVERSARIAL-REASONING',
      status: 'DELIVERED',
      reviewer: {
        id: 'deepseek-adversarial-reasoning',
        displayName: 'DeepSeek adversarial reasoning',
        ownerId: 'deepseek',
        modelFamily: analysis.provenance.model,
        evidenceRoutes: ['model-reasoning'],
      },
      reason: analysis.sourceChecks?.length
        ? 'Completed as model reasoning with separately attributed, authority-domain-restricted source checks. Source status does not imply full-claim verification.'
        : 'Completed as model reasoning. No external factual verification is implied.',
      delivery: {
        reviewerId: 'deepseek-adversarial-reasoning',
        deliveredAt: issuedAt,
        artifacts: [{
          id: artifactId,
          kind: 'TOOL_OUTPUT',
          locator: `deepseek:${analysis.provenance.model}:${analysis.provenance.responseId ?? analysis.provenance.responseHash}`,
          observedAt: issuedAt,
          excerpt: 'Model reasoning output only; external facts, current law, citations, and onchain state were not independently verified in this pass.',
          contentHash: analysis.provenance.responseHash,
        }],
        findings,
      },
    }, ...(sourceArtifacts.length ? [{
      scopeId: 'SCOPE-AUTHORITATIVE-SOURCE-CHECKS',
      status: 'DELIVERED' as const,
      reviewer: {
        id: 'tavily-authority-search',
        displayName: 'Authority-domain source search',
        ownerId: 'tavily',
        modelFamily: 'search-retrieval',
        evidenceRoutes: ['official-public-sources'],
      },
      reason: 'Search was restricted to a jurisdiction-sensitive authority-domain allowlist. A link confirms only the explicitly reported source status.',
      delivery: {
        reviewerId: 'tavily-authority-search',
        deliveredAt: issuedAt,
        artifacts: sourceArtifacts,
        findings: [],
      },
    }] : [])],
  }
  const materialIds = new Set(preflight.claims.filter((claim) => claim.materiality === 'MATERIAL').map((claim) => claim.id))
  const result: CrossExamResult = {
    claims: analysis.claims.map((claim) => ({
      id: claim.claimId,
      text: preflight.claims.find((item) => item.id === claim.claimId)?.text ?? claim.claimId,
      verdict: claim.verdict,
      evidence: `${claim.strongestAttack} ${claim.reasoning}`,
      challenger: `DeepSeek adversarial reasoning (${analysis.provenance.model}; model-only)`,
    })),
    action: actionFor(analysis),
    effectiveIndependence: 0,
    materialRefutations: analysis.claims.filter((claim) => materialIds.has(claim.claimId) && claim.verdict === 'REFUTED').length,
    materialUnresolved: analysis.claims.filter((claim) => materialIds.has(claim.claimId) && claim.verdict === 'UNRESOLVED').length,
    reversalConditions: analysis.claims.filter((claim) => claim.verdict !== 'SURVIVED').map((claim) => ({
      claimId: claim.claimId,
      kind: claim.verdict === 'REFUTED' ? 'OVERTURN_CONTRADICTION' : 'RESOLVE_UNCERTAINTY',
      requirement: claim.evidenceNeeded ?? `Resolve the blind spot: ${claim.blindSpot}`,
      basedOnEvidence: analysis.sourceChecks?.find((check) => check.claimId === claim.claimId)
        ? `DeepSeek adversarial analysis plus bounded official-source check: ${analysis.sourceChecks.find((check) => check.claimId === claim.claimId)!.status}.`
        : 'DeepSeek model-only adversarial analysis; no independent source verification.',
    })),
  }
  return {
    preflight,
    analysis,
    record: issueDecisionAssuranceRecord(decision, dispatch, result, issuedAt, 'MODEL_ANALYZED', { reviewPreflight: preflight, adversarialAnalysis: analysis }),
  }
}
