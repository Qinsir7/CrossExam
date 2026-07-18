import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DecisionAssuranceRecord } from './assuranceRecord'
import type { SignedClaimOutcomeAdjudication } from './outcomeAttestation'
import type { SignedExecutionReceipt } from './executionReceipt'

export type RecordSaveResult = 'CREATED' | 'EXISTING'

export interface AssuranceRecordStore {
  checkHealth(): Promise<void>
  save(record: DecisionAssuranceRecord): Promise<RecordSaveResult>
  find(recordId: string): Promise<DecisionAssuranceRecord | null>
  issueReadAccess(recordId: string, ttlSeconds: number, now?: Date): Promise<{ token: string; expiresAt: string }>
  canRead(recordId: string, token: string, now?: Date): Promise<boolean>
  createPublicShare(recordId: string): Promise<{ token: string }>
  findPublicShare(token: string): Promise<string | null>
  revokePublicShare(token: string): Promise<void>
  saveOutcome(outcome: SignedClaimOutcomeAdjudication): Promise<RecordSaveResult>
  listOutcomes(): Promise<SignedClaimOutcomeAdjudication[]>
  saveExecution(receipt: SignedExecutionReceipt): Promise<RecordSaveResult>
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
  private readonly executionsDirectory: string
  private readonly sharesDirectory: string

  constructor(dataDirectory: string) {
    this.recordsDirectory = join(dataDirectory, 'records')
    this.grantsDirectory = join(dataDirectory, 'grants')
    this.outcomesDirectory = join(dataDirectory, 'outcomes')
    this.executionsDirectory = join(dataDirectory, 'executions')
    this.sharesDirectory = join(dataDirectory, 'shares')
  }

  async checkHealth() {
    await Promise.all([
      mkdir(this.recordsDirectory, { recursive: true }),
      mkdir(this.grantsDirectory, { recursive: true }),
      mkdir(this.outcomesDirectory, { recursive: true }),
      mkdir(this.executionsDirectory, { recursive: true }),
      mkdir(this.sharesDirectory, { recursive: true }),
    ])
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

  async createPublicShare(recordId: string) {
    assertRecordId(recordId)
    if (!await this.find(recordId)) throw new Error('Cannot share a record that does not exist.')
    await mkdir(this.sharesDirectory, { recursive: true })
    const token = `darshare_${randomBytes(24).toString('base64url')}`
    await writeFile(join(this.sharesDirectory, `${tokenHash(token)}.json`), `${JSON.stringify({ recordId })}\n`, { encoding: 'utf8', flag: 'wx' })
    return { token }
  }

  async findPublicShare(token: string) {
    if (!/^darshare_[A-Za-z0-9_-]{24,}$/.test(token)) return null
    try {
      const grant = JSON.parse(await readFile(join(this.sharesDirectory, `${tokenHash(token)}.json`), 'utf8')) as { recordId?: unknown }
      return typeof grant.recordId === 'string' && /^dar_[a-f0-9]{24}$/.test(grant.recordId) ? grant.recordId : null
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }

  async revokePublicShare(token: string) {
    if (!/^darshare_[A-Za-z0-9_-]{24,}$/.test(token)) throw new Error('Invalid public share token.')
    await rm(join(this.sharesDirectory, `${tokenHash(token)}.json`), { force: true })
  }

  /**
   * Stores one immutable resolution for a record claim. A later write for
   * that claim must be byte-identical; authorities cannot race a competing
   * conclusion into the reputation history or revise it in-place.
   */
  async saveOutcome(outcome: SignedClaimOutcomeAdjudication): Promise<RecordSaveResult> {
    assertRecordId(outcome.recordId)
    await mkdir(this.outcomesDirectory, { recursive: true })
    const key = createHash('sha256').update(`${outcome.recordId}\n${outcome.claimId}`).digest('hex')
    const destination = join(this.outcomesDirectory, `${key}.json`)
    const serialized = `${JSON.stringify(outcome, null, 2)}\n`
    try {
      const existing = await readFile(destination, 'utf8')
      if (existing !== serialized) throw new Error('Outcome adjudication conflict: this record claim already has an immutable resolution.')
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
      if (existing !== serialized) throw new Error('Outcome adjudication conflict: this record claim already has an immutable resolution.')
      return 'EXISTING'
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async listOutcomes(): Promise<SignedClaimOutcomeAdjudication[]> {
    try {
      const entries = (await readdir(this.outcomesDirectory)).filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry)).sort()
      return Promise.all(entries.map(async (entry) => JSON.parse(await readFile(join(this.outcomesDirectory, entry), 'utf8')) as SignedClaimOutcomeAdjudication))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
  }

  async saveExecution(receipt: SignedExecutionReceipt): Promise<RecordSaveResult> {
    assertRecordId(receipt.recordId)
    await mkdir(this.executionsDirectory, { recursive: true })
    const destination = join(this.executionsDirectory, `${receipt.recordId}.json`)
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`
    try {
      const existing = await readFile(destination, 'utf8')
      if (existing !== serialized) throw new Error('Execution receipt conflict: this assurance record already has an immutable execution receipt.')
      return 'EXISTING'
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    const temporary = join(this.executionsDirectory, `.${receipt.recordId}.${randomUUID()}.tmp`)
    await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
    try {
      await link(temporary, destination)
      return 'CREATED'
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      const existing = await readFile(destination, 'utf8')
      if (existing !== serialized) throw new Error('Execution receipt conflict: this assurance record already has an immutable execution receipt.')
      return 'EXISTING'
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
