# CrossExam External Review Provider Contract

This contract is for a real independent reviewer ASP. It is deliberately narrow: CrossExam pays only for a provider to accept a blind-review task; the provider independently investigates it and later returns a signed delivery.

## 1. Registry entry

CrossExam configures an active reviewer with a unique owner, distinct wallet, scope capability, and HTTPS `procurementEndpoint`:

```json
{
  "id": "independent-source-lab",
  "displayName": "Independent Source Lab",
  "ownerId": "source-lab-inc",
  "modelFamily": "retrieval-plus-human-qc",
  "evidenceRoutes": ["primary-web", "onchain"],
  "capabilities": ["source verification"],
  "wallet": "0x...",
  "status": "ACTIVE",
  "procurementEndpoint": "https://provider.example/v1/crossexam/reviews",
  "procurementProtocol": "CROSSEXAM_SIGNED_CALLBACK_V1"
}
```

## 2. Procurement handshake

CrossExam `POST`s the blind task to the provider endpoint with `Content-Type: application/json` and a stable `Idempotency-Key: {jobId}:{scopeId}`. The payload includes `task`, but never the source recommendation, peer findings, or aggregate verdict.

The provider must first answer `402 Payment Required` with a valid x402 `PAYMENT-REQUIRED` header. The only accepted payment option is X Layer `eip155:196`, `exact`, and an allowlisted token within CrossExam's configured atomic cap. CrossExam retries the identical payload once with the x402 `PAYMENT-SIGNATURE` header. A successful paid response must include a valid settlement header and:

```json
{ "requestId": "provider-stable-request-id" }
```

The provider must honour the idempotency key: a retry must return the same `requestId` and must not bill a second review.

An ordinary synchronous A2MCP/x402 data endpoint is **not** a CrossExam reviewer
endpoint. CrossExam will not register it for `NETWORK_VERIFIED` work merely
because it returns an x402 payment challenge: it must explicitly implement this
signed callback protocol. This prevents a purchased market-data response from
being mislabeled as an independently signed verdict.

## 3. Signed review callback

After independent work, POST the delivery to the callback URL supplied by CrossExam. Its EIP-191 signature binds the job dispatch ID, decision ID, scope ID, reviewer ID, artifacts and findings. Each artifact carries a keccak-256 `contentHash`; every finding cites one or more artifact IDs. The server verifies the registered wallet, content hashes, scope coverage, and reviewer identity before accepting it.

No provider may return a verdict by copying the origin recommendation or peer output. A provider that cannot support or contradict a claim should return `INSUFFICIENT_EVIDENCE` with the artifacts it consulted.
