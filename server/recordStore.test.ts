import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { issueDecisionAssuranceRecord } from './assuranceRecord'
import { FileAssuranceRecordStore } from './recordStore'
import type { CrossExamResult, DecisionPackage } from '../src/domain/types'
import type { ReviewDispatch } from '../src/network/reviewNetwork'

const directories: string[] = []

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'crossexam-records-'))
  directories.push(directory)
  return new FileAssuranceRecordStore(directory)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const decision: DecisionPackage = { id: 'DP-STORE', title: 'Persist record', valueAtRiskUsd: 1, claims: [] }
const dispatch: ReviewDispatch = { id: 'RD-STORE', decisionId: 'DP-STORE', status: 'DELIVERED', assignments: [] }
const result: CrossExamResult = { claims: [], action: 'PROCEED', effectiveIndependence: 0, materialRefutations: 0, materialUnresolved: 0, reversalConditions: [] }

describe('FileAssuranceRecordStore', () => {
  it('persists and retrieves an assurance record', async () => {
    const record = issueDecisionAssuranceRecord(decision, dispatch, result, '2026-07-15T00:00:00.000Z')
    const recordStore = await store()

    expect(await recordStore.save(record)).toBe('CREATED')
    expect(await recordStore.find(record.recordId)).toEqual(record)
  })

  it('is idempotent for the exact same content but refuses an ID collision', async () => {
    const record = issueDecisionAssuranceRecord(decision, dispatch, result, '2026-07-15T00:00:00.000Z')
    const recordStore = await store()
    await recordStore.save(record)

    expect(await recordStore.save(record)).toBe('EXISTING')
    await expect(recordStore.save({ ...record, result: { ...record.result, action: 'HOLD' } })).rejects.toThrow('collision')
  })

  it('does not allow a filesystem path to be supplied as a record identifier', async () => {
    const recordStore = await store()

    await expect(recordStore.find('../secrets')).rejects.toThrow('Invalid')
  })

  it('issues expiring record-specific read access without storing the bearer token itself', async () => {
    const record = issueDecisionAssuranceRecord(decision, dispatch, result, '2026-07-15T00:00:00.000Z')
    const recordStore = await store()
    await recordStore.save(record)
    const grant = await recordStore.issueReadAccess(record.recordId, 60, new Date('2026-07-15T00:00:00.000Z'))

    await expect(recordStore.canRead(record.recordId, grant.token, new Date('2026-07-15T00:00:30.000Z'))).resolves.toBe(true)
    await expect(recordStore.canRead(record.recordId, `${grant.token}wrong`, new Date('2026-07-15T00:00:30.000Z'))).resolves.toBe(false)
    await expect(recordStore.canRead(record.recordId, grant.token, new Date('2026-07-15T00:01:00.000Z'))).resolves.toBe(false)
  })
})
