import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { createActionBinding } from '../src/domain/actionBinding'
import { evaluatePreAction } from '../src/domain/preActionGate'
import { createReviewPlan } from '../src/domain/reviewPlan'
import type { DecisionPackage, Finding } from '../src/domain/types'
import { acceptReviewDelivery, stageReviewPlan, type ReviewDelivery, type ReviewerProfile } from '../src/network/reviewNetwork'
import { aggregateNetworkVerifiedAssurance } from './assuranceService'
import { deliveryPayloadHash } from './deliveryAttestation'
import { deriveReviewerOutcomeEvents, type ClaimOutcomeAdjudication } from './outcomeAdjudication'
import { outcomePayloadHash, verifyOutcomeAttestation, type SignedClaimOutcomeAdjudication } from './outcomeAttestation'
import { FileAssuranceRecordStore } from './recordStore'
import { loadReviewerReliabilityProfile } from './reliabilityService'

const accounts = [
  privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123'),
  privateKeyToAccount('0x1123456789012345678901234567890123456789012345678901234567890123'),
  privateKeyToAccount('0x2123456789012345678901234567890123456789012345678901234567890123'),
]
const outcomeAuthority = privateKeyToAccount('0x3123456789012345678901234567890123456789012345678901234567890123')

async function signedDelivery(dispatchId: string, decisionId: string, scopeId: string, delivery: ReviewDelivery) {
  const account = accounts.find((_candidate, index) => delivery.reviewerId === reviewers[index].id)
  if (!account) throw new Error('Demo reviewer account was not found.')
  const payloadHash = deliveryPayloadHash({ dispatchId, decisionId, scopeId, delivery })
  return { ...delivery, attestation: { scheme: 'EIP191' as const, payloadHash, signature: await account.signMessage({ message: { raw: payloadHash } }) } }
}

const reviewers: ReviewerProfile[] = [
  { id: 'liquidity-scout', displayName: 'Liquidity Scout', ownerId: 'onchain-labs', modelFamily: 'onchain', evidenceRoutes: ['dex'], capabilities: ['source verification'] },
  { id: 'assumption-challenger', displayName: 'Assumption Challenger', ownerId: 'research-guild', modelFamily: 'retrieval', evidenceRoutes: ['primary-web'], capabilities: ['adversarial research'] },
  { id: 'risk-specialist', displayName: 'Risk Specialist', ownerId: 'risk-lab', modelFamily: 'static-analysis', evidenceRoutes: ['bytecode'], capabilities: ['domain specialist'] },
]

async function main() {
  const actionBinding = await createActionBinding('TRADE', 'xlayer:demo-pool', '{"side":"buy","amount":"1000"}')
  const decision: DecisionPackage = {
    id: 'DP-OFFLINE-DEMO', title: 'Execute a X Layer position', valueAtRiskUsd: 2500, actionBinding,
    claims: [
      { id: 'C-1', statement: 'Usable liquidity keeps price impact below 1%.', materiality: 0.92 },
      { id: 'C-2', statement: 'The asset has no privileged transfer block.', materiality: 0.84 },
      { id: 'C-3', statement: 'The proposed timing has a current primary-source catalyst.', materiality: 0.76 },
    ],
  }
  const plan = createReviewPlan(decision)
  let dispatch = stageReviewPlan(plan, reviewers)
  for (const assignment of dispatch.assignments) {
    const reviewerId = assignment.reviewer!.id
    const findings: Finding[] = decision.claims.map((claim) => ({
      claimId: claim.id,
      reviewerId,
      verdict: claim.id === 'C-1' && reviewerId === 'assumption-challenger' ? 'CONTRADICTS' : claim.id === 'C-3' && reviewerId === 'risk-specialist' ? 'INSUFFICIENT_EVIDENCE' : 'SUPPORTS',
      confidence: 0.9,
      materiality: claim.materiality,
      evidence: claim.id === 'C-1' && reviewerId === 'assumption-challenger' ? 'Reconstructed executable depth is below the stated threshold.' : 'Traceable independent review evidence.',
    }))
    const unsigned: ReviewDelivery = {
      reviewerId, deliveredAt: '2026-07-15T00:00:00.000Z',
      artifacts: [{ id: `E-${reviewerId}`, kind: 'PRIMARY_SOURCE', locator: `https://example.com/${reviewerId}`, observedAt: '2026-07-15T00:00:00.000Z', excerpt: 'Traceable review artifact.' }],
      findings,
    }
    dispatch = acceptReviewDelivery(plan, dispatch, assignment.scopeId, await signedDelivery(dispatch.id, decision.id, assignment.scopeId, unsigned))
  }

  const reviewerWallets = Object.fromEntries(reviewers.map((reviewer, index) => [reviewer.id, accounts[index].address]))
  const record = await aggregateNetworkVerifiedAssurance({ decision, dispatch }, reviewerWallets, '2026-07-15T00:01:00.000Z')
  const dataDirectory = await mkdtemp(join(tmpdir(), 'crossexam-offline-demo-'))
  const store = new FileAssuranceRecordStore(dataDirectory)
  await store.save(record)
  const unsignedOutcome: ClaimOutcomeAdjudication = {
    schemaVersion: '0.1', recordId: record.recordId, claimId: 'C-1', exPostAdjudication: 'CONTRADICTED', adjudicatedAt: '2026-07-15T00:10:00.000Z',
    authority: { id: 'xlayer-demo-finality', kind: 'ONCHAIN_FINALITY' },
    evidence: { locator: 'xlayer://demo/0xoutcome', observedAt: '2026-07-15T00:10:00.000Z', excerpt: 'Finalized result contradicts the liquidity premise.' },
  }
  const payloadHash = outcomePayloadHash(unsignedOutcome)
  const outcome: SignedClaimOutcomeAdjudication = { ...unsignedOutcome, attestation: { scheme: 'EIP191', payloadHash, signature: await outcomeAuthority.signMessage({ message: { raw: payloadHash } }) } }
  await verifyOutcomeAttestation({ outcome, authorityWallets: { 'xlayer-demo-finality': outcomeAuthority.address } })
  const outcomeEvents = deriveReviewerOutcomeEvents(record, outcome)
  await store.saveOutcome(outcome)
  const profile = await loadReviewerReliabilityProfile('assumption-challenger', store)
  const gate = evaluatePreAction({ recordId: record.recordId, decisionId: decision.id, valueAtRiskUsd: decision.valueAtRiskUsd, attributionStatus: record.attributionStatus, result: record.result, actionBinding }, {
    decisionId: decision.id, valueAtRiskUsd: decision.valueAtRiskUsd, ...actionBinding,
  })

  console.log(JSON.stringify({
    demo: 'offline lifecycle complete',
    record: { id: record.recordId, attributionStatus: record.attributionStatus, action: record.result.action, reversalConditions: record.result.reversalConditions.length },
    executionGate: { status: gate.status, executable: gate.executable, requiredClaimIds: gate.requiredClaimIds },
    outcome: { authority: outcome.authority.id, reviewerEventsAccepted: outcomeEvents.length },
    challengerReliability: profile,
    temporaryDataDirectory: dataDirectory,
  }, null, 2))
}

void main()
