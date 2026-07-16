import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import type { DecisionAssuranceRecord } from './assuranceRecord'
import type { SignedClaimOutcomeAdjudication } from './outcomeAttestation'
import type { SignedExecutionReceipt } from './executionReceipt'
import type { AssuranceRecordStore, RecordSaveResult } from './recordStore'
import { assertIdempotencyKey, idempotencyKeyHash, type AssuranceIdempotencyStore, type IdempotencyLookup } from './idempotencyStore'
import type { ReviewJob } from './reviewJob'
import type { ReviewJobStore } from './reviewJobStore'

function assertRecordId(recordId: string) {
  if (!/^dar_[a-f0-9]{24}$/.test(recordId)) throw new Error('Invalid Decision Assurance Record identifier.')
}

function assertJobId(jobId: string) {
  if (!/^rj_[0-9a-f-]{36}$/.test(jobId)) throw new Error('Invalid review job identifier.')
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

/**
 * Shared PostgreSQL persistence for a horizontally scaled CrossExam seller.
 * Every conditional write uses a database uniqueness constraint; no process-
 * local lock is trusted for record, outcome, or paid-request idempotency.
 */
export class PostgresAssuranceStore implements AssuranceRecordStore, AssuranceIdempotencyStore, ReviewJobStore {
  private readonly pool: Pool
  private migration?: Promise<void>

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString })
  }

  private async ready() {
    this.migration ??= this.migrate()
    await this.migration
  }

  private async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS crossexam_records (
        record_id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS crossexam_record_access_grants (
        token_hash TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES crossexam_records(record_id),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS crossexam_record_access_grants_expiry_idx ON crossexam_record_access_grants (expires_at);
      CREATE TABLE IF NOT EXISTS crossexam_outcomes (
        record_id TEXT NOT NULL REFERENCES crossexam_records(record_id),
        claim_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (record_id, claim_id)
      );
      CREATE TABLE IF NOT EXISTS crossexam_idempotency (
        route TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        record_id TEXT NOT NULL REFERENCES crossexam_records(record_id),
        completed_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (route, key_hash)
      );
      CREATE TABLE IF NOT EXISTS crossexam_executions (
        record_id TEXT PRIMARY KEY REFERENCES crossexam_records(record_id),
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS crossexam_review_jobs (
        job_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS crossexam_review_jobs_active_idx ON crossexam_review_jobs (status, updated_at);
    `)
  }

  async checkHealth() {
    await this.ready()
    await this.pool.query('SELECT 1')
  }

  async save(record: DecisionAssuranceRecord): Promise<RecordSaveResult> {
    assertRecordId(record.recordId)
    await this.ready()
    const inserted = await this.pool.query(
      'INSERT INTO crossexam_records (record_id, payload) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING RETURNING record_id',
      [record.recordId, JSON.stringify(record)],
    )
    if (inserted.rowCount) return 'CREATED'
    const existing = await this.find(record.recordId)
    if (!existing || canonicalize(existing) !== canonicalize(record)) {
      throw new Error('Record ID collision: existing record content differs.')
    }
    return 'EXISTING'
  }

  async find(recordId: string): Promise<DecisionAssuranceRecord | null> {
    assertRecordId(recordId)
    await this.ready()
    const result = await this.pool.query<{ payload: DecisionAssuranceRecord }>('SELECT payload FROM crossexam_records WHERE record_id = $1', [recordId])
    return result.rows[0]?.payload ?? null
  }

  async issueReadAccess(recordId: string, ttlSeconds: number, now = new Date()) {
    assertRecordId(recordId)
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60) throw new Error('Record access TTL must be at least 60 seconds.')
    await this.ready()
    const record = await this.pool.query('SELECT 1 FROM crossexam_records WHERE record_id = $1', [recordId])
    if (!record.rowCount) throw new Error('Cannot issue access for a record that does not exist.')
    const token = `darv_${randomBytes(32).toString('base64url')}`
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString()
    await this.pool.query(
      'INSERT INTO crossexam_record_access_grants (token_hash, record_id, expires_at) VALUES ($1, $2, $3)',
      [tokenHash(token), recordId, expiresAt],
    )
    return { token, expiresAt }
  }

  async canRead(recordId: string, token: string, now = new Date()) {
    assertRecordId(recordId)
    if (!token.startsWith('darv_')) return false
    await this.ready()
    const result = await this.pool.query<{ valid: boolean }>(
      'SELECT record_id = $1 AND expires_at > $2 AS valid FROM crossexam_record_access_grants WHERE token_hash = $3',
      [recordId, now.toISOString(), tokenHash(token)],
    )
    return result.rows[0]?.valid === true
  }

  async saveOutcome(outcome: SignedClaimOutcomeAdjudication): Promise<RecordSaveResult> {
    assertRecordId(outcome.recordId)
    await this.ready()
    const inserted = await this.pool.query(
      'INSERT INTO crossexam_outcomes (record_id, claim_id, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING RETURNING record_id',
      [outcome.recordId, outcome.claimId, JSON.stringify(outcome)],
    )
    if (inserted.rowCount) return 'CREATED'
    const existing = await this.pool.query<{ payload: SignedClaimOutcomeAdjudication }>(
      'SELECT payload FROM crossexam_outcomes WHERE record_id = $1 AND claim_id = $2', [outcome.recordId, outcome.claimId],
    )
    if (!existing.rows[0] || canonicalize(existing.rows[0].payload) !== canonicalize(outcome)) {
      throw new Error('Outcome adjudication conflict: this record claim already has an immutable resolution.')
    }
    return 'EXISTING'
  }

  async listOutcomes(): Promise<SignedClaimOutcomeAdjudication[]> {
    await this.ready()
    const result = await this.pool.query<{ payload: SignedClaimOutcomeAdjudication }>('SELECT payload FROM crossexam_outcomes ORDER BY record_id, claim_id')
    return result.rows.map((row) => row.payload)
  }

  async saveExecution(receipt: SignedExecutionReceipt): Promise<RecordSaveResult> {
    assertRecordId(receipt.recordId)
    await this.ready()
    const inserted = await this.pool.query(
      'INSERT INTO crossexam_executions (record_id, payload) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING RETURNING record_id',
      [receipt.recordId, JSON.stringify(receipt)],
    )
    if (inserted.rowCount) return 'CREATED'
    const existing = await this.pool.query<{ payload: SignedExecutionReceipt }>('SELECT payload FROM crossexam_executions WHERE record_id = $1', [receipt.recordId])
    if (!existing.rows[0] || canonicalize(existing.rows[0].payload) !== canonicalize(receipt)) {
      throw new Error('Execution receipt conflict: this assurance record already has an immutable execution receipt.')
    }
    return 'EXISTING'
  }

  async createJob(job: ReviewJob): Promise<void> {
    assertJobId(job.id)
    if (job.revision !== 0) throw new Error('A new review job must begin at revision zero.')
    await this.ready()
    try {
      await this.pool.query(
        'INSERT INTO crossexam_review_jobs (job_id, revision, status, payload, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)',
        [job.id, job.revision, job.status, JSON.stringify(job), job.createdAt, job.updatedAt],
      )
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new Error('Review job revision conflict.')
      throw error
    }
  }

  async findJob(jobId: string): Promise<ReviewJob | null> {
    assertJobId(jobId)
    await this.ready()
    const result = await this.pool.query<{ payload: ReviewJob }>('SELECT payload FROM crossexam_review_jobs WHERE job_id = $1', [jobId])
    return result.rows[0]?.payload ?? null
  }

  async listActiveJobs(): Promise<ReviewJob[]> {
    await this.ready()
    const result = await this.pool.query<{ payload: ReviewJob }>(
      "SELECT payload FROM crossexam_review_jobs WHERE status NOT IN ('READY_FOR_ASSURANCE', 'FAILED', 'CANCELLED') ORDER BY updated_at ASC",
    )
    return result.rows.map((row) => row.payload)
  }

  async updateJob(job: ReviewJob, expectedRevision: number): Promise<void> {
    assertJobId(job.id)
    if (job.revision !== expectedRevision + 1) throw new Error('Review job revision must increment by exactly one.')
    await this.ready()
    const result = await this.pool.query(
      'UPDATE crossexam_review_jobs SET revision = $1, status = $2, payload = $3::jsonb, updated_at = $4 WHERE job_id = $5 AND revision = $6',
      [job.revision, job.status, JSON.stringify(job), job.updatedAt, job.id, expectedRevision],
    )
    if (result.rowCount !== 1) throw new Error('Review job revision conflict.')
  }

  async lookup(route: string, key: string, fingerprint: string): Promise<IdempotencyLookup> {
    assertIdempotencyKey(key)
    await this.ready()
    const result = await this.pool.query<{ fingerprint: string; record_id: string }>(
      'SELECT fingerprint, record_id FROM crossexam_idempotency WHERE route = $1 AND key_hash = $2', [route, idempotencyKeyHash(route, key)],
    )
    const entry = result.rows[0]
    if (!entry) return { status: 'MISSING' }
    return entry.fingerprint === fingerprint ? { status: 'MATCH', recordId: entry.record_id } : { status: 'CONFLICT' }
  }

  async complete(route: string, key: string, fingerprint: string, recordId: string, completedAt = new Date().toISOString()) {
    assertIdempotencyKey(key)
    assertRecordId(recordId)
    await this.ready()
    const keyHash = idempotencyKeyHash(route, key)
    const inserted = await this.pool.query(
      'INSERT INTO crossexam_idempotency (route, key_hash, fingerprint, record_id, completed_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING route',
      [route, keyHash, fingerprint, recordId, completedAt],
    )
    if (inserted.rowCount) return
    const existing = await this.pool.query<{ fingerprint: string; record_id: string }>(
      'SELECT fingerprint, record_id FROM crossexam_idempotency WHERE route = $1 AND key_hash = $2', [route, keyHash],
    )
    const entry = existing.rows[0]
    if (!entry || entry.fingerprint !== fingerprint || entry.record_id !== recordId) {
      throw new Error('Idempotency key conflict: it is already bound to a different completed request.')
    }
  }

  async close() {
    await this.pool.end()
  }
}
