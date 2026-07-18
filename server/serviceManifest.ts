export type CrossExamServiceManifest = {
  name: 'CrossExam'
  version: '0.1'
  description: string
  discovery: { homepage: string }
  issuer?: { recordAttestation: { scheme: 'EIP191'; signer: string } }
  payment: { protocol: 'x402'; network: 'eip155:196'; scheme: 'exact' }
  capabilities: Array<{
    id: string
    endpoint: string
    paid: boolean
    description: string
  }>
}

export function createServiceManifest(publicUrl?: string, serviceSignerAddress?: string): CrossExamServiceManifest {
  const baseUrl = publicUrl?.replace(/\/$/, '') ?? ''
  const endpoint = (path: string) => `${baseUrl}${path}`
  return {
    name: 'CrossExam',
    version: '0.1',
    description: 'Adversarial decision assurance: evidence-first review, network verification, and machine-enforceable pre-action gates.',
    discovery: { homepage: endpoint('/') || '/' },
    ...(serviceSignerAddress ? { issuer: { recordAttestation: { scheme: 'EIP191' as const, signer: serviceSignerAddress } } } : {}),
    payment: { protocol: 'x402', network: 'eip155:196', scheme: 'exact' },
    capabilities: [
      {
        id: 'decision-assurance.verify-record', endpoint: endpoint('/api/v1/assurance/verify'), paid: false,
        description: 'Verify an assurance record signature against a caller-pinned issuer, exact action binding, freshness policy, and machine execution gate.',
      },
      {
        id: 'decision-assurance.aggregate', endpoint: endpoint('/api/v1/assurance/aggregate'), paid: true,
        description: 'Fail closed on generic GET or POST decision inputs, or aggregate a fully delivered independent review into a signed Decision Assurance Record.',
      },
      {
        id: 'decision-assurance.network-aggregate', endpoint: endpoint('/api/v1/assurance/network-aggregate'), paid: true,
        description: 'Aggregate registry-bound reviewer wallet attestations into a NETWORK_VERIFIED record.',
      },
      {
        id: 'decision-assurance.transaction-preflight', endpoint: endpoint('/api/v1/preflight/transaction'), paid: true,
        description: 'Obtain provenance-qualified liquidity and token-risk evidence for an exact EVM action, then receive a signed fail-closed PERMIT, HOLD, or BLOCK decision.',
      },
      {
        id: 'decision-assurance.asp-trust-check', endpoint: endpoint('/api/v1/preflight/asp'), paid: true,
        description: 'Passively inspect an ASP endpoint with SSRF-resistant HTTPS probing and return a signed BUY, CAUTION, or AVOID recommendation without purchasing the target service.',
      },
      {
        id: 'decision-assurance.cross-examination-prepare', endpoint: endpoint('/api/v1/cross-examinations/prepare'), paid: false,
        description: 'Compile a simple or advanced consequential decision into bound claims, matched real evidence sources, limitations, and a no-charge quote before payment.',
      },
      {
        id: 'decision-assurance.cross-examination', endpoint: endpoint('/api/v1/cross-examinations'), paid: false,
        description: 'Start a fulfillable durable, multi-source Cross-Examination and receive the x402 authorization capability for evidence procurement, recovery, ledger, and signed result.',
      },
      {
        id: 'decision-assurance.record-retrieval', endpoint: endpoint('/api/v1/assurance/records/{recordId}'), paid: false,
        description: 'Retrieve a persisted Decision Assurance Record with its time-limited bearer token.',
      },
      {
        id: 'decision-assurance.public-record', endpoint: endpoint('/api/v1/public/records/{shareToken}'), paid: false,
        description: 'Retrieve the deliberately sanitized public projection of a record only through its revocable opaque share capability.',
      },
      {
        id: 'decision-assurance.outcome-ingestion', endpoint: endpoint('/api/v1/outcomes'), paid: false,
        description: 'Registered outcome authorities submit EIP-191-signed, evidence-bound ex-post claim resolutions.',
      },
      {
        id: 'decision-assurance.reviewer-reliability', endpoint: endpoint('/api/v1/reviewers/{reviewerId}/reliability'), paid: false,
        description: 'Recompute a reviewer profile from immutable, authority-signed ex-post outcomes.',
      },
      {
        id: 'decision-assurance.execution-receipt', endpoint: endpoint('/api/v1/executions'), paid: false,
        description: 'Registered executors submit a signed receipt bound to the exact reviewed action.',
      },
      {
        id: 'decision-assurance.review-jobs', endpoint: endpoint('/api/v1/review-jobs'), paid: false,
        description: 'Create and track capability-protected, durable blind-review procurement jobs before paid assurance issuance.',
      },
      {
        id: 'decision-assurance.procurement-ledger', endpoint: endpoint('/api/v1/review-jobs/{jobId}/ledger'), paid: false,
        description: 'Retrieve a capability-protected, asset-denominated ledger of settled external reviewer procurement.',
      },
      {
        id: 'decision-assurance.review-result', endpoint: endpoint('/api/v1/review-jobs/{jobId}/result'), paid: false,
        description: 'Issue and retrieve the signed provenance-qualified record after every paid review scope is complete.',
      },
      {
        id: 'decision-assurance.review-access-recovery', endpoint: endpoint('/api/v1/review-jobs/recover-access'), paid: false,
        description: 'Rotate a lost paid-review owner capability with a fresh signature from the wallet proven by its X Layer settlement.',
      },
      {
        id: 'decision-assurance.review-funding', endpoint: endpoint('/api/v1/review-jobs/authorize'), paid: true,
        description: 'Purchase a full independent-review authorization before the worker may spend the bounded external-review budget.',
      },
    ],
  }
}
