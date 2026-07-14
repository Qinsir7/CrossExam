import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { deliveryPayloadHash, verifyDeliveryAttestation, type SignedReviewDelivery } from './deliveryAttestation'

const account = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
const baseDelivery = {
  reviewerId: 'reviewer-1',
  deliveredAt: '2026-07-14T17:00:00.000Z',
  artifacts: [{ id: 'E-1', kind: 'PRIMARY_SOURCE' as const, locator: 'https://example.com/source', observedAt: '2026-07-14T16:59:00.000Z', excerpt: 'Evidence excerpt.' }],
  findings: [{ claimId: 'C-1', reviewerId: 'reviewer-1', verdict: 'SUPPORTS' as const, confidence: 0.8, materiality: 0.9, evidence: 'Evidence supports the claim.' }],
}

async function signedDelivery(): Promise<SignedReviewDelivery> {
  const hash = deliveryPayloadHash({ dispatchId: 'RD-1', decisionId: 'DP-1', scopeId: 'evidence-integrity', delivery: baseDelivery })
  const signature = await account.signMessage({ message: { raw: hash } })
  return { ...baseDelivery, attestation: { scheme: 'EIP191', payloadHash: hash, signature } }
}

describe('verifyDeliveryAttestation', () => {
  it('accepts the registered wallet signature for the exact review delivery', async () => {
    await expect(verifyDeliveryAttestation({
      dispatchId: 'RD-1', decisionId: 'DP-1', scopeId: 'evidence-integrity', delivery: await signedDelivery(),
      reviewerWallets: { 'reviewer-1': account.address },
    })).resolves.toBeUndefined()
  })

  it('rejects a signature if the delivery evidence changes after signing', async () => {
    const signed = await signedDelivery()
    const tampered = { ...signed, findings: [{ ...signed.findings[0], evidence: 'Tampered evidence.' }] }

    await expect(verifyDeliveryAttestation({
      dispatchId: 'RD-1', decisionId: 'DP-1', scopeId: 'evidence-integrity', delivery: tampered,
      reviewerWallets: { 'reviewer-1': account.address },
    })).rejects.toThrow('payload hash')
  })

  it('rejects a signature when the reviewer is not in the verified registry', async () => {
    await expect(verifyDeliveryAttestation({
      dispatchId: 'RD-1', decisionId: 'DP-1', scopeId: 'evidence-integrity', delivery: await signedDelivery(), reviewerWallets: {},
    })).rejects.toThrow('verified wallet registry')
  })
})
