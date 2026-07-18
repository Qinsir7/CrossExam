import { describe, expect, it } from 'vitest'
import { keccak256, stringToHex } from 'viem'
import { evidenceArtifactHash } from './evidenceIntegrity'
import { prepareTransactionPreflight } from './transactionPreflight'
import { withOkxMarketSource, type ReviewerRegistry } from './reviewerRegistry'
import type { ExternalReviewProvider } from './reviewJobWorker'

const token = '0x2222222222222222222222222222222222222222'
const registry: ReviewerRegistry = withOkxMarketSource({})

function provider(responseFor: (reviewerId: string) => unknown): ExternalReviewProvider {
  return {
    async requestReview(input) {
      const responseBody = JSON.stringify(responseFor(input.reviewerId))
      const source = registry[input.reviewerId]
      const observedAt = '2026-07-18T10:00:00.000Z'
      const artifact = {
        id: `artifact-${input.scopeId}`,
        kind: 'TOOL_OUTPUT' as const,
        locator: source.procurementEndpoint!,
        observedAt,
        excerpt: responseBody,
      }
      const provenance = source.procurementProtocol === 'AUTHENTICATED_API_EVIDENCE_V1'
        ? {
            kind: 'AUTHENTICATED_API_EVIDENCE_V1' as const,
            sourceId: source.id,
            endpoint: source.procurementEndpoint!,
            observedAt,
            requestHash: keccak256(stringToHex(`request:${input.scopeId}`)),
            responseHash: keccak256(stringToHex(responseBody)),
            authentication: { scheme: 'OKX_HMAC_SHA256' as const, includedQuota: true as const },
          }
        : {
            kind: 'PUBLIC_API_EVIDENCE_V1' as const,
            sourceId: source.id,
            endpoint: source.procurementEndpoint!,
            observedAt,
            requestHash: keccak256(stringToHex(`request:${input.scopeId}`)),
            responseHash: keccak256(stringToHex(responseBody)),
            transport: { scheme: 'PUBLIC_HTTPS' as const, marginalCostUsd: 0 as const },
          }
      return {
        externalRequestId: `external-${input.scopeId}`,
        includedQuota: { sourceId: source.id, authentication: source.procurementProtocol === 'AUTHENTICATED_API_EVIDENCE_V1' ? 'OKX_HMAC_SHA256' as const : 'PUBLIC_HTTPS' as const },
        evidence: {
          provenance,
          responseBody,
          delivery: {
            reviewerId: source.id,
            deliveredAt: observedAt,
            provenance,
            artifacts: [{ ...artifact, contentHash: evidenceArtifactHash(artifact) }],
            findings: input.task.claims.map((claim) => ({
              claimId: claim.id,
              reviewerId: source.id,
              verdict: 'INSUFFICIENT_EVIDENCE' as const,
              confidence: 1,
              materiality: claim.materiality,
              evidence: 'The provider response is retained as an immutable, normalized evidence observation.',
              evidenceArtifactIds: [artifact.id],
            })),
          },
        },
      }
    },
  }
}

const request = {
  title: 'Purchase a thin X Layer token position',
  actionType: 'TRADE' as const,
  chainId: 196,
  to: '0x1111111111111111111111111111111111111111',
  data: '0x',
  valueWei: '0',
  valueAtRiskUsd: 5_000,
  tokenRiskTarget: `token:xlayer:${token}`,
}

describe('prepareTransactionPreflight', () => {
  it('uses delivered provider evidence to create a procurement-verified signed-record candidate that blocks thin liquidity', async () => {
    const prepared = await prepareTransactionPreflight(request, {
      registry,
      provider: provider((reviewerId) => reviewerId === 'okx-onchainos-liquidity'
        ? { code: '0', data: [{ liquidityUsd: '1000' }] }
        : { code: 1, result: { [token]: { is_honeypot: '0', cannot_buy: '0', cannot_sell_all: '0', is_blacklisted: '0', buy_tax: '0', sell_tax: '0' } } }),
      now: () => new Date('2026-07-18T10:00:00.000Z'),
    })

    expect(prepared.verdict).toMatchObject({ verdict: 'BLOCK', canExecute: false })
    expect(prepared.verdict.strongestContradiction?.claimId).toBe('C-EXECUTION-LIQUIDITY')
    expect(prepared.evidence).toHaveLength(2)
    expect(prepared.record.attributionStatus).toBe('PROCUREMENT_VERIFIED')
    expect(prepared.record.result.action).toBe('BLOCK')
    expect(prepared.procurementFailures).toEqual([])
  })

  it('fails closed and labels the record conservatively when a source has no real result', async () => {
    const unavailable: ExternalReviewProvider = {
      async requestReview(input) {
        if (input.reviewerId === 'okx-onchainos-liquidity') throw new Error('Upstream liquidity source timed out.')
        return provider(() => ({ code: 1, result: { [token]: { is_honeypot: '0', cannot_buy: '0', cannot_sell_all: '0', is_blacklisted: '0' } } })).requestReview(input)
      },
    }
    const prepared = await prepareTransactionPreflight(request, { registry, provider: unavailable })

    expect(prepared.verdict).toMatchObject({ verdict: 'HOLD', canExecute: false })
    expect(prepared.record.attributionStatus).toBe('DECLARED_BY_CALLER')
    expect(prepared.procurementFailures).toMatchObject([{ sourceId: 'okx-onchainos-liquidity' }])
  })
})
