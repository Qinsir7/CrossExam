import express from 'express'
import { paymentMiddleware, x402ResourceServer } from '@okxweb3/x402-express'
import { OKXFacilitatorClient } from '@okxweb3/x402-core'
import { ExactEvmScheme } from '@okxweb3/x402-evm/exact/server'
import { aggregateAssurance } from './assuranceService'
import { aggregateNetworkVerifiedAssurance, aggregateProcurementVerifiedAssurance } from './assuranceService'
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
import { canAccessReviewJob, cancelReviewJob, createReviewJobWithAccess, recordReviewDelivery, reviewJobForOwner } from './reviewJob'
import { FileReviewJobStore, type ReviewJobStore } from './reviewJobStore'
import type { SignedReviewDelivery } from './deliveryAttestation'
import { buildProcurementLedger } from './procurementLedger'
import { reconcileReviewJobFunding, XLAYER_USDT0 } from './customerPayment'

const assuranceRoute = 'POST /api/v1/assurance/aggregate'
const networkAssuranceRoute = 'POST /api/v1/assurance/network-aggregate'
const reviewFundingRoute = 'POST /api/v1/review-jobs/authorize'
const recoveredCustomerTransaction = '0xafd77208465b834e5537f607b3d2b3543a06cf76ecc8d025e376899c2045034d'
const recoveredCustomerSettlementAt = new Date('2026-07-16T14:39:39.000Z').getTime()

function procurementFailureCategory(failure?: string) {
  if (!failure) return undefined
  if (/received 500|\(500\)/i.test(failure)) return 'PROVIDER_HTTP_500'
  if (/received 4\d\d|\(4\d\d\)/i.test(failure)) return 'PROVIDER_HTTP_4XX'
  if (/payment|settlement|x layer|spend policy/i.test(failure)) return 'PAYMENT_OR_POLICY'
  if (/timeout|expired/i.test(failure)) return 'TIMEOUT'
  if (/response|json|schema|adapter/i.test(failure)) return 'INVALID_PROVIDER_RESPONSE'
  return 'PROVIDER_ERROR'
}

export function createCrossExamX402App(config: X402ServerConfig, dependencies: { recordStore?: AssuranceRecordStore; idempotencyStore?: AssuranceIdempotencyStore; jobStore?: ReviewJobStore } = {}) {
  const facilitator = new OKXFacilitatorClient({
    apiKey: config.okxApiKey,
    secretKey: config.okxSecretKey,
    passphrase: config.okxPassphrase,
    // A paid authorization is a spend gate. Do not treat an asynchronous
    // facilitator acknowledgement as permission to procure external work.
    syncSettle: true,
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

  const reviewAuthorizationAmountAtomic = BigInt(Math.round(Number(config.reviewAuthorizationPriceUsd) * 1_000_000)).toString()

  async function reconcileFunding(job: Awaited<ReturnType<ReviewJobStore['findJob']>>, transaction: string) {
    if (!job) throw new Error('Review job does not exist.')
    return reconcileReviewJobFunding({
      job,
      transaction,
      payTo: config.payTo,
      expectedAmountAtomic: reviewAuthorizationAmountAtomic,
      jobStore,
      getSettleStatus: (tx) => facilitator.getSettleStatus(tx),
    })
  }

  async function recoverConfirmedProductionPayment(job: NonNullable<Awaited<ReturnType<ReviewJobStore['findJob']>>>) {
    if (job.fundingStatus !== 'UNFUNDED') return job
    const createdAt = new Date(job.createdAt).getTime()
    // Idempotent repair for the confirmed payment made while the original
    // post-settlement database hook failed. The tight creation-time window,
    // exact receipt, facilitator confirmation, and global transaction index
    // prevent this public transaction from authorizing any other job.
    if (!Number.isFinite(createdAt) || createdAt > recoveredCustomerSettlementAt || createdAt < recoveredCustomerSettlementAt - 10 * 60_000) return job
    try {
      const recovered = await reconcileReviewJobFunding({
        job,
        transaction: recoveredCustomerTransaction,
        payTo: config.payTo,
        expectedAmountAtomic: reviewAuthorizationAmountAtomic,
        jobStore,
        // This one-off repair is bound to the exact transaction already
        // independently confirmed on X Layer. Re-verify its receipt on every
        // attempt without depending on facilitator status API availability.
        getSettleStatus: async () => ({
          success: true,
          status: 'success',
          transaction: recoveredCustomerTransaction,
          network: 'eip155:196',
        }),
      })
      console.info(`[customer-payment] recovered ${recovered.id} from confirmed transaction ${recoveredCustomerTransaction}`)
      return recovered
    } catch (error) {
      console.error(`[customer-payment] recovery pending for ${job.id}: ${error instanceof Error ? error.message : 'unknown error'}`)
      return job
    }
  }

  // Recovery must not depend on the buyer keeping the original tab open. On
  // every API deployment, repair the one unambiguous active job that could
  // have produced the already-confirmed orphan settlement.
  void jobStore.listActiveJobs().then(async (jobs) => {
    const candidates = jobs.filter((job) => {
      const createdAt = new Date(job.createdAt).getTime()
      return job.fundingStatus === 'UNFUNDED'
        && Number.isFinite(createdAt)
        && createdAt <= recoveredCustomerSettlementAt
        && createdAt >= recoveredCustomerSettlementAt - 10 * 60_000
    })
    if (candidates.length === 1) await recoverConfirmedProductionPayment(candidates[0])
    else if (candidates.length > 1) console.error(`[customer-payment] automatic recovery is ambiguous across ${candidates.length} active jobs`)
  }).catch((error) => console.error(`[customer-payment] startup recovery deferred: ${error instanceof Error ? error.message : 'unknown error'}`))

  resourceServer.onAfterSettle(async ({ requirements, result, transportContext }) => {
    const requestContext = (transportContext as { request?: { path?: unknown; method?: unknown; routePattern?: unknown; adapter?: { getBody?: () => unknown } } } | undefined)?.request
    const isReviewFunding = requestContext?.method === 'POST'
      && (requestContext.path === '/api/v1/review-jobs/authorize' || requestContext.routePattern === reviewFundingRoute)
    if (!isReviewFunding) return
    try {
      const input = requestContext.adapter?.getBody?.() as { jobId?: unknown; accessToken?: unknown } | undefined
      if (typeof input?.jobId !== 'string' || typeof input.accessToken !== 'string') throw new Error('Settled review funding request had an invalid payload.')
      if (requirements.network !== 'eip155:196' || requirements.asset.toLowerCase() !== XLAYER_USDT0
        || (result.amount ?? requirements.amount) !== reviewAuthorizationAmountAtomic
        || !/^0x[0-9a-fA-F]{64}$/.test(result.transaction)) {
        throw new Error('Settled review funding receipt is malformed.')
      }
      // Pending acknowledgements are never spend authorization. The client
      // receives the transaction in PAYMENT-RESPONSE and calls reconciliation.
      if (result.status !== 'success') return
      const job = await jobStore.findJob(input.jobId)
      if (!job || !canAccessReviewJob(job, input.accessToken)) throw new Error('Settled review funding request no longer has owner access.')
      await reconcileReviewJobFunding({
        job,
        transaction: result.transaction,
        payTo: config.payTo,
        expectedAmountAtomic: reviewAuthorizationAmountAtomic,
        jobStore,
        getSettleStatus: async () => ({ success: true, status: 'success', transaction: result.transaction, network: result.network }),
      })
      console.info(`[customer-payment] authorized ${input.jobId} from confirmed transaction ${result.transaction}`)
    } catch (error) {
      // Settlement has already happened. Never turn a successful payment into
      // an opaque 402 because a database/RPC callback had a transient failure;
      // the authenticated reconciliation endpoint is the durable retry path.
      console.error(`[customer-payment] post-settlement write deferred: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  })

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
  app.get('/health', async (_request, response) => {
    try {
      const [heartbeat, recoveredPayment] = await Promise.all([
        jobStore.getProcurementWorkerHeartbeat(),
        jobStore.findJobByCustomerPaymentTransaction(recoveredCustomerTransaction),
      ])
      const ageMs = heartbeat ? Date.now() - new Date(heartbeat.observedAt).getTime() : undefined
      const procurementWorker = !heartbeat ? 'UNSEEN' : ageMs !== undefined && ageMs <= 12 * 60_000 ? 'HEALTHY' : 'STALE'
      response.json({
        service: 'crossexam-asp',
        x402: config.syncFacilitatorOnStart ? 'enabled' : 'disabled',
        settlementRecovery: 'xlayer-receipt-v2',
        recoveredCustomerPayment: recoveredPayment ? 'RECOVERED' : 'PENDING',
        ...(recoveredPayment ? {
          recoveredCustomerJob: {
            status: recoveredPayment.status,
            fundingStatus: recoveredPayment.fundingStatus,
            procurements: recoveredPayment.procurements.map((procurement) => ({
              scopeId: procurement.scopeId,
              status: procurement.status,
              attempts: procurement.attempts,
              ...(procurementFailureCategory(procurement.failure) ? { failureCategory: procurementFailureCategory(procurement.failure) } : {}),
            })),
          },
        } : {}),
        network: 'eip155:196',
        recordStore: 'enabled',
        procurementWorker,
        ...(heartbeat ? { procurementWorkerObservedAt: heartbeat.observedAt, procurementWorkerLastEvent: heartbeat.lastEvent } : {}),
      })
    } catch {
      response.status(503).json({ service: 'crossexam-asp', x402: config.syncFacilitatorOnStart ? 'enabled' : 'disabled', recordStore: 'unavailable' })
    }
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
      const created = createReviewJobWithAccess(request.body, config.reviewerRegistry, undefined, {
        authorizationPriceUsd: config.reviewAuthorizationPriceUsd,
        minimumGrossMarginFraction: config.reviewMinimumGrossMarginFraction,
      })
      await jobStore.createJob(created.job)
      response.status(201).json({ ...reviewJobForOwner(created.job), accessToken: created.accessToken })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid review job request.'
      response.status(422).json({ error: 'REVIEW_JOB_REJECTED', message })
    }
  })
  app.get('/api/v1/review-jobs/:jobId', async (request, response) => {
    try {
      let job = await jobStore.findJob(request.params.jobId)
      if (!job || !canAccessReviewJob(job, request.header('authorization')?.replace(/^Bearer /, '') ?? '')) {
        response.status(404).json({ error: 'REVIEW_JOB_NOT_FOUND' })
        return
      }
      job = await recoverConfirmedProductionPayment(job)
      response.json(reviewJobForOwner(job))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid review job identifier.'
      response.status(422).json({ error: 'REVIEW_JOB_REJECTED', message })
    }
  })
  app.post('/api/v1/review-jobs/:jobId/reconcile-funding', async (request, response) => {
    try {
      const job = await jobStore.findJob(request.params.jobId)
      if (!job || !canAccessReviewJob(job, request.header('authorization')?.replace(/^Bearer /, '') ?? '')) {
        response.status(404).json({ error: 'REVIEW_JOB_NOT_FOUND' })
        return
      }
      const transaction = (request.body as { transaction?: unknown })?.transaction
      if (typeof transaction !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(transaction)) {
        response.status(422).json({ error: 'SETTLEMENT_PROOF_REJECTED', message: 'A valid customer settlement transaction is required.' })
        return
      }
      response.json(reviewJobForOwner(await reconcileFunding(job, transaction)))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Customer settlement could not be reconciled.'
      response.status(422).json({ error: 'SETTLEMENT_PROOF_REJECTED', message })
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
  app.get('/api/v1/review-jobs/:jobId/result', async (request, response) => {
    try {
      const job = await jobStore.findJob(request.params.jobId)
      if (!job || !canAccessReviewJob(job, request.header('authorization')?.replace(/^Bearer /, '') ?? '')) {
        response.status(404).json({ error: 'REVIEW_JOB_NOT_FOUND' })
        return
      }
      if (job.status !== 'READY_FOR_ASSURANCE' || job.fundingStatus !== 'AUTHORIZED') {
        response.status(409).json({ error: 'REVIEW_JOB_NOT_READY', message: 'The review job has not completed every paid, signed evidence scope.' })
        return
      }
      if (!config.serviceSigningKey) throw new Error('Review-job result issuance requires a configured service signing key.')
      const hasPaidEvidence = job.dispatch.assignments.some((assignment) => assignment.reviewer && config.reviewerRegistry[assignment.reviewer.id]?.procurementProtocol === 'PAID_EVIDENCE_V1')
      let assurance = hasPaidEvidence
        ? await aggregateProcurementVerifiedAssurance({ decision: job.decision, dispatch: job.dispatch }, config.reviewerRegistry, job.updatedAt)
        : await aggregateNetworkVerifiedAssurance({ decision: job.decision, dispatch: job.dispatch }, config.reviewerRegistry, job.updatedAt)
      assurance = await attestDecisionAssuranceRecord(assurance, config.serviceSigningKey)
      const persistence = await recordStore.save(assurance)
      const access = await recordStore.issueReadAccess(assurance.recordId, config.recordAccessTtlSeconds)
      response.status(200).json({ ...assurance, persistence, readAccess: access })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Review job result is unavailable.'
      response.status(422).json({ error: 'REVIEW_JOB_RESULT_REJECTED', message })
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
        price: `$${config.reviewAuthorizationPriceUsd}`,
        maxTimeoutSeconds: 300,
      },
      description: 'CrossExam full-review authorization for bounded independent external reviewer procurement',
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
      if (job.fundingStatus === 'AUTHORIZED') {
        response.status(409).json({ error: 'REVIEW_JOB_ALREADY_AUTHORIZED', message: 'This job already has a settled customer authorization; a second payment is not accepted.' })
        return
      }
      // The x402 middleware settles only after this handler returns. Its
      // onAfterSettle hook records the authorization before the worker can
      // spend; callers should poll the job once they receive PAYMENT-RESPONSE.
      response.status(202).json({ ...reviewJobForOwner(job), fundingStatus: 'UNFUNDED', settlementPending: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Review job funding could not be authorized.'
      response.status(422).json({ error: 'REVIEW_FUNDING_REJECTED', message })
    }
  })

  return app
}
