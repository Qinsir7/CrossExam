import express from 'express'
import { recoverMessageAddress } from 'viem'
import { paymentMiddleware, x402ResourceServer } from '@okxweb3/x402-express'
import { OKXFacilitatorClient } from '@okxweb3/x402-core'
import { ExactEvmScheme } from '@okxweb3/x402-evm/exact/server'
import { aggregateAssurance } from './assuranceService'
import { aggregateNetworkVerifiedAssurance, aggregateProcurementVerifiedAssurance } from './assuranceService'
import type { AggregateAssuranceRequest } from './assuranceService'
import { isAggregateAssuranceRequest, issueAssuranceIntake } from './assuranceIntake'
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
import { canAccessReviewJob, cancelReviewJob, createReviewJobWithAccess, recordReviewDelivery, recoverReviewJobAccess, retryFailedReviewJob, reviewJobForOwner } from './reviewJob'
import { FileReviewJobStore, type ReviewJobStore } from './reviewJobStore'
import type { SignedReviewDelivery } from './deliveryAttestation'
import { buildProcurementLedger } from './procurementLedger'
import { reconcileReviewJobFunding, verifyUsdt0Transfer, XLAYER_USDT0 } from './customerPayment'
import { fixedWindowRateLimit } from './rateLimit'
import { reviewAccessRecoveryMessage } from '../src/domain/reviewAccess'
import { prepareTransactionPreflight, validateTransactionPreflightInput } from './transactionPreflight'
import { X402ReviewProvider } from './x402ReviewProvider'
import type { ExternalReviewProvider } from './reviewJobWorker'
import { prepareAspTrustCheck } from './aspEndpointProbe'
import { prepareCrossExamination, startCrossExamination } from './crossExamination'
import type { CrossExaminationPreparationRequest } from '../src/domain/assuranceContracts'
import { publicRecordProjection } from './publicRecord'
import { verifyAssuranceRecord } from './assuranceVerification'
import { requestOkxDexQuote, type OkxDexQuoteRequest } from './okxDexQuote'
import { extractDocument } from './documentIntake'
import { prepareReviewPreflight, type ReviewPreflightInput } from '../src/domain/generalReview'
import { DeepSeekAdversarialProvider } from './deepSeekAdversarialProvider'
import { preparePaidAdversarialReview, type AdversarialReviewProvider } from './adversarialReview'

const assuranceRoute = 'POST /api/v1/assurance/aggregate'
const assuranceGetRoute = 'GET /api/v1/assurance/aggregate'
const networkAssuranceRoute = 'POST /api/v1/assurance/network-aggregate'
const reviewFundingRoute = 'POST /api/v1/review-jobs/authorize'
const transactionPreflightRoute = 'POST /api/v1/preflight/transaction'
const aspTrustRoute = 'POST /api/v1/preflight/asp'
const paidReviewRoute = 'POST /api/v1/reviews'

export function createCrossExamX402App(config: X402ServerConfig, dependencies: { recordStore?: AssuranceRecordStore; idempotencyStore?: AssuranceIdempotencyStore; jobStore?: ReviewJobStore; preflightProvider?: ExternalReviewProvider; adversarialProvider?: AdversarialReviewProvider; dexQuoteFetcher?: typeof fetch } = {}) {
  // A2MCP calls must return promptly after replay. This client deliberately
  // uses the official SDK's asynchronous settlement default.
  const assuranceFacilitator = new OKXFacilitatorClient({
    apiKey: config.okxApiKey,
    secretKey: config.okxSecretKey,
    passphrase: config.okxPassphrase,
  })
  // Full review authorization is a spend gate, so it keeps synchronous chain
  // confirmation on a separate payment rail.
  const fundingFacilitator = new OKXFacilitatorClient({
    apiKey: config.okxApiKey,
    secretKey: config.okxSecretKey,
    passphrase: config.okxPassphrase,
    syncSettle: true,
  })
  const assuranceResourceServer = new x402ResourceServer(assuranceFacilitator)
    .register('eip155:196', new ExactEvmScheme())
  const fundingResourceServer = new x402ResourceServer(fundingFacilitator)
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
  const preflightProvider = dependencies.preflightProvider ?? new X402ReviewProvider({
    registry: config.reviewerRegistry,
    ...(config.procurementSigningKey ? {
      signingKey: config.procurementSigningKey,
      maxPerScopeAtomic: config.procurementMaxPerScopeAtomic,
      allowedAssets: config.procurementAllowedAssets,
    } : {}),
    callbackBaseUrl: config.publicUrl ?? 'https://preflight.invalid',
    okxMarketCredentials: { apiKey: config.okxApiKey, secretKey: config.okxSecretKey, passphrase: config.okxPassphrase },
  })
  const adversarialProvider = dependencies.adversarialProvider ?? (config.deepSeek ? new DeepSeekAdversarialProvider(config.deepSeek) : undefined)

  const reviewAuthorizationAmountAtomic = (job: NonNullable<Awaited<ReturnType<ReviewJobStore['findJob']>>>) => BigInt(Math.round(job.quote.authorizationPriceUsdt * 1_000_000)).toString()

  async function reconcileFunding(job: Awaited<ReturnType<ReviewJobStore['findJob']>>, transaction: string) {
    if (!job) throw new Error('Review job does not exist.')
    return reconcileReviewJobFunding({
      job,
      transaction,
      payTo: config.payTo,
      expectedAmountAtomic: reviewAuthorizationAmountAtomic(job),
      jobStore,
      getSettleStatus: (tx) => fundingFacilitator.getSettleStatus(tx),
    })
  }

  fundingResourceServer.onAfterSettle(async ({ requirements, result, transportContext }) => {
    const requestContext = (transportContext as { request?: { path?: unknown; method?: unknown; routePattern?: unknown; adapter?: { getBody?: () => unknown } } } | undefined)?.request
    const isReviewFunding = requestContext?.method === 'POST'
      && (requestContext.path === '/api/v1/review-jobs/authorize' || requestContext.routePattern === reviewFundingRoute)
    if (!isReviewFunding) return
    try {
      const input = requestContext.adapter?.getBody?.() as { jobId?: unknown; accessToken?: unknown } | undefined
      if (typeof input?.jobId !== 'string' || typeof input.accessToken !== 'string') throw new Error('Settled review funding request had an invalid payload.')
      const job = await jobStore.findJob(input.jobId)
      if (!job || !canAccessReviewJob(job, input.accessToken)) throw new Error('Settled review funding request no longer has owner access.')
      if (requirements.network !== 'eip155:196' || requirements.asset.toLowerCase() !== XLAYER_USDT0
        || (result.amount ?? requirements.amount) !== reviewAuthorizationAmountAtomic(job)
        || !/^0x[0-9a-fA-F]{64}$/.test(result.transaction)) {
        throw new Error('Settled review funding receipt does not match the immutable job quote.')
      }
      // Pending acknowledgements are never spend authorization. The client
      // receives the transaction in PAYMENT-RESPONSE and calls reconciliation.
      if (result.status !== 'success') return
      await reconcileReviewJobFunding({
        job,
        transaction: result.transaction,
        payTo: config.payTo,
        expectedAmountAtomic: reviewAuthorizationAmountAtomic(job),
        jobStore,
        getSettleStatus: async () => ({ success: true, status: 'success', transaction: result.transaction, network: result.network, ...(result.payer ? { payer: result.payer } : {}) }),
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
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (request.path.startsWith('/api/') || request.path === '/health' || request.path === '/ready') response.setHeader('Cache-Control', 'no-store')
    next()
  })
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
  // File intake is mounted before the JSON parser. The body exists only in
  // memory for extraction and is never written to the record/job stores.
  app.post('/api/v1/intake/files', fixedWindowRateLimit({ limit: 12, windowMs: 60_000 }), express.raw({ type: () => true, limit: '8mb' }), async (request, response) => {
    try {
      const filename = typeof request.query.name === 'string' ? request.query.name : ''
      const extracted = await extractDocument({
        filename,
        contentType: request.header('content-type') ?? '',
        body: request.body as Buffer,
      })
      response.status(200).json(extracted)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The document could not be read.'
      response.status(422).json({ error: 'DOCUMENT_EXTRACTION_REJECTED', message })
    }
  })
  app.use(express.json({ limit: '512kb' }))
  app.get('/health', async (_request, response) => {
    try {
      const heartbeat = await jobStore.getProcurementWorkerHeartbeat()
      const ageMs = heartbeat ? Date.now() - new Date(heartbeat.observedAt).getTime() : undefined
      const procurementWorker = !heartbeat ? 'UNSEEN' : ageMs !== undefined && ageMs <= 12 * 60_000 ? 'HEALTHY' : 'STALE'
      const evidenceSources = Object.values(config.reviewerRegistry)
        .filter((source) => source.status === 'ACTIVE' && source.procurementProtocol)
        .map((source) => ({ id: source.id, protocol: source.procurementProtocol, adapter: source.responseAdapter }))
      response.json({
        service: 'crossexam-asp',
        x402: config.syncFacilitatorOnStart ? 'enabled' : 'disabled',
        settlementRecovery: 'xlayer-receipt-v2',
        procurementOrchestrator: 'okx-market-goplus-v2',
        embeddedProcurement: !config.publicUrl ? 'DISABLED' : config.procurementSigningKey && config.procurementMaxPerScopeAtomic && config.procurementAllowedAssets.length ? 'ENABLED_WITH_PAYMENT' : 'ENABLED_READ_ONLY',
        evidenceSources,
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
  app.post('/api/v1/assurance/verify', async (request, response) => {
    try {
      response.json(await verifyAssuranceRecord(request.body))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Assurance record verification input is invalid.'
      response.status(422).json({ error: 'ASSURANCE_VERIFICATION_REJECTED', message })
    }
  })
  // This is a free, read-only transaction-construction aid. It never asks the
  // wallet to sign, approve, or broadcast: the returned transaction is input
  // to a subsequent paid CrossExam review, not an execution instruction.
  app.post('/api/v1/transactions/quote', fixedWindowRateLimit({ limit: 15, windowMs: 60_000 }), async (request, response) => {
    try {
      response.json(await requestOkxDexQuote(
        request.body as OkxDexQuoteRequest,
        { apiKey: config.okxApiKey, secretKey: config.okxSecretKey, passphrase: config.okxPassphrase },
        dependencies.dexQuoteFetcher,
      ))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'An exact X Layer swap route could not be prepared.'
      response.status(422).json({ error: 'DEX_QUOTE_REJECTED', message })
    }
  })
  app.post('/api/v1/reviews/preflight', fixedWindowRateLimit({ limit: 30, windowMs: 60_000 }), (request, response) => {
    try {
      response.status(200).json({
        ...prepareReviewPreflight(request.body as ReviewPreflightInput),
        paidReview: {
          available: Boolean(adversarialProvider),
          priceUsd: config.deepReviewPriceUsd,
          ...(adversarialProvider ? { provider: 'DEEPSEEK' as const } : {}),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The material could not be preflighted.'
      response.status(422).json({ error: 'REVIEW_PREFLIGHT_REJECTED', message })
    }
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
  app.post('/api/v1/assurance/records/:recordId/share', async (request, response) => {
    const token = request.header('authorization')?.replace(/^Bearer /, '') ?? ''
    try {
      if (!await recordStore.canRead(request.params.recordId, token)) {
        response.status(404).json({ error: 'RECORD_NOT_FOUND' })
        return
      }
      const share = await recordStore.createPublicShare(request.params.recordId)
      response.status(201).json({ token: share.token, url: `${config.publicUrl?.replace(/\/$/, '') ?? ''}/share/${share.token}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Public share link could not be created.'
      response.status(422).json({ error: 'PUBLIC_SHARE_REJECTED', message })
    }
  })
  app.delete('/api/v1/assurance/records/:recordId/share/:shareToken', async (request, response) => {
    const token = request.header('authorization')?.replace(/^Bearer /, '') ?? ''
    try {
      if (!await recordStore.canRead(request.params.recordId, token) || await recordStore.findPublicShare(request.params.shareToken) !== request.params.recordId) {
        response.status(404).json({ error: 'PUBLIC_SHARE_NOT_FOUND' })
        return
      }
      await recordStore.revokePublicShare(request.params.shareToken)
      response.status(204).end()
    } catch {
      response.status(404).json({ error: 'PUBLIC_SHARE_NOT_FOUND' })
    }
  })
  app.get('/api/v1/public/records/:shareToken', async (request, response) => {
    try {
      const recordId = await recordStore.findPublicShare(request.params.shareToken)
      const record = recordId ? await recordStore.find(recordId) : null
      if (!record) {
        response.status(404).json({ error: 'PUBLIC_RECORD_NOT_FOUND' })
        return
      }
      response.json(publicRecordProjection(record))
    } catch {
      response.status(404).json({ error: 'PUBLIC_RECORD_NOT_FOUND' })
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
  app.post('/api/v1/cross-examinations/prepare', fixedWindowRateLimit({ limit: 30, windowMs: 60_000 }), async (request, response) => {
    try {
      const prepared = await prepareCrossExamination(request.body as CrossExaminationPreparationRequest, config.reviewerRegistry, {
        authorizationPriceUsd: config.deepReviewPriceUsd,
        minimumGrossMarginFraction: config.reviewMinimumGrossMarginFraction,
      })
      response.status(200).json(prepared)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cross-Examination input could not be prepared.'
      response.status(422).json({ error: 'CROSS_EXAMINATION_PREPARATION_REJECTED', message })
    }
  })
  app.post('/api/v1/cross-examinations', fixedWindowRateLimit({ limit: 20, windowMs: 60_000 }), async (request, response) => {
    try {
      const started = await startCrossExamination(request.body as CrossExaminationPreparationRequest, config.reviewerRegistry, {
        authorizationPriceUsd: config.deepReviewPriceUsd,
        minimumGrossMarginFraction: config.reviewMinimumGrossMarginFraction,
      })
      await jobStore.createJob(started.job)
      const { job: _job, ...body } = started
      response.status(201).json(body)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cross-Examination could not start.'
      response.status(422).json({ error: 'CROSS_EXAMINATION_REJECTED', message })
    }
  })
  app.post('/api/v1/review-jobs', fixedWindowRateLimit({ limit: 20, windowMs: 60_000 }), async (request, response) => {
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
  app.post('/api/v1/review-jobs/recover-access', fixedWindowRateLimit({ limit: 10, windowMs: 60_000 }), async (request, response) => {
    try {
      const input = request.body as { transaction?: unknown; issuedAt?: unknown; signature?: unknown }
      if (typeof input.transaction !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(input.transaction)
        || typeof input.issuedAt !== 'string' || typeof input.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) {
        throw new Error('A transaction, ISO timestamp, and EIP-191 wallet signature are required.')
      }
      const issuedAt = new Date(input.issuedAt).getTime()
      const ageMs = Date.now() - issuedAt
      if (!Number.isFinite(issuedAt) || ageMs < -60_000 || ageMs > 5 * 60_000) throw new Error('The access-recovery signature has expired.')
      const job = await jobStore.findJobByCustomerPaymentTransaction(input.transaction)
      if (!job?.customerPayment) {
        response.status(404).json({ error: 'REVIEW_JOB_NOT_FOUND' })
        return
      }
      const payer = await verifyUsdt0Transfer({
        transaction: job.customerPayment.transaction,
        payTo: config.payTo,
        amountAtomic: job.customerPayment.amountAtomic,
      })
      const signer = await recoverMessageAddress({
        message: reviewAccessRecoveryMessage({ transaction: input.transaction, issuedAt: input.issuedAt }),
        signature: input.signature as `0x${string}`,
      })
      if (signer.toLowerCase() !== payer) throw new Error('Recovery signature does not belong to the wallet that funded this review.')
      const recovered = recoverReviewJobAccess(job, payer)
      await jobStore.updateJob(recovered.job, job.revision)
      response.json({ ...reviewJobForOwner(recovered.job), accessToken: recovered.accessToken })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Paid review access could not be recovered.'
      response.status(422).json({ error: 'REVIEW_ACCESS_RECOVERY_REJECTED', message })
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
  app.post('/api/v1/review-jobs/:jobId/retry', async (request, response) => {
    try {
      const job = await jobStore.findJob(request.params.jobId)
      if (!job || !canAccessReviewJob(job, request.header('authorization')?.replace(/^Bearer /, '') ?? '')) {
        response.status(404).json({ error: 'REVIEW_JOB_NOT_FOUND' })
        return
      }
      const retried = retryFailedReviewJob(job, config.reviewerRegistry)
      await jobStore.updateJob(retried, job.revision)
      response.json(reviewJobForOwner(retried))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Review procurement could not be retried.'
      response.status(422).json({ error: 'REVIEW_JOB_RETRY_REJECTED', message })
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
      const hasExternalEvidence = job.dispatch.assignments.some((assignment) => {
        const protocol = assignment.reviewer ? config.reviewerRegistry[assignment.reviewer.id]?.procurementProtocol : undefined
        return protocol === 'PAID_EVIDENCE_V1' || protocol === 'AUTHENTICATED_API_EVIDENCE_V1' || protocol === 'PUBLIC_API_EVIDENCE_V1'
      })
      let assurance = hasExternalEvidence
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
  const assurancePaidRoutes = {
    [assuranceGetRoute]: {
      accepts: {
        scheme: 'exact' as const,
        network: 'eip155:196' as const,
        payTo: config.payTo,
        price: `$${config.priceUsd}`,
        maxTimeoutSeconds: 300,
      },
      description: 'CrossExam fail-closed decision-assurance intake gate',
      mimeType: 'application/json',
    },
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
    [transactionPreflightRoute]: {
      accepts: {
        scheme: 'exact' as const,
        network: 'eip155:196' as const,
        payTo: config.payTo,
        price: `$${config.transactionPreflightPriceUsd}`,
        maxTimeoutSeconds: 300,
      },
      description: 'CrossExam evidence-backed, action-bound transaction preflight',
      mimeType: 'application/json',
    },
    [aspTrustRoute]: {
      accepts: {
        scheme: 'exact' as const,
        network: 'eip155:196' as const,
        payTo: config.payTo,
        price: `$${config.aspTrustPriceUsd}`,
        maxTimeoutSeconds: 300,
      },
      description: 'CrossExam SSRF-resistant passive ASP endpoint and payment-contract trust check',
      mimeType: 'application/json',
    },
    [paidReviewRoute]: {
      accepts: {
        scheme: 'exact' as const,
        network: 'eip155:196' as const,
        payTo: config.payTo,
        price: `$${config.deepReviewPriceUsd}`,
        maxTimeoutSeconds: 300,
      },
      description: 'CrossExam full adversarial review with a signed model-analysis record',
      mimeType: 'application/json',
    },
  }
  const fundingPaidRoutes = {
    [reviewFundingRoute]: {
      accepts: {
        scheme: 'exact' as const,
        network: 'eip155:196' as const,
        payTo: config.payTo,
        price: async (context: { adapter: { getBody?: () => unknown } }) => {
          const input = context.adapter.getBody?.() as { jobId?: unknown; accessToken?: unknown } | undefined
          if (typeof input?.jobId !== 'string' || typeof input.accessToken !== 'string') throw new Error('A valid review job capability is required before quoting payment.')
          const job = await jobStore.findJob(input.jobId)
          if (!job || !canAccessReviewJob(job, input.accessToken) || job.fundingStatus !== 'UNFUNDED'
            || (job.status !== 'AWAITING_MATCH' && job.status !== 'AWAITING_DELIVERIES')) {
            throw new Error('This review job cannot accept a payment authorization.')
          }
          return `$${job.quote.authorizationPriceUsdt.toFixed(2)}`
        },
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

  async function servePaidReviewReplay(request: express.Request, response: express.Response) {
    const key = request.header('idempotency-key')
    if (!key) return false
    const fingerprint = requestFingerprint(paidReviewRoute, request.body)
    const lookup = await idempotencyStore.lookup(paidReviewRoute, key, fingerprint)
    if (lookup.status === 'MISSING') {
      response.locals.idempotency = { route: paidReviewRoute, key, fingerprint }
      return false
    }
    if (lookup.status === 'CONFLICT') {
      response.status(409).json({ error: 'IDEMPOTENCY_KEY_CONFLICT', message: 'This Idempotency-Key is already bound to a different review request.' })
      return true
    }
    const record = await recordStore.find(lookup.recordId)
    if (!record?.reviewPreflight || !record.adversarialAnalysis || !record.serviceAttestation) {
      response.status(500).json({ error: 'IDEMPOTENCY_RECORD_MISSING', message: 'The completed review no longer has its signed analysis record.' })
      return true
    }
    const readAccess = await recordStore.issueReadAccess(record.recordId, config.recordAccessTtlSeconds)
    response.setHeader('Idempotent-Replay', 'true')
    response.status(200).json({
      preflight: record.reviewPreflight,
      analysis: record.adversarialAnalysis,
      record: { recordId: record.recordId, issuedAt: record.issuedAt, attributionStatus: record.attributionStatus, serviceAttestation: record.serviceAttestation, readAccess },
      persistence: 'EXISTING',
    })
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
  app.post('/api/v1/preflight/transaction', async (request, response, next) => {
    if (!request.header('idempotency-key')) {
      response.status(422).json({ error: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Transaction Preflight requires an Idempotency-Key so a paid action cannot be accidentally repeated.' })
      return
    }
    try {
      // Reject unsupported work before x402. The current production sources
      // cover an exact X Layer token trade only; accepting payment for another
      // action type would turn a known product limitation into a paid failure.
      await validateTransactionPreflightInput(request.body)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transaction Preflight input is unsupported.'
      response.status(422).json({ error: 'TRANSACTION_PREFLIGHT_UNSUPPORTED', message })
      return
    }
    try {
      if (!await serveIdempotentReplay(transactionPreflightRoute, request, response)) next()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Idempotency-Key.'
      response.status(400).json({ error: 'IDEMPOTENCY_KEY_REJECTED', message })
    }
  })
  app.post('/api/v1/preflight/asp', async (request, response, next) => {
    try {
      if (!request.header('idempotency-key')) {
        response.status(422).json({ error: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Agent Trust Check requires an Idempotency-Key so a paid probe cannot be accidentally repeated.' })
        return
      }
      if (!await serveIdempotentReplay(aspTrustRoute, request, response)) next()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Idempotency-Key.'
      response.status(400).json({ error: 'IDEMPOTENCY_KEY_REJECTED', message })
    }
  })
  app.post('/api/v1/reviews', async (request, response, next) => {
    if (!adversarialProvider) {
      response.status(503).json({ error: 'ADVERSARIAL_REVIEW_UNAVAILABLE', message: 'The paid adversarial-review provider is not configured.' })
      return
    }
    if (!request.header('idempotency-key')) {
      response.status(422).json({ error: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Paid review requires an Idempotency-Key so payment and analysis cannot be accidentally repeated.' })
      return
    }
    try {
      const input = request.body as ReviewPreflightInput
      const preflight = prepareReviewPreflight(input)
      if (preflight.characterCount > 120_000) throw new Error('Paid adversarial review currently accepts at most 120,000 extracted characters.')
      if (!await servePaidReviewReplay(request, response)) next()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Paid adversarial review input is invalid.'
      response.status(422).json({ error: 'ADVERSARIAL_REVIEW_REJECTED', message })
    }
  })

  if (config.syncFacilitatorOnStart) {
    app.use(paymentMiddleware(assurancePaidRoutes, assuranceResourceServer))
    app.use(paymentMiddleware(fundingPaidRoutes, fundingResourceServer))
  } else {
    // Local smoke mode must never silently expose paid business logic without
    // the facilitator's supported-kind handshake.
    app.get('/api/v1/assurance/aggregate', (_request, response) => {
      response.status(503).json({ error: 'PAYMENT_RAIL_NOT_READY', message: 'x402 facilitator sync is disabled.' })
    })
    app.post('/api/v1/assurance/aggregate', (_request, response) => {
      response.status(503).json({ error: 'PAYMENT_RAIL_NOT_READY', message: 'x402 facilitator sync is disabled.' })
    })
    app.post('/api/v1/assurance/network-aggregate', (_request, response) => {
      response.status(503).json({ error: 'PAYMENT_RAIL_NOT_READY', message: 'x402 facilitator sync is disabled.' })
    })
    app.post('/api/v1/preflight/transaction', (_request, response) => {
      response.status(503).json({ error: 'PAYMENT_RAIL_NOT_READY', message: 'x402 facilitator sync is disabled.' })
    })
    app.post('/api/v1/preflight/asp', (_request, response) => {
      response.status(503).json({ error: 'PAYMENT_RAIL_NOT_READY', message: 'x402 facilitator sync is disabled.' })
    })
    app.post('/api/v1/reviews', (_request, response) => {
      response.status(503).json({ error: 'PAYMENT_RAIL_NOT_READY', message: 'x402 facilitator sync is disabled.' })
    })
    app.post('/api/v1/review-jobs/authorize', (_request, response) => {
      response.status(503).json({ error: 'PAYMENT_RAIL_NOT_READY', message: 'x402 facilitator sync is disabled.' })
    })
  }

  app.get('/api/v1/assurance/aggregate', async (request, response) => {
    try {
      if (!config.serviceSigningKey) throw new Error('Paid assurance issuance requires a configured service signing key.')
      const assurance = await attestDecisionAssuranceRecord(issueAssuranceIntake(request.query), config.serviceSigningKey)
      const persistence = await recordStore.save(assurance)
      const access = await recordStore.issueReadAccess(assurance.recordId, config.recordAccessTtlSeconds)
      response.status(200).json({ ...assurance, persistence, readAccess: access })
    } catch {
      response.status(500).json({ error: 'ASSURANCE_INTAKE_FAILED', message: 'The fail-closed assurance result could not be issued.' })
    }
  })

  app.post('/api/v1/assurance/aggregate', async (request, response) => {
    let assurance
    try {
      assurance = isAggregateAssuranceRequest(request.body)
        ? aggregateAssurance(request.body as AggregateAssuranceRequest)
        : issueAssuranceIntake(request.body)
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
  app.post('/api/v1/preflight/transaction', async (request, response) => {
    try {
      if (!config.serviceSigningKey) throw new Error('Paid transaction preflight requires a configured service signing key.')
      const prepared = await prepareTransactionPreflight(request.body, { registry: config.reviewerRegistry, provider: preflightProvider })
      const record = await attestDecisionAssuranceRecord(prepared.record, config.serviceSigningKey)
      const persistence = await recordStore.save(record)
      await persistIdempotency(response, record.recordId)
      const readAccess = await recordStore.issueReadAccess(record.recordId, config.recordAccessTtlSeconds)
      if (!record.serviceAttestation) throw new Error('Signed transaction preflight record is missing its service attestation.')
      response.status(200).json({
        action: prepared.action,
        decision: prepared.decision,
        claims: prepared.claims,
        evidence: prepared.evidence,
        verdict: prepared.verdict,
        record: {
          recordId: record.recordId,
          issuedAt: record.issuedAt,
          attributionStatus: record.attributionStatus,
          serviceAttestation: record.serviceAttestation,
          readAccess,
        },
        economics: prepared.economics,
        persistence,
        ...(prepared.procurementFailures.length ? { procurementFailures: prepared.procurementFailures } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transaction preflight could not be issued.'
      response.status(422).json({ error: 'TRANSACTION_PREFLIGHT_REJECTED', message })
    }
  })
  app.post('/api/v1/preflight/asp', async (request, response) => {
    try {
      if (!config.serviceSigningKey) throw new Error('Paid ASP trust checks require a configured service signing key.')
      const prepared = await prepareAspTrustCheck(request.body)
      const record = await attestDecisionAssuranceRecord(prepared.record, config.serviceSigningKey)
      const persistence = await recordStore.save(record)
      await persistIdempotency(response, record.recordId)
      const readAccess = await recordStore.issueReadAccess(record.recordId, config.recordAccessTtlSeconds)
      if (!record.serviceAttestation) throw new Error('Signed ASP trust record is missing its service attestation.')
      response.status(200).json({
        action: prepared.action,
        observations: prepared.observations,
        verdict: prepared.verdict,
        recommendation: prepared.recommendation,
        record: { recordId: record.recordId, issuedAt: record.issuedAt, attributionStatus: record.attributionStatus, serviceAttestation: record.serviceAttestation, readAccess },
        persistence,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ASP trust check could not be issued.'
      response.status(422).json({ error: 'ASP_TRUST_CHECK_REJECTED', message })
    }
  })
  app.post('/api/v1/reviews', async (request, response) => {
    try {
      if (!adversarialProvider) throw new Error('The paid adversarial-review provider is not configured.')
      if (!config.serviceSigningKey) throw new Error('Paid adversarial review requires a configured service signing key.')
      const prepared = await preparePaidAdversarialReview(request.body as ReviewPreflightInput, adversarialProvider)
      const record = await attestDecisionAssuranceRecord(prepared.record, config.serviceSigningKey)
      const persistence = await recordStore.save(record)
      await persistIdempotency(response, record.recordId)
      const readAccess = await recordStore.issueReadAccess(record.recordId, config.recordAccessTtlSeconds)
      if (!record.serviceAttestation) throw new Error('Signed adversarial-review record is missing its service attestation.')
      response.status(200).json({
        preflight: prepared.preflight,
        analysis: prepared.analysis,
        record: { recordId: record.recordId, issuedAt: record.issuedAt, attributionStatus: record.attributionStatus, serviceAttestation: record.serviceAttestation, readAccess },
        persistence,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Paid adversarial review could not be issued.'
      response.status(422).json({ error: 'ADVERSARIAL_REVIEW_REJECTED', message })
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
