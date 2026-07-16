import { loadX402ServerConfig } from './config'
import { PostgresAssuranceStore } from './postgresStore'
import { FileReviewJobStore } from './reviewJobStore'
import { ReviewJobWorker } from './reviewJobWorker'
import { X402ReviewProvider } from './x402ReviewProvider'

const config = loadX402ServerConfig()
if (!config.procurementSigningKey || !config.procurementMaxPerScopeAtomic || !config.procurementAllowedAssets.length) {
  throw new Error('Set the procurement signing key, atomic cap, and asset allowlist before running the buyer-side worker.')
}
if (!config.publicUrl) throw new Error('Set CROSSEXAM_PUBLIC_URL before running procurement so reviewers have a signed-delivery callback URL.')

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
})

let stopping = false
const stop = (signal: string) => {
  stopping = true
  console.log(JSON.stringify({ worker: 'crossexam-procurement', event: 'shutdown_requested', signal }))
}
process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))

while (!stopping) {
  try {
    const result = await worker.runOnce()
    console.log(JSON.stringify({ worker: 'crossexam-procurement', event: 'tick', ...result }))
  } catch (error) {
    console.error(JSON.stringify({ worker: 'crossexam-procurement', event: 'tick_failed', error: error instanceof Error ? error.message : 'Unknown worker error' }))
  }
  if (!stopping) await new Promise<void>((resolve) => setTimeout(resolve, config.procurementWorkerPollMs))
}

if ('close' in store && typeof store.close === 'function') await store.close()
