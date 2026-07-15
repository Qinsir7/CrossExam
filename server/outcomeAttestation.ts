import { keccak256, recoverMessageAddress, stringToHex, type Address, type Hex } from 'viem'
import type { ClaimOutcomeAdjudication } from './outcomeAdjudication'

export type OutcomeAuthorityWalletRegistry = Record<string, Address>

export type OutcomeAttestation = {
  scheme: 'EIP191'
  payloadHash: Hex
  signature: Hex
}

export type SignedClaimOutcomeAdjudication = ClaimOutcomeAdjudication & {
  attestation: OutcomeAttestation
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

export function outcomePayloadHash(outcome: ClaimOutcomeAdjudication): Hex {
  const { attestation: _attestation, ...payload } = outcome as SignedClaimOutcomeAdjudication
  return keccak256(stringToHex(canonicalize(payload)))
}

/** Requires the registered outcome authority to sign the exact ex-post claim resolution. */
export async function verifyOutcomeAttestation(input: {
  outcome: SignedClaimOutcomeAdjudication
  authorityWallets: OutcomeAuthorityWalletRegistry
}): Promise<void> {
  const expectedWallet = input.authorityWallets[input.outcome.authority.id]
  if (!expectedWallet) throw new Error('Outcome authority is not present in the verified wallet registry.')
  const computedHash = outcomePayloadHash(input.outcome)
  if (computedHash !== input.outcome.attestation.payloadHash) {
    throw new Error('Outcome attestation payload hash does not match the submitted adjudication.')
  }
  const signer = await recoverMessageAddress({
    message: { raw: computedHash },
    signature: input.outcome.attestation.signature,
  })
  if (signer.toLowerCase() !== expectedWallet.toLowerCase()) {
    throw new Error('Outcome signature does not match the verified authority wallet.')
  }
}
