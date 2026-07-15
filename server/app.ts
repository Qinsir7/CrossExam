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

const assuranceRoute = 'POST /api/v1/assurance/aggregate'
const networkAssuranceRoute = 'POST /api/v1/assurance/network-aggregate'

export function createCrossExamX402App(config: X402ServerConfig, dependencies: { recordStore?: AssuranceRecordStore } = {}) {
  const facilitator = new OKXFacilitatorClient({
    apiKey: config.okxApiKey,
    secretKey: config.okxSecretKey,
    passphrase: config.okxPassphrase,
  })
  const resourceServer = new x402ResourceServer(facilitator)
    .register('eip155:196', new ExactEvmScheme())
  const app = express()
  const recordStore = dependencies.recordStore ?? new FileAssuranceRecordStore(config.dataDirectory)

  app.disable('x-powered-by')
  app.use(express.json({ limit: '128kb' }))
  app.get('/health', (_request, response) => {
    response.json({ service: 'crossexam-asp', x402: 'enabled', network: 'eip155:196', recordStore: 'enabled' })
  })
  app.get('/.well-known/crossexam.json', (_request, response) => {
    response.json(createServiceManifest(config.publicUrl))
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
  }

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
  }

  app.post('/api/v1/assurance/aggregate', async (request, response) => {
    let assurance
    try {
      assurance = aggregateAssurance(request.body as AggregateAssuranceRequest)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid assurance request.'
      response.status(422).json({ error: 'ASSURANCE_INPUT_REJECTED', message })
      return
    }
    try {
      const persistence = await recordStore.save(assurance)
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
        config.reviewerWallets,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid network-verified assurance request.'
      response.status(422).json({ error: 'NETWORK_ASSURANCE_REJECTED', message })
      return
    }
    try {
      const persistence = await recordStore.save(assurance)
      const access = await recordStore.issueReadAccess(assurance.recordId, config.recordAccessTtlSeconds)
      response.status(200).json({ ...assurance, persistence, readAccess: access })
    } catch {
      response.status(500).json({ error: 'RECORD_PERSISTENCE_FAILED', message: 'The assurance result was not persisted.' })
    }
  })

  return app
}
