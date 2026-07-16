import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReviewJob } from './reviewJob'

export type ProcurementWorkerHeartbeat = {
  observedAt: string
  lastEvent: 'heartbeat' | 'work_processed'
}

function assertJobId(jobId: string) {
  if (!/^rj_[0-9a-f-]{36}$/.test(jobId)) throw new Error('Invalid review job identifier.')
}

export interface ReviewJobStore {
  checkHealth(): Promise<void>
  createJob(job: ReviewJob): Promise<void>
  findJob(jobId: string): Promise<ReviewJob | null>
  listActiveJobs(): Promise<ReviewJob[]>
  updateJob(job: ReviewJob, expectedRevision: number): Promise<void>
  recordProcurementWorkerHeartbeat(heartbeat: ProcurementWorkerHeartbeat): Promise<void>
  getProcurementWorkerHeartbeat(): Promise<ProcurementWorkerHeartbeat | null>
}

/**
 * Immutable revision snapshots make file-backed local jobs recoverable and
 * protect against lost writes inside a single-instance deployment. PostgreSQL
 * provides the same compare-and-swap rule across replicas.
 */
export class FileReviewJobStore implements ReviewJobStore {
  private readonly jobsDirectory: string

  constructor(dataDirectory: string) {
    this.jobsDirectory = join(dataDirectory, 'review-jobs')
  }

  async checkHealth() {
    await mkdir(this.jobsDirectory, { recursive: true })
  }

  private revisionPath(jobId: string, revision: number) {
    return join(this.jobsDirectory, jobId, `${revision}.json`)
  }

  async createJob(job: ReviewJob): Promise<void> {
    assertJobId(job.id)
    if (job.revision !== 0) throw new Error('A new review job must begin at revision zero.')
    await mkdir(join(this.jobsDirectory, job.id), { recursive: true })
    await this.writeRevision(job, 0, true)
  }

  private async writeRevision(job: ReviewJob, revision: number, failIfExists: boolean) {
    const destination = this.revisionPath(job.id, revision)
    const temporary = join(this.jobsDirectory, job.id, `.${randomUUID()}.tmp`)
    const serialized = `${JSON.stringify(job, null, 2)}\n`
    await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
    try {
      await link(temporary, destination)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST' && failIfExists) throw new Error('Review job revision conflict.')
      throw error
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async findJob(jobId: string): Promise<ReviewJob | null> {
    assertJobId(jobId)
    try {
      const revisions = (await readdir(join(this.jobsDirectory, jobId)))
        .map((entry) => /^([0-9]+)\.json$/.exec(entry)?.[1])
        .filter((revision): revision is string => Boolean(revision))
        .map(Number)
      if (!revisions.length) return null
      const revision = Math.max(...revisions)
      return JSON.parse(await readFile(this.revisionPath(jobId, revision), 'utf8')) as ReviewJob
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }

  async listActiveJobs(): Promise<ReviewJob[]> {
    try {
      const ids = (await readdir(this.jobsDirectory)).filter((entry) => /^rj_[0-9a-f-]{36}$/.test(entry))
      const jobs = await Promise.all(ids.map((id) => this.findJob(id)))
      return jobs.filter((job): job is ReviewJob => Boolean(job && job.status !== 'READY_FOR_ASSURANCE' && job.status !== 'FAILED' && job.status !== 'CANCELLED'))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
  }

  async updateJob(job: ReviewJob, expectedRevision: number): Promise<void> {
    assertJobId(job.id)
    if (job.revision !== expectedRevision + 1) throw new Error('Review job revision must increment by exactly one.')
    if (!await this.findJob(job.id)) throw new Error('Review job does not exist.')
    const current = await this.findJob(job.id)
    if (!current || current.revision !== expectedRevision) throw new Error('Review job revision conflict.')
    await this.writeRevision(job, job.revision, true)
  }

  private heartbeatPath() {
    return join(this.jobsDirectory, 'procurement-worker.json')
  }

  async recordProcurementWorkerHeartbeat(heartbeat: ProcurementWorkerHeartbeat): Promise<void> {
    if (!Number.isFinite(new Date(heartbeat.observedAt).getTime())) throw new Error('Procurement worker heartbeat timestamp is invalid.')
    await this.checkHealth()
    const temporary = join(this.jobsDirectory, `.${randomUUID()}.heartbeat.tmp`)
    await writeFile(temporary, `${JSON.stringify(heartbeat)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, this.heartbeatPath())
  }

  async getProcurementWorkerHeartbeat(): Promise<ProcurementWorkerHeartbeat | null> {
    try {
      const heartbeat = JSON.parse(await readFile(this.heartbeatPath(), 'utf8')) as ProcurementWorkerHeartbeat
      if (!Number.isFinite(new Date(heartbeat.observedAt).getTime()) || (heartbeat.lastEvent !== 'heartbeat' && heartbeat.lastEvent !== 'work_processed')) return null
      return heartbeat
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }
}
