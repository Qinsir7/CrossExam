import { encodePaymentRequiredHeader } from '@okxweb3/x402-core/http'
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
    schemaVersion: '0.1' as const, taskId: 'RT-1', decisionId: 'DP-1', scope: { id: 'evidence-integrity', title: 'Evidence', objective: 'Verify', requiredCapability: 'source verification' }, claims: [{ id: 'C-1', statement: 'A premise.', materiality: 0.9 }],
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
})
