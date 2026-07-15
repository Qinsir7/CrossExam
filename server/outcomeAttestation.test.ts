import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { outcomePayloadHash, verifyOutcomeAttestation, type SignedClaimOutcomeAdjudication } from './outcomeAttestation'

const account = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')

async function signedOutcome(): Promise<SignedClaimOutcomeAdjudication> {
  const outcome = {
    schemaVersion: '0.1' as const, recordId: 'dar_1234567890abcdef12345678', claimId: 'C-1', exPostAdjudication: 'CONTRADICTED' as const,
    adjudicatedAt: '2026-07-15T01:00:00.000Z', authority: { id: 'xlayer-finality', kind: 'ONCHAIN_FINALITY' as const },
    evidence: { locator: 'xlayer://tx/0xoutcome', observedAt: '2026-07-15T01:00:00.000Z', excerpt: 'Finalized execution outcome.' },
  }
  const payloadHash = outcomePayloadHash(outcome)
  return { ...outcome, attestation: { scheme: 'EIP191', payloadHash, signature: await account.signMessage({ message: { raw: payloadHash } }) } }
}

describe('verifyOutcomeAttestation', () => {
  it('accepts a registered authority signature for the exact outcome', async () => {
    await expect(verifyOutcomeAttestation({ outcome: await signedOutcome(), authorityWallets: { 'xlayer-finality': account.address } })).resolves.toBeUndefined()
  })

  it('rejects an outcome that was changed after signing', async () => {
    const outcome = await signedOutcome()
    await expect(verifyOutcomeAttestation({
      outcome: { ...outcome, evidence: { ...outcome.evidence, excerpt: 'Tampered outcome.' } },
      authorityWallets: { 'xlayer-finality': account.address },
    })).rejects.toThrow('payload hash')
  })
})
