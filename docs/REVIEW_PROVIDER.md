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

## 3. Ordinary paid evidence sources

CrossExam can also procure from an ordinary synchronous JSON API without asking
the source to implement the callback contract. Register it separately with
`"procurementProtocol":"PAID_EVIDENCE_V1"` and the explicit conservative
`"responseAdapter":"OPAQUE_JSON_V1"`:

```json
{
  "id": "depth-btc",
  "displayName": "DepthBTC execution liquidity",
  "ownerId": "mucvan-depth-btc",
  "modelFamily": "external-paid-api",
  "evidenceRoutes": ["btc-order-book"],
  "capabilities": ["execution liquidity"],
  "wallet": "0x<known-provider-payment-recipient>",
  "status": "ACTIVE",
  "procurementEndpoint": "https://provider.example/api/depth-btc",
  "procurementProtocol": "PAID_EVIDENCE_V1",
  "responseAdapter": "OPAQUE_JSON_V1",
  "paymentRecipient": "0x<known-provider-payment-recipient>",
  "evidenceRequestBody": {}
}
```

CrossExam retains a bounded raw JSON response, its keccak-256 hash, request
hash, settlement transaction, asset, amount and observation time. The opaque
adapter makes no semantic claim about that response; it emits
`INSUFFICIENT_EVIDENCE` and therefore holds the action until a source-specific
deterministic interpreter or a signed reviewer is available. Its final record
is `PROCUREMENT_VERIFIED`, not `NETWORK_VERIFIED`.

`paymentRecipient` is mandatory for paid evidence. The worker compares it with
the `payTo` address in the received x402 challenge before it creates a payment
signature, so an endpoint or DNS compromise cannot redirect a permitted spend.

`CERTIK_TOKEN_SCAN_V1` is a source-specific deterministic adapter for CertiK's
`/api/token-scan` response. It issues a `GET` from an action target formatted
as `token:<chain>:0x<contract>` (or `contract:<chain>:0x<contract>`), retains
the full bounded JSON response, and treats a Critical/Major alert or score
below 50 as `CONTRADICTS`; a score of at least 70 with zero alerts is
`SUPPORTS`. All other response shapes remain `INSUFFICIENT_EVIDENCE`.

## 4. Signed review callback

After independent work, POST the delivery to the callback URL supplied by CrossExam. Its EIP-191 signature binds the job dispatch ID, decision ID, scope ID, reviewer ID, artifacts and findings. Each artifact carries a keccak-256 `contentHash`; every finding cites one or more artifact IDs. The server verifies the registered wallet, content hashes, scope coverage, and reviewer identity before accepting it.

No provider may return a verdict by copying the origin recommendation or peer output. A provider that cannot support or contradict a claim should return `INSUFFICIENT_EVIDENCE` with the artifacts it consulted.
