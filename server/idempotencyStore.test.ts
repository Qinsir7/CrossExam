import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileAssuranceIdempotencyStore, requestFingerprint } from './idempotencyStore'

const directories: string[] = []
const key = 'client-retry-key-0123456789abcdef'
const route = 'POST /api/v1/assurance/network-aggregate'
const recordId = 'dar_1234567890abcdef12345678'

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'crossexam-idempotency-'))
  directories.push(directory)
  return new FileAssuranceIdempotencyStore(directory)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('FileAssuranceIdempotencyStore', () => {
  it('replays only the exact completed request', async () => {
    const idempotency = await store()
    const fingerprint = requestFingerprint(route, { decision: { id: 'DP-1' } })
    await idempotency.complete(route, key, fingerprint, recordId, '2026-07-15T00:00:00.000Z')

    await expect(idempotency.lookup(route, key, fingerprint)).resolves.toEqual({ status: 'MATCH', recordId })
    await expect(idempotency.lookup(route, key, requestFingerprint(route, { decision: { id: 'DP-2' } }))).resolves.toEqual({ status: 'CONFLICT' })
  })

  it('canonicalizes object key order when fingerprinting a request', () => {
    expect(requestFingerprint(route, { b: 2, a: 1 })).toBe(requestFingerprint(route, { a: 1, b: 2 }))
  })
})
