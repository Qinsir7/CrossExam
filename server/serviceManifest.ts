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
        id: 'decision-assurance.aggregate', endpoint: endpoint('/api/v1/assurance/aggregate'), paid: true,
        description: 'Aggregate a fully delivered independent review into a Decision Assurance Record.',
      },
      {
        id: 'decision-assurance.network-aggregate', endpoint: endpoint('/api/v1/assurance/network-aggregate'), paid: true,
        description: 'Aggregate registry-bound reviewer wallet attestations into a NETWORK_VERIFIED record.',
      },
      {
        id: 'decision-assurance.record-retrieval', endpoint: endpoint('/api/v1/assurance/records/{recordId}'), paid: false,
        description: 'Retrieve a persisted Decision Assurance Record with its time-limited bearer token.',
      },
      {
        id: 'decision-assurance.outcome-ingestion', endpoint: endpoint('/api/v1/outcomes'), paid: false,
        description: 'Registered outcome authorities submit EIP-191-signed, evidence-bound ex-post claim resolutions.',
      },
      {
        id: 'decision-assurance.reviewer-reliability', endpoint: endpoint('/api/v1/reviewers/{reviewerId}/reliability'), paid: false,
        description: 'Recompute a reviewer profile from immutable, authority-signed ex-post outcomes.',
      },
    ],
  }
}
