import { buildReviewerReliabilityProfile, type ReviewerReliabilityProfile } from '../src/network/reliability'
import { deriveReviewerOutcomeEvents } from './outcomeAdjudication'
import type { AssuranceRecordStore } from './recordStore'

function assertReviewerId(reviewerId: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(reviewerId)) throw new Error('Invalid reviewer identifier.')
}

/**
 * Rebuilds a public reviewer profile from immutable, authority-signed outcomes
 * rather than maintaining a mutable score cache. This makes every displayed
 * score reproducible from the persisted evidence trail.
 */
export async function loadReviewerReliabilityProfile(
  reviewerId: string,
  recordStore: AssuranceRecordStore,
): Promise<ReviewerReliabilityProfile> {
  assertReviewerId(reviewerId)
  const outcomes = await recordStore.listOutcomes()
  const events = []
  for (const outcome of outcomes) {
    const record = await recordStore.find(outcome.recordId)
    if (!record) throw new Error('Persisted outcome references an unavailable assurance record.')
    events.push(...deriveReviewerOutcomeEvents(record, outcome))
  }
  return buildReviewerReliabilityProfile(reviewerId, events)
}
