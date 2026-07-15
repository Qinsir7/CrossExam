import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type IdempotencyLookup =
  | { status: 'MISSING' }
  | { status: 'MATCH'; recordId: string }
  | { status: 'CONFLICT' }

export interface AssuranceIdempotencyStore {
  lookup(route: string, key: string, fingerprint: string): Promise<IdempotencyLookup>
  complete(route: string, key: string, fingerprint: string, recordId: string, completedAt?: string): Promise<void>
}

function assertKey(key: string) {
  if (!/^[A-Za-z0-9._~-]{32,200}$/.test(key)) {
    throw new Error('Idempotency-Key must contain 32 to 200 URL-safe characters.')
  }
}

function assertRecordId(recordId: string) {
  if (!/^dar_[a-f0-9]{24}$/.test(recordId)) throw new Error('Invalid Decision Assurance Record identifier.')
}

function location(route: string, key: string) {
  return createHash('sha256').update(`${route}\n${key}`).digest('hex')
}

type StoredEntry = { route: string; fingerprint: string; recordId: string; completedAt: string }

/**
 * Keeps only a hash-derived filename, never the caller's raw idempotency key.
 * The completed mapping is immutable: a retried request may recover the same
 * economic result, but it cannot repurpose an existing key for new work.
 */
export class FileAssuranceIdempotencyStore implements AssuranceIdempotencyStore {
  private readonly directory: string

  constructor(dataDirectory: string) {
    this.directory = join(dataDirectory, 'idempotency')
  }

  async lookup(route: string, key: string, fingerprint: string): Promise<IdempotencyLookup> {
    assertKey(key)
    try {
      const entry = JSON.parse(await readFile(join(this.directory, `${location(route, key)}.json`), 'utf8')) as StoredEntry
      if (entry.route !== route || entry.fingerprint !== fingerprint) return { status: 'CONFLICT' }
      return { status: 'MATCH', recordId: entry.recordId }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { status: 'MISSING' }
      throw error
    }
  }

  async complete(route: string, key: string, fingerprint: string, recordId: string, completedAt = new Date().toISOString()) {
    assertKey(key)
    assertRecordId(recordId)
    await mkdir(this.directory, { recursive: true })
    const destination = join(this.directory, `${location(route, key)}.json`)
    const serialized = `${JSON.stringify({ route, fingerprint, recordId, completedAt }, null, 2)}\n`
    try {
      const existing = await readFile(destination, 'utf8')
      const entry = JSON.parse(existing) as StoredEntry
      if (entry.route !== route || entry.fingerprint !== fingerprint || entry.recordId !== recordId) {
        throw new Error('Idempotency key conflict: it is already bound to a different completed request.')
      }
      return
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    const temporary = join(this.directory, `.${randomUUID()}.tmp`)
    await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
    try {
      await link(temporary, destination)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      const entry = JSON.parse(await readFile(destination, 'utf8')) as StoredEntry
      if (entry.route !== route || entry.fingerprint !== fingerprint || entry.recordId !== recordId) {
        throw new Error('Idempotency key conflict: it is already bound to a different completed request.')
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

export function requestFingerprint(route: string, body: unknown) {
  return createHash('sha256').update(`${route}\n${canonicalize(body)}`).digest('hex')
}
