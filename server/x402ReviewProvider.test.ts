import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@okxweb3/x402-core/http'
import type { PaymentRequired } from '@okxweb3/x402-core/types'
import { describe, expect, it } from 'vitest'
import type { ReviewerRegistry } from './reviewerRegistry'
import { X402ReviewProvider } from './x402ReviewProvider'

const signingKey = '0x0123456789012345678901234567890123456789012345678901234567890123' as const
const asset = '0x5555555555555555555555555555555555555555'
const registry: ReviewerRegistry = {
  reviewer: {
    id: 'reviewer', displayName: 'Paid reviewer', ownerId: 'independent', modelFamily: 'analysis', evidenceRoutes: ['primary'], capabilities: ['source verification'],
    wallet: '0x1111111111111111111111111111111111111111', status: 'ACTIVE', procurementEndpoint: 'https://reviewer.example/procure', procurementProtocol: 'CROSSEXAM_SIGNED_CALLBACK_V1',
  },
}
const input = {
  jobId: 'rj_11111111-1111-4111-8111-111111111111', scopeId: 'evidence-integrity', reviewerId: 'reviewer', idempotencyKey: 'rj_11111111-1111-4111-8111-111111111111:evidence-integrity',
  task: {
    schemaVersion: '0.1' as const, taskId: 'RT-1', decisionId: 'DP-1', valueAtRiskUsd: 1_000, scope: { id: 'evidence-integrity', title: 'Evidence', objective: 'Verify', requiredCapability: 'source verification' }, claims: [{ id: 'C-1', statement: 'A premise.', materiality: 0.9 }],
    instructions: [], deliveryRequirements: { addressEveryClaim: true as const, requireTraceableArtifact: true as const, requireArtifactContentHash: true as const, requireFindingArtifactReferences: true as const, acceptedVerdicts: ['SUPPORTS', 'CONTRADICTS', 'INSUFFICIENT_EVIDENCE'] as ['SUPPORTS', 'CONTRADICTS', 'INSUFFICIENT_EVIDENCE'] },
    withheldContext: ['origin_recommendation', 'other_reviewer_findings', 'aggregate_verdict'] as ['origin_recommendation', 'other_reviewer_findings', 'aggregate_verdict'],
  },
}

describe('X402ReviewProvider', () => {
  it('refuses a 402 requirement outside its asset and atomic spend policy before it signs anything', async () => {
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: 'https://reviewer.example/procure' },
      accepts: [{ scheme: 'exact', network: 'eip155:196', asset: '0x6666666666666666666666666666666666666666', amount: '999999', payTo: '0x2222222222222222222222222222222222222222', maxTimeoutSeconds: 60, extra: {} }],
    }
    const provider = new X402ReviewProvider({
      registry, signingKey, maxPerScopeAtomic: 250000n, allowedAssets: [asset], callbackBaseUrl: 'https://crossexam.example',
      fetchImpl: async () => new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired) } }),
    })

    await expect(provider.requestReview(input)).rejects.toThrow('spend policy')
  })

  it('rejects an external reviewer that tries to accept work without an x402 payment challenge', async () => {
    const provider = new X402ReviewProvider({
      registry, signingKey, maxPerScopeAtomic: 250000n, allowedAssets: [asset], callbackBaseUrl: 'https://crossexam.example',
      fetchImpl: async () => new Response(JSON.stringify({ requestId: 'unpaid' }), { status: 201 }),
    })

    await expect(provider.requestReview(input)).rejects.toThrow('Payment Required')
  })

  it('normalizes a paid CertiK token scan into explicit procurement evidence without claiming a reviewer signature', async () => {
    const evidenceRegistry: ReviewerRegistry = {
      certik: {
        ...registry.reviewer,
        id: 'certik', displayName: 'CertiK Token Scan', ownerId: 'certik', capabilities: ['contract token risk'],
        procurementEndpoint: 'https://skills-for-okx.certik.com/api/token-scan', procurementProtocol: 'PAID_EVIDENCE_V1', responseAdapter: 'CERTIK_TOKEN_SCAN_V1', paymentRecipient: '0x2222222222222222222222222222222222222222',
      },
    }
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: 'https://skills-for-okx.certik.com/api/token-scan?chain=eth&address=0x1111111111111111111111111111111111111111' },
      accepts: [{ scheme: 'exact', network: 'eip155:196', asset, amount: '1000', payTo: '0x2222222222222222222222222222222222222222', maxTimeoutSeconds: 60, extra: { name: 'USDT', version: '1' } }],
    }
    let calls = 0
    const provider = new X402ReviewProvider({
      registry: evidenceRegistry, signingKey, maxPerScopeAtomic: 250000n, allowedAssets: [asset], callbackBaseUrl: 'https://crossexam.example',
      fetchImpl: async (url, init) => {
        calls += 1
        expect(url).toBe('https://skills-for-okx.certik.com/api/token-scan?chain=eth&address=0x1111111111111111111111111111111111111111')
        expect(init.method).toBe('GET')
        if (calls === 1) return new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired) } })
        return new Response(JSON.stringify({ summary: { score: 20, alert_count: 2, highest_alert_level: 'Critical' } }), {
          status: 200,
          headers: { 'PAYMENT-RESPONSE': encodePaymentResponseHeader({ success: true, status: 'success', transaction: `0x${'2'.repeat(64)}`, network: 'eip155:196', amount: '1000' }) },
        })
      },
    })
    const result = await provider.requestReview({
      ...input,
      reviewerId: 'certik',
      scopeId: 'contract-token-risk',
      task: { ...input.task, scope: { ...input.task.scope, id: 'contract-token-risk', requiredCapability: 'contract token risk' }, actionBinding: { actionType: 'TRADE', target: 'evm:1:0x3333333333333333333333333333333333333333', parametersHash: `0x${'3'.repeat(64)}` }, reviewEvidenceContext: { tokenRiskTarget: 'token:eth:0x1111111111111111111111111111111111111111' } },
    })

    expect(result.evidence?.delivery.provenance?.kind).toBe('X402_PAID_EVIDENCE_V1')
    expect(result.evidence?.delivery.findings[0]).toMatchObject({ verdict: 'CONTRADICTS', confidence: 0.9 })
    expect(calls).toBe(2)
  })

  it('does not sign a paid-evidence request when its challenge recipient differs from the registry', async () => {
    const evidenceRegistry: ReviewerRegistry = {
      certik: {
        ...registry.reviewer,
        id: 'certik', capabilities: ['contract token risk'], procurementEndpoint: 'https://skills-for-okx.certik.com/api/token-scan', procurementProtocol: 'PAID_EVIDENCE_V1', responseAdapter: 'CERTIK_TOKEN_SCAN_V1', paymentRecipient: '0x3333333333333333333333333333333333333333',
      },
    }
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: 'https://skills-for-okx.certik.com/api/token-scan' },
      accepts: [{ scheme: 'exact', network: 'eip155:196', asset, amount: '1000', payTo: '0x2222222222222222222222222222222222222222', maxTimeoutSeconds: 60, extra: { name: 'USDT', version: '1' } }],
    }
    const provider = new X402ReviewProvider({
      registry: evidenceRegistry, signingKey, maxPerScopeAtomic: 250000n, allowedAssets: [asset], callbackBaseUrl: 'https://crossexam.example',
      fetchImpl: async () => new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired) } }),
    })
    await expect(provider.requestReview({
      ...input, reviewerId: 'certik', scopeId: 'contract-token-risk',
      task: { ...input.task, scope: { ...input.task.scope, id: 'contract-token-risk', requiredCapability: 'contract token risk' }, actionBinding: { actionType: 'TRADE', target: 'token:eth:0x1111111111111111111111111111111111111111', parametersHash: `0x${'3'.repeat(64)}` } },
    })).rejects.toThrow('payment recipient')
  })

  it('records authenticated OKX liquidity evidence under included quota without inventing a settlement', async () => {
    const marketRegistry: ReviewerRegistry = {
      market: {
        id: 'market', displayName: 'OKX Onchain OS Market', ownerId: 'okx-market', modelFamily: 'market-data',
        evidenceRoutes: ['okx-liquidity'], capabilities: ['execution liquidity'], status: 'ACTIVE', selectionPriority: 100,
        procurementEndpoint: 'https://web3.okx.com/api/v6/dex/market/token/top-liquidity',
        procurementProtocol: 'AUTHENTICATED_API_EVIDENCE_V1', responseAdapter: 'OKX_TOKEN_LIQUIDITY_V1', estimatedUnitCostUsdt: 0.005,
      },
    }
    const provider = new X402ReviewProvider({
      registry: marketRegistry, signingKey, maxPerScopeAtomic: 250000n, allowedAssets: [asset], callbackBaseUrl: 'https://crossexam.example',
      okxMarketCredentials: { apiKey: 'key', secretKey: 'secret', passphrase: 'passphrase' },
      fetchImpl: async (url, init) => {
        expect(url).toContain('chainIndex=196')
        expect(url).toContain('tokenContractAddress=0x1111111111111111111111111111111111111111')
        expect(new Headers(init.headers).get('ok-access-key')).toBe('key')
        expect(new Headers(init.headers).get('ok-access-sign')).toBeTruthy()
        return new Response(JSON.stringify({ code: '0', data: [{ pool: 'TOKEN/USDT', liquidityUsd: '5000' }], msg: '' }), { status: 200 })
      },
    })
    const result = await provider.requestReview({
      ...input,
      reviewerId: 'market',
      scopeId: 'execution-liquidity',
      task: {
        ...input.task,
        valueAtRiskUsd: 1_000,
        scope: { ...input.task.scope, id: 'execution-liquidity', requiredCapability: 'execution liquidity' },
        reviewEvidenceContext: { tokenRiskTarget: 'token:xlayer:0x1111111111111111111111111111111111111111' },
      },
    })
    expect(result.payment).toBeUndefined()
    expect(result.includedQuota).toEqual({ sourceId: 'market' })
    expect(result.evidence?.provenance.kind).toBe('AUTHENTICATED_API_EVIDENCE_V1')
    expect(result.evidence?.delivery.findings[0]).toMatchObject({ verdict: 'CONTRADICTS', confidence: 0.9 })
  })
})
