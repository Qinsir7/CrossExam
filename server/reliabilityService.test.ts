import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileAssuranceRecordStore } from './recordStore'
import { loadReviewerReliabilityProfile } from './reliabilityService'
import type { DecisionAssuranceRecord } from './assuranceRecord'
import type { SignedClaimOutcomeAdjudication } from './outcomeAttestation'

const directories: string[] = []

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'crossexam-reliability-'))
  directories.push(directory)
  return new FileAssuranceRecordStore(directory)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function assurance(): DecisionAssuranceRecord {
  const claims = Array.from({ length: 5 }, (_, index) => ({ id: `C-${index + 1}`, statement: 'A material premise holds.', materiality: 0.9 }))
  return {
    schemaVersion: '0.1', recordId: 'dar_1234567890abcdef12345678', issuedAt: '2026-07-15T00:00:00.000Z', attributionStatus: 'NETWORK_VERIFIED',
    decision: { id: 'DP-REPUTATION', title: 'Reputation proof', valueAtRiskUsd: 1000, claims },
    dispatch: {
      id: 'RD-REPUTATION', decisionId: 'DP-REPUTATION', status: 'DELIVERED',
      assignments: [{
        scopeId: 'assumption-challenge', status: 'DELIVERED', reason: 'Delivered.',
        reviewer: { id: 'challenger', displayName: 'Challenger', ownerId: 'owner-a', modelFamily: 'model-a', evidenceRoutes: ['primary'] },
        delivery: {
          reviewerId: 'challenger', deliveredAt: '2026-07-15T00:00:00.000Z',
          artifacts: [{ id: 'E-1', kind: 'PRIMARY_SOURCE', locator: 'https://example.com/outcome', observedAt: '2026-07-15T00:00:00.000Z', excerpt: 'Traceable evidence.' }],
          findings: claims.map((claim) => ({ claimId: claim.id, reviewerId: 'challenger', verdict: 'CONTRADICTS', confidence: 0.9, materiality: 0.9, evidence: 'The evidence contradicts the claim.' })),
        },
      }],
    },
    result: { claims: [], action: 'HOLD', effectiveIndependence: 1, materialRefutations: 5, materialUnresolved: 0, reversalConditions: [] },
  }
}

function outcome(recordId: string, claimId: string): SignedClaimOutcomeAdjudication {
  return {
    schemaVersion: '0.1', recordId, claimId, exPostAdjudication: 'CONTRADICTED', adjudicatedAt: '2026-07-15T00:10:00.000Z',
    authority: { id: 'xlayer-finality', kind: 'ONCHAIN_FINALITY' },
    evidence: { locator: `xlayer://tx/${claimId}`, observedAt: '2026-07-15T00:10:00.000Z', excerpt: 'Finalized outcome.' },
    attestation: { scheme: 'EIP191', payloadHash: '0x1234', signature: '0x1234' },
  }
}

describe('loadReviewerReliabilityProfile', () => {
  it('rebuilds an established score only from persisted, ex-post outcomes', async () => {
    const recordStore = await store()
    const record = assurance()
    await recordStore.save(record)
    await Promise.all(record.decision.claims.map((claim) => recordStore.saveOutcome(outcome(record.recordId, claim.id))))

    const profile = await loadReviewerReliabilityProfile('challenger', recordStore)

    expect(profile).toMatchObject({ status: 'ESTABLISHED', independentlyResolvedClaims: 5, materialAccuracy: 1 })
    expect(profile.reliabilityScore).toBe(0.9)
  })

  it('rejects unsafe reviewer identifiers before touching persistence', async () => {
    await expect(loadReviewerReliabilityProfile('../challenger', await store())).rejects.toThrow('Invalid reviewer')
  })
})
