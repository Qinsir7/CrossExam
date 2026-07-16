import type { X402ServerConfig } from './config'
import { PostgresAssuranceStore } from './postgresStore'
import { FileReviewJobStore } from './reviewJobStore'
import { ReviewJobWorker } from './reviewJobWorker'
import { X402ReviewProvider } from './x402ReviewProvider'

/**
 * Runs the recoverable procurement loop inside an API replica. PostgreSQL CAS
 * claims make this safe alongside the dedicated Railway worker and remove the
 * latter as a single deployment dependency.
 */
export function startEmbeddedProcurementRuntime(config: X402ServerConfig) {
  if (!config.procurementSigningKey || !config.procurementMaxPerScopeAtomic || !config.procurementAllowedAssets.length || !config.publicUrl) return undefined
  const store = config.databaseUrl ? new PostgresAssuranceStore(config.databaseUrl) : new FileReviewJobStore(config.dataDirectory)
  const provider = new X402ReviewProvider({
    registry: config.reviewerRegistry,
    signingKey: config.procurementSigningKey,
    maxPerScopeAtomic: config.procurementMaxPerScopeAtomic,
    allowedAssets: config.procurementAllowedAssets,
    callbackBaseUrl: config.publicUrl,
    okxMarketCredentials: { apiKey: config.okxApiKey, secretKey: config.okxSecretKey, passphrase: config.okxPassphrase },
  })
  const worker = new ReviewJobWorker(store, provider, {
    maxAttempts: config.procurementMaxAttempts,
    retryBaseMs: config.procurementRetryBaseMs,
    dispatchTimeoutMs: config.procurementDispatchTimeoutMs,
    registry: config.reviewerRegistry,
  })
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let lastHeartbeatAt = 0
  const tick = async () => {
    if (stopped) return
    try {
      const result = await worker.runOnce()
      const now = Date.now()
      if (result.claimed || result.requested || result.failed || result.recovered || now - lastHeartbeatAt >= 300_000) {
        const event = result.claimed || result.requested || result.failed || result.recovered ? 'work_processed' as const : 'heartbeat' as const
        await store.recordProcurementWorkerHeartbeat({ observedAt: new Date(now).toISOString(), lastEvent: event })
        console.log(JSON.stringify({ worker: 'crossexam-embedded-procurement', event, ...result }))
        lastHeartbeatAt = now
      }
    } catch (error) {
      console.error(JSON.stringify({ worker: 'crossexam-embedded-procurement', event: 'tick_failed', error: error instanceof Error ? error.message : 'Unknown worker error' }))
    } finally {
      if (!stopped) timer = setTimeout(() => { void tick() }, config.procurementWorkerPollMs)
    }
  }
  void tick()
  return async () => {
    stopped = true
    if (timer) clearTimeout(timer)
    if ('close' in store && typeof store.close === 'function') await store.close()
  }
}
