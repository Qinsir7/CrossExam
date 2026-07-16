import express from 'express'
import { paymentMiddleware, x402ResourceServer } from '@okxweb3/x402-express'
import { OKXFacilitatorClient } from '@okxweb3/x402-core'
import { ExactEvmScheme } from '@okxweb3/x402-evm/exact/server'
import { aggregateAssurance } from './assuranceService'
import { aggregateNetworkVerifiedAssurance } from './assuranceService'
import type { AggregateAssuranceRequest } from './assuranceService'
import type { X402ServerConfig } from './config'
import { FileAssuranceRecordStore, type AssuranceRecordStore } from './recordStore'
import { createServiceManifest } from './serviceManifest'
import { verifyOutcomeAttestation, type SignedClaimOutcomeAdjudication } from './outcomeAttestation'
import { deriveReviewerOutcomeEvents } from './outcomeAdjudication'
import { loadReviewerReliabilityProfile } from './reliabilityService'
import { FileAssuranceIdempotencyStore, requestFingerprint, type AssuranceIdempotencyStore } from './idempotencyStore'
import { PostgresAssuranceStore } from './postgresStore'
import { attestDecisionAssuranceRecord } from './serviceAttestation'
import { validateExecutionReceipt, verifyExecutionReceiptAttestation, type SignedExecutionReceipt } from './executionReceipt'
import { authorizeReviewJobFunding, canAccessReviewJob, cancelReviewJob, createReviewJobWithAccess, recordReviewDelivery, reviewJobForOwner } from './reviewJob'
import { FileReviewJobStore, type ReviewJobStore } from './reviewJobStore'
import type { SignedReviewDelivery } from './deliveryAttestation'
import { buildProcurementLedger } from './procurementLedger'

const assuranceRoute = 'POST /api/v1/assurance/aggregate'
const networkAssuranceRoute = 'POST /api/v1/assurance/network-aggregate'
const reviewFundingRoute = 'POST /api/v1/review-jobs/authorize'

export function createCrossExamX402App(config: X402ServerConfig, dependencies: { recordStore?: AssuranceRecordStore; idempotencyStore?: AssuranceIdempotencyStore; jobStore?: ReviewJobStore } = {}) {
  const facilitator = new OKXFacilitatorClient({
    apiKey: config.okxApiKey,
    secretKey: config.okxSecretKey,
    passphrase: config.okxPassphrase,
  })
  const resourceServer = new x402ResourceServer(facilitator)
    .register('eip155:196', new ExactEvmScheme())
  const app = express()
  // Railway terminates public TLS before forwarding to this container. Trust
  // that single proxy hop so x402 advertises the public HTTPS resource URL.
  app.set('trust proxy', 1)
  const sharedProductionStore = config.databaseUrl && !dependencies.recordStore && !dependencies.idempotencyStore && !dependencies.jobStore
    ? new PostgresAssuranceStore(config.databaseUrl)
    : undefined
  const recordStore = dependencies.recordStore ?? sharedProductionStore ?? new FileAssuranceRecordStore(config.dataDirectory)
  const idempotencyStore = dependencies.idempotencyStore ?? sharedProductionStore ?? new FileAssuranceIdempotencyStore(config.dataDirectory)
  const jobStore = dependencies.jobStore ?? sharedProductionStore ?? new FileReviewJobStore(config.dataDirectory)

  app.disable('x-powered-by')
  app.use((request, response, next) => {
    const origin = request.header('origin')?.replace(/\/$/, '')
    if (!origin) {
      next()
      return
    }
    if (!config.allowedOrigins.includes(origin)) {
      response.status(403).json({ error: 'ORIGIN_NOT_ALLOWED' })
      return
    }
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key,Payment-Signature')
    if (request.method === 'OPTIONS') {
      response.status(204).end()
      return
    }
    next()
  })
  app.use(express.json({ limit: '128kb' }))
  app.get('/health', (_request, response) => {
    response.json({ service: 'crossexam-asp', x402: 'enabled', network: 'eip155:196', recordStore: 'enabled' })
  })
  app.get('/ready', async (_request, response) => {
    try {
      await Promise.all([recordStore.checkHealth(), jobStore.checkHealth()])
      response.json({ ready: true })
    } catch {
      response.status(503).json({ ready: false, error: 'PERSISTENCE_UNAVAILABLE' })
    }
  })
  app.get('/.well-known/crossexam.json', (_request, response) => {
    response.json(createServiceManifest(config.publicUrl, config.serviceSignerAddress))
  })
  app.get('/api/v1/assurance/records/:recordId', async (request, response) => {
    const authorization = request.header('authorization')
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
    try {
      if (!await recordStore.canRead(request.params.recordId, token)) {
        response.status(404).json({ error: 'RECORD_NOT_FOUND' })
        return
      }
      const record = await recordStore.find(request.params.recordId)
      if (!record) {
        response.status(404).json({ error: 'RECORD_NOT_FOUND' })
        return
      }
      response.json(record)
    } catch {
      response.status(404).json({ error: 'RECORD_NOT_FOUND' })
    }
  })
  app.post('/api/v1/outcomes', async (request, response) => {
    const outcome = request.body as SignedClaimOutcomeAdjudication
    try {
      await verifyOutcomeAttestation({ outcome, authorityWallets: config.outcomeAuthorityWallets })
      const record = await recordStore.find(outcome.recordId)
      if (!record) {
        response.status(404).json({ error: 'RECORD_NOT_FOUND' })
        return
      }
      const events = deriveReviewerOutcomeEvents(record, outcome)
      const persistence = await recordStore.saveOutcome(outcome)
      response.status(persistence === 'CREATED' ? 201 : 200).json({
        recordId: outcome.recordId,
        claimId: outcome.claimId,
        authorityId: outcome.authority.id,
        persistence,
        reviewerOutcomeEventsAccepted: events.length,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid outcome adjudication.'
      response.status(422).json({ error: 'OUTCOME_ADJUDICATION_REJECTED', message })
    }
  })
  app.post('/api/v1/executions', async (request, response) => {
    const receipt = request.body as SignedExecutionReceipt
    try {
      await verifyExecutionReceiptAttestation(receipt, config.executorWallets)
      const record = await recordStore.find(receipt.recordId)
      if (!record) {
        response.status(404).json({ error: 'RECORD_NOT_FOUND' })
        return
      }
      validateExecutionReceipt(record, receipt)
      const persistence = await recordStore.saveExecution(receipt)
      response.status(persistence === 'CREATED' ? 201 : 200).json({ recordId: receipt.recordId, executorId: receipt.executorId, status: receipt.status, persistence })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid execution receipt.'
      response.status(422).json({ error: 'EXECUTION_RECEIPT_REJECTED', message })
    }
  })
  app.get('/api/v1/reviewers/:reviewerId/reliability', async (request, response) => {
    try {
      response.json(await loadReviewerReliabilityProfile(request.params.reviewerId, recordStore))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load reviewer reliability.'
      response.status(422).json({ error: 'RELIABILITY_PROFILE_REJECTED', message })
    }
  })
  app.post('/api/v1/review-jobs', async (request, response) => {
    try {
      const created = createReviewJobWithAccess(request.body, config.reviewerRegistry)
      await jobStore.createJob(created.job)
      response.status(201).json({ ...reviewJobForOwner(created.job), accessToken: created.accessToken })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid review job request.'
      response.status(422).json({ error: 'REVIEW_JOB_REJECTED', message })
    }
  })
  app.get('/api/v1/review-jobs/:jobId', async (request, response) => {
    try {
      const job = await jobStore.findJob(request.params.jobId)
      if (!job || !canAccessReviewJob(job, request.header('authorization')?.replace(/^Bearer /, '') ?? '')) {
        response.status(404).json({ error: 'REVIEW_JOB_NOT_FOUND' })
        return
      }
      response.json(reviewJobForOwner(job))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid review job identifier.'
      response.status(422).json({ error: 'REVIEW_JOB_REJECTED', message })
    }
  })
  app.delete('/api/v1/review-jobs/:jobId', async (request, response) => {
    try {
      const job = await jobStore.findJob(request.params.jobId)
      if (!job || !canAccessReviewJob(job, request.header('authorization')?.replace(/^Bearer /, '') ?? '')) {
        response.status(404).json({ error: 'REVIEW_JOB_NOT_FOUND' })
        return
      }
      const cancelled = cancelReviewJob(job)
      if (cancelled === job) {
        response.json(reviewJobForOwner(job))
        return
      }
      await jobStore.updateJob(cancelled, job.revision)
      response.json(reviewJobForOwner(cancelled))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Review job could not be cancelled.'
      response.status(422).json({ error: 'REVIEW_JOB_REJECTED', message })
    }
  })
  app.get('/api/v1/review-jobs/:jobId/ledger', async (request, response) => {
    try {
      const job = await jobStore.findJob(request.params.jobId)
      if (!job || !canAccessReviewJob(job, request.header('authorization')?.replace(/^Bearer /, '') ?? '')) {
        response.status(404).json({ error: 'REVIEW_JOB_NOT_FOUND' })
        return
      }
      response.json(buildProcurementLedger(job))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Review job ledger is unavailable.'
      response.status(422).json({ error: 'REVIEW_JOB_REJECTED', message })
    }
  })
  app.post('/api/v1/review-jobs/:jobId/deliveries/:scopeId', async (request, response) => {
    try {
      const job = await jobStore.findJob(request.params.jobId)
      if (!job) {
        response.status(404).json({ error: 'REVIEW_JOB_NOT_FOUND' })
        return
      }
      const updated = await recordReviewDelivery(job, request.params.scopeId, request.body as SignedReviewDelivery, config.reviewerRegistry)
      await jobStore.updateJob(updated, job.revision)
      response.status(200).json(reviewJobForOwner(updated))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Review delivery was rejected.'
      response.status(422).json({ error: 'REVIEW_DELIVERY_REJECTED', message })
    }
  })
  const paidRoutes = {
    [assuranceRoute]: {
      accepts: {
        scheme: 'exact' as const,
        network: 'eip155:196' as const,
        payTo: config.payTo,
        price: `$${config.priceUsd}`,
        maxTimeoutSeconds: 300,
      },
      description: 'CrossExam deterministic decision-assurance aggregation',
      mimeType: 'application/json',
    },
    [networkAssuranceRoute]: {
      accepts: {
        scheme: 'exact' as const,
        network: 'eip155:196' as const,
        payTo: config.payTo,
        price: `$${config.priceUsd}`,
        maxTimeoutSeconds: 300,
      },
      description: 'CrossExam registry-bound reviewer verification and decision-assurance aggregation',
      mimeType: 'application/json',
    },
    [reviewFundingRoute]: {
      accepts: {
        scheme: 'exact' as const,
        network: 'eip155:196' as const,
        payTo: config.payTo,
        price: `$${config.priceUsd}`,
        maxTimeoutSeconds: 300,
      },
      description: 'CrossExam buyer authorization for bounded external reviewer procurement',
      mimeType: 'application/json',
    },
  }

  async function serveIdempotentReplay(route: string, request: express.Request, response: express.Response) {
    const key = request.header('idempotency-key')
    if (!key) return false
    const fingerprint = requestFingerprint(route, request.body)
    const lookup = await idempotencyStore.lookup(route, key, fingerprint)
    if (lookup.status === 'MISSING') {
      response.locals.idempotency = { route, key, fingerprint }
      return false
    }
    if (lookup.status === 'CONFLICT') {
      response.status(409).json({ error: 'IDEMPOTENCY_KEY_CONFLICT', message: 'This Idempotency-Key is already bound to a different assurance request.' })
      return true
    }
    const record = await recordStore.find(lookup.recordId)
    if (!record) {
      response.status(500).json({ error: 'IDEMPOTENCY_RECORD_MISSING', message: 'The completed idempotency entry no longer has its assurance record.' })
      return true
    }
    const access = await recordStore.issueReadAccess(record.recordId, config.recordAccessTtlSeconds)
    response.setHeader('Idempotent-Replay', 'true')
    response.status(200).json({ ...record, persistence: 'EXISTING', readAccess: access })
    return true
  }

  async function persistIdempotency(response: express.Response, recordId: string) {
    const context = response.locals.idempotency as { route: string; key: string; fingerprint: string } | undefined
    if (context) await idempotencyStore.complete(context.route, context.key, context.fingerprint, recordId)
  }

  app.post('/api/v1/assurance/aggregate', async (request, response, next) => {
    try {
      if (!await serveIdempotentReplay(assuranceRoute, request, response)) next()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Idempotency-Key.'
      response.status(400).json({ error: 'IDEMPOTENCY_KEY_REJECTED', message })
    }
  })
  app.post('/api/v1/assurance/network-aggregate', async (request, response, next) => {
    try {
      if (!await serveIdempotentReplay(networkAssuranceRoute, request, response)) next()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Idempotency-Key.'
      response.status(400).json({ error: 'IDEMPOTENCY_KEY_REJECTED', message })
    }
  })

  if (config.syncFacilitatorOnStart) {
    app.use(paymentMiddleware(paidRoutes, resourceServer))
  } else {
    // Local smoke mode must never silently expose paid business logic without
    // the facilitator's supported-kind handshake.
    app.post('/api/v1/assurance/aggregate', (_request, response) => {
      response.status(503).json({ error: 'PAYMENT_RAIL_NOT_READY', message: 'x402 facilitator sync is disabled.' })
    })
    app.post('/api/v1/assurance/network-aggregate', (_request, response) => {
      response.status(503).json({ error: 'PAYMENT_RAIL_NOT_READY', message: 'x402 facilitator sync is disabled.' })
    })
    app.post('/api/v1/review-jobs/authorize', (_request, response) => {
      response.status(503).json({ error: 'PAYMENT_RAIL_NOT_READY', message: 'x402 facilitator sync is disabled.' })
    })
  }

  app.post('/api/v1/assurance/aggregate', async (request, response) => {
    let assurance
    try {
      assurance = aggregateAssurance(request.body as AggregateAssuranceRequest)
      if (!config.serviceSigningKey) throw new Error('Paid assurance issuance requires a configured service signing key.')
      assurance = await attestDecisionAssuranceRecord(assurance, config.serviceSigningKey)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid assurance request.'
      response.status(422).json({ error: 'ASSURANCE_INPUT_REJECTED', message })
      return
    }
    try {
      const persistence = await recordStore.save(assurance)
      await persistIdempotency(response, assurance.recordId)
      const access = await recordStore.issueReadAccess(assurance.recordId, config.recordAccessTtlSeconds)
      response.status(200).json({ ...assurance, persistence, readAccess: access })
    } catch {
      response.status(500).json({ error: 'RECORD_PERSISTENCE_FAILED', message: 'The assurance result was not persisted.' })
    }
  })
  app.post('/api/v1/assurance/network-aggregate', async (request, response) => {
    let assurance
    try {
      assurance = await aggregateNetworkVerifiedAssurance(
        request.body as AggregateAssuranceRequest,
        config.reviewerRegistry,
      )
      if (!config.serviceSigningKey) throw new Error('Paid assurance issuance requires a configured service signing key.')
      assurance = await attestDecisionAssuranceRecord(assurance, config.serviceSigningKey)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid network-verified assurance request.'
      response.status(422).json({ error: 'NETWORK_ASSURANCE_REJECTED', message })
      return
    }
    try {
      const persistence = await recordStore.save(assurance)
      await persistIdempotency(response, assurance.recordId)
      const access = await recordStore.issueReadAccess(assurance.recordId, config.recordAccessTtlSeconds)
      response.status(200).json({ ...assurance, persistence, readAccess: access })
    } catch {
      response.status(500).json({ error: 'RECORD_PERSISTENCE_FAILED', message: 'The assurance result was not persisted.' })
    }
  })
  app.post('/api/v1/review-jobs/authorize', async (request, response) => {
    const input = request.body as { jobId?: unknown; accessToken?: unknown }
    if (typeof input.jobId !== 'string' || typeof input.accessToken !== 'string') {
      response.status(422).json({ error: 'REVIEW_FUNDING_REJECTED', message: 'jobId and owner accessToken are required.' })
      return
    }
    try {
      const job = await jobStore.findJob(input.jobId)
      if (!job || !canAccessReviewJob(job, input.accessToken)) {
        response.status(404).json({ error: 'REVIEW_JOB_NOT_FOUND' })
        return
      }
      const authorized = authorizeReviewJobFunding(job)
      if (authorized !== job) await jobStore.updateJob(authorized, job.revision)
      response.json(reviewJobForOwner(authorized))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Review job funding could not be authorized.'
      response.status(422).json({ error: 'REVIEW_FUNDING_REJECTED', message })
    }
  })

  return app
}
