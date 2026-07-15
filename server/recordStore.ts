import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DecisionAssuranceRecord } from './assuranceRecord'
import type { SignedClaimOutcomeAdjudication } from './outcomeAttestation'

export type RecordSaveResult = 'CREATED' | 'EXISTING'

export interface AssuranceRecordStore {
  save(record: DecisionAssuranceRecord): Promise<RecordSaveResult>
  find(recordId: string): Promise<DecisionAssuranceRecord | null>
  issueReadAccess(recordId: string, ttlSeconds: number, now?: Date): Promise<{ token: string; expiresAt: string }>
  canRead(recordId: string, token: string, now?: Date): Promise<boolean>
  saveOutcome(outcome: SignedClaimOutcomeAdjudication): Promise<RecordSaveResult>
}

function assertRecordId(recordId: string) {
  if (!/^dar_[a-f0-9]{24}$/.test(recordId)) throw new Error('Invalid Decision Assurance Record identifier.')
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Local durable store for development and single-instance deployment. Records
 * are content addressed and written with an atomic link operation, so a later
 * write cannot silently replace a record with the same ID. The interface is a
 * production seam for a managed database/object-store implementation.
 */
export class FileAssuranceRecordStore implements AssuranceRecordStore {
  private readonly recordsDirectory: string
  private readonly grantsDirectory: string
  private readonly outcomesDirectory: string

  constructor(dataDirectory: string) {
    this.recordsDirectory = join(dataDirectory, 'records')
    this.grantsDirectory = join(dataDirectory, 'grants')
    this.outcomesDirectory = join(dataDirectory, 'outcomes')
  }

  async save(record: DecisionAssuranceRecord): Promise<RecordSaveResult> {
    assertRecordId(record.recordId)
    await mkdir(this.recordsDirectory, { recursive: true })
    const destination = join(this.recordsDirectory, `${record.recordId}.json`)
    const serialized = `${JSON.stringify(record, null, 2)}\n`

    try {
      const existing = await readFile(destination, 'utf8')
      if (existing !== serialized) throw new Error('Record ID collision: existing record content differs.')
      return 'EXISTING'
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }

    const temporary = join(this.recordsDirectory, `.${record.recordId}.${randomUUID()}.tmp`)
    await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
    try {
      await link(temporary, destination)
      return 'CREATED'
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      const existing = await readFile(destination, 'utf8')
      if (existing !== serialized) throw new Error('Record ID collision: existing record content differs.')
      return 'EXISTING'
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async find(recordId: string): Promise<DecisionAssuranceRecord | null> {
    assertRecordId(recordId)
    try {
      return JSON.parse(await readFile(join(this.recordsDirectory, `${recordId}.json`), 'utf8')) as DecisionAssuranceRecord
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }

  async issueReadAccess(recordId: string, ttlSeconds: number, now = new Date()) {
    assertRecordId(recordId)
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60) throw new Error('Record access TTL must be at least 60 seconds.')
    if (!await this.find(recordId)) throw new Error('Cannot issue access for a record that does not exist.')

    await mkdir(this.grantsDirectory, { recursive: true })
    const token = `darv_${randomBytes(32).toString('base64url')}`
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString()
    const grant = JSON.stringify({ recordId, expiresAt }, null, 2)
    await writeFile(join(this.grantsDirectory, `${tokenHash(token)}.json`), `${grant}\n`, { encoding: 'utf8', flag: 'wx' })
    return { token, expiresAt }
  }

  async canRead(recordId: string, token: string, now = new Date()) {
    assertRecordId(recordId)
    if (!token.startsWith('darv_')) return false
    try {
      const grant = JSON.parse(await readFile(join(this.grantsDirectory, `${tokenHash(token)}.json`), 'utf8')) as { recordId: string; expiresAt: string }
      return grant.recordId === recordId && new Date(grant.expiresAt).getTime() > now.getTime()
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }

  /**
   * Stores one authority's immutable resolution for a record claim. A later
   * write under the same authority/record/claim key must be byte-identical;
   * authorities cannot quietly revise history in-place.
   */
  async saveOutcome(outcome: SignedClaimOutcomeAdjudication): Promise<RecordSaveResult> {
    assertRecordId(outcome.recordId)
    await mkdir(this.outcomesDirectory, { recursive: true })
    const key = createHash('sha256').update(`${outcome.recordId}\n${outcome.claimId}\n${outcome.authority.id}`).digest('hex')
    const destination = join(this.outcomesDirectory, `${key}.json`)
    const serialized = `${JSON.stringify(outcome, null, 2)}\n`
    try {
      const existing = await readFile(destination, 'utf8')
      if (existing !== serialized) throw new Error('Outcome adjudication conflict: this authority already resolved the record claim.')
      return 'EXISTING'
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    const temporary = join(this.outcomesDirectory, `.${key}.${randomUUID()}.tmp`)
    await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
    try {
      await link(temporary, destination)
      return 'CREATED'
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      const existing = await readFile(destination, 'utf8')
      if (existing !== serialized) throw new Error('Outcome adjudication conflict: this authority already resolved the record claim.')
      return 'EXISTING'
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
