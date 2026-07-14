import { keccak256, recoverMessageAddress, stringToHex, type Address, type Hex } from 'viem'
import type { ReviewDelivery } from '../src/network/reviewNetwork'

export type DeliveryAttestation = {
  scheme: 'EIP191'
  payloadHash: Hex
  signature: Hex
}

export type SignedReviewDelivery = ReviewDelivery & {
  attestation: DeliveryAttestation
}

export type ReviewerWalletRegistry = Record<string, Address>

type DeliverySigningPayload = {
  dispatchId: string
  decisionId: string
  scopeId: string
  reviewerId: string
  delivery: Omit<ReviewDelivery, 'attestation'>
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

export function deliveryPayloadHash(input: {
  dispatchId: string
  decisionId: string
  scopeId: string
  delivery: ReviewDelivery
}): Hex {
  const { attestation: _attestation, ...delivery } = input.delivery as SignedReviewDelivery
  const payload: DeliverySigningPayload = {
    dispatchId: input.dispatchId,
    decisionId: input.decisionId,
    scopeId: input.scopeId,
    reviewerId: delivery.reviewerId,
    delivery,
  }
  return keccak256(stringToHex(canonicalize(payload)))
}

/**
 * Verifies that a registry-bound reviewer's wallet signed the precise delivery
 * for this decision and scope. The dispatch/scope binding stops a valid review
 * from being replayed into a different procurement task.
 */
export async function verifyDeliveryAttestation(input: {
  dispatchId: string
  decisionId: string
  scopeId: string
  delivery: SignedReviewDelivery
  reviewerWallets: ReviewerWalletRegistry
}): Promise<void> {
  const expectedWallet = input.reviewerWallets[input.delivery.reviewerId]
  if (!expectedWallet) throw new Error('Reviewer is not present in the verified wallet registry.')

  const computedHash = deliveryPayloadHash(input)
  if (computedHash !== input.delivery.attestation.payloadHash) {
    throw new Error('Delivery attestation payload hash does not match the submitted review.')
  }

  const signer = await recoverMessageAddress({
    message: { raw: computedHash },
    signature: input.delivery.attestation.signature,
  })
  if (signer.toLowerCase() !== expectedWallet.toLowerCase()) {
    throw new Error('Delivery signature does not match the verified reviewer wallet.')
  }
}
