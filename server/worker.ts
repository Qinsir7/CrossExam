import { loadProcurementWorkerConfig } from './config'
import { PostgresAssuranceStore } from './postgresStore'
import { FileReviewJobStore } from './reviewJobStore'
import { ReviewJobWorker } from './reviewJobWorker'
import { X402ReviewProvider } from './x402ReviewProvider'

const config = loadProcurementWorkerConfig()

const store = config.databaseUrl ? new PostgresAssuranceStore(config.databaseUrl) : new FileReviewJobStore(config.dataDirectory)
const provider = new X402ReviewProvider({
  registry: config.reviewerRegistry,
  signingKey: config.procurementSigningKey,
  maxPerScopeAtomic: config.procurementMaxPerScopeAtomic,
  allowedAssets: config.procurementAllowedAssets,
  callbackBaseUrl: config.publicUrl,
})
const worker = new ReviewJobWorker(store, provider, {
  maxAttempts: config.procurementMaxAttempts,
  retryBaseMs: config.procurementRetryBaseMs,
  dispatchTimeoutMs: config.procurementDispatchTimeoutMs,
  registry: config.reviewerRegistry,
})

let stopping = false
let lastHeartbeatAt = 0
const stop = (signal: string) => {
  stopping = true
  console.log(JSON.stringify({ worker: 'crossexam-procurement', event: 'shutdown_requested', signal }))
}
process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))

while (!stopping) {
  try {
    const result = await worker.runOnce()
    const now = Date.now()
    if (result.claimed || result.requested || result.failed || result.recovered || now - lastHeartbeatAt >= 300_000) {
      const event = result.claimed || result.requested || result.failed || result.recovered ? 'work_processed' as const : 'heartbeat' as const
      await store.recordProcurementWorkerHeartbeat({ observedAt: new Date(now).toISOString(), lastEvent: event })
      console.log(JSON.stringify({ worker: 'crossexam-procurement', event, ...result }))
      lastHeartbeatAt = now
    }
  } catch (error) {
    console.error(JSON.stringify({ worker: 'crossexam-procurement', event: 'tick_failed', error: error instanceof Error ? error.message : 'Unknown worker error' }))
  }
  if (!stopping) await new Promise<void>((resolve) => setTimeout(resolve, config.procurementWorkerPollMs))
}

if ('close' in store && typeof store.close === 'function') await store.close()
