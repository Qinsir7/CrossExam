import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DecisionAssuranceRecord } from './assuranceRecord'

export type RecordSaveResult = 'CREATED' | 'EXISTING'

export interface AssuranceRecordStore {
  save(record: DecisionAssuranceRecord): Promise<RecordSaveResult>
  find(recordId: string): Promise<DecisionAssuranceRecord | null>
}

function assertRecordId(recordId: string) {
  if (!/^dar_[a-f0-9]{24}$/.test(recordId)) throw new Error('Invalid Decision Assurance Record identifier.')
}

/**
 * Local durable store for development and single-instance deployment. Records
 * are content addressed and written with an atomic link operation, so a later
 * write cannot silently replace a record with the same ID. The interface is a
 * production seam for a managed database/object-store implementation.
 */
export class FileAssuranceRecordStore implements AssuranceRecordStore {
  private readonly recordsDirectory: string

  constructor(dataDirectory: string) {
    this.recordsDirectory = join(dataDirectory, 'records')
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
}
