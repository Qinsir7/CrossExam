# CrossExam A2MCP API Contract

Version: `0.1`

## Paid capability

`POST /api/v1/assurance/aggregate`

Produces a Decision Assurance Record from a Decision Package and a fully delivered, independently attributed review dispatch. This is a deterministic aggregation service; it does not generate reviewer findings, invent evidence, or complete missing review scopes.

## Service discovery

`GET /.well-known/crossexam.json` returns the public capability manifest. It declares the two x402-paid assurance endpoints, protected record retrieval, X Layer `eip155:196`, and the `exact` x402 scheme. Configure `CROSSEXAM_PUBLIC_URL` in production so endpoint URLs are absolute.

`POST /api/v1/assurance/network-aggregate` accepts the same payload, but requires every delivered review to include an EIP-191 wallet attestation. Each reviewer ID must be bound to a different signing wallet in CrossExam's server-side registry. This endpoint returns `attributionStatus: "NETWORK_VERIFIED"` only after those signatures verify.

## Transaction Preflight

`POST /api/v1/preflight/transaction` is the product-facing x402 service for an exact EVM action. It requires a 32–200 character `Idempotency-Key` before issuing a payment challenge. The current X Layer trade profile derives deterministic binding, approval, native-value, liquidity, and token-transfer claims; it obtains only configured OKX Onchain OS and GoPlus source output, preserves each source request/response hash, and returns a signed `PERMIT`, `HOLD`, or `BLOCK` record.

Required JSON fields are `title`, `actionType`, `chainId`, `data`, and `valueAtRiskUsd`; `to` is required except for `DEPLOY`, while `valueWei`, `from`, `intent`, and `tokenRiskTarget` are optional. For a token trade, use `tokenRiskTarget: "token:xlayer:0x…"`; CrossExam never guesses a token from arbitrary router calldata.

An unavailable, malformed, unmatched, or unnormalized external source is returned only as an honest procurement failure and forces `HOLD`; it is never represented as a reviewer signature, support, or a safe result. A fully delivered built-in source set yields `PROCUREMENT_VERIFIED`, not `NETWORK_VERIFIED`. The `economics.externalEvidenceCostUsdt` field reports actual settled downstream x402 spend only; included API quota/public source evidence has zero reported marginal x402 spend and is labeled by `costBasis`.

### Current deterministic X Layer evidence policy

The built-in sources are each routed only to the claim they can actually
address. CrossExam itself supports the exact action-binding claim from the
canonical transaction it created; this is a first-party deterministic fact,
not an external reviewer opinion.

- OKX Onchain OS liquidity evidence contradicts the liquidity-screening claim
  below **10×** reviewed value at risk, supports it at or above **100×**, and
  remains unresolved in between. A supported result only clears this explicit
  evidence-screening floor; it is not a promise of route-specific slippage or
  execution quality.
- GoPlus X Layer token evidence contradicts the transfer-safety claim on a
  reported honeypot, disabled buy/sell, blacklist control, closed source,
  or tax at or above **50%**. It supports the claim
  only if every required deterministic field is present, source is open, the
  token is not a proxy, all relevant flags are false, and buy/sell/transfer
  taxes are present and below that threshold. Missing, malformed, proxy,
  creator-linkage, or otherwise unsupported response shapes remain unresolved.

These policies are intentionally narrow and conservative. A `SUPPORTS` result
does not represent a comprehensive smart-contract audit; any contradiction,
unresolved material premise, stale record, substituted binding, or unmet
verification threshold continues to fail closed in the execution gate.

### Exact X Layer route construction

`POST /api/v1/transactions/quote` is free and read-only. It accepts an X Layer
input token, output token, exact input amount in token units, conservative
slippage (more than `0` and at most `5` percent), and the caller's public wallet
address. CrossExam authenticates a request to the official OKX DEX Swap API,
then returns only the normalized X Layer router `to`, calldata, native `value`,
route protocols, quoted price impact, minimum receive amount when present, and
timestamp.

It never requests token approval, a message signature, an x402 payment, or a
transaction broadcast. The returned transaction is a candidate for a separate
CrossExam preflight; it remains subject to exact action binding and a fresh
evidence review before any executor should act. The quote has its own 25%
upstream price-impact ceiling and is not evidence or a CrossExam verdict.

## Agent Trust Check

`POST /api/v1/preflight/asp` is a paid, endpoint-first ASP purchase check. It requires `endpoint`, `valueAtRiskUsd`, and an `Idempotency-Key`. The current passive profile permits **only GET** against a credential-free HTTPS URL on port 443. It resolves the host before probing, rejects private/link-local/loopback/multicast destinations, pins the validated public IP for TLS, rejects redirects, applies an 8-second timeout and a 64 KiB response limit.

The endpoint inspects an unpaid response for a bounded X Layer exact payment challenge, then compares challenged amount and recipient with optional `expectedPriceAtomic` and `expectedRecipient`. It returns a signed `BUY`, `CAUTION`, or `AVOID` recommendation together with request/response hashes and explicit limitations. `BUY` means only that the observed endpoint/payment contract is coherent; it does not claim marketplace identity, ownership, reputation, or paid behavior. `PAID_CALL` intentionally returns a fail-closed error until a separate recipient-bound procurement policy is enabled.

## x402 payment

The endpoint is protected by the OKX x402 Express SDK.

1. An unpaid request receives `402 Payment Required` and a `PAYMENT-REQUIRED` header.
2. The buyer selects the X Layer `eip155:196` `exact` option, signs the payment payload, and retries with the payment header.
3. After settlement verification, CrossExam processes the same request and returns the assurance record.

The seller configures the receiving address and price server-side. No credential, key, or signing capability is exposed to the browser.

## Idempotent paid delivery

For either paid aggregation endpoint, clients should send a cryptographically random `Idempotency-Key` header (32–200 URL-safe characters) and reuse it only when retrying the exact same request. After a successful settlement and record persistence, CrossExam binds that key to the canonical request fingerprint and record ID. A retry is returned free of charge before the x402 middleware runs, with `Idempotent-Replay: true` and a fresh time-limited record-access token. Reusing the key with different input returns `409`; this prevents an ambiguous retry from becoming new paid work.

## Request

```json
{
  "decision": {
    "id": "DP-042",
    "title": "Approve the proposed action",
    "valueAtRiskUsd": 12000,
    "claims": [
      { "id": "C-1", "statement": "A material premise holds.", "materiality": 0.9 }
    ]
  },
  "dispatch": {
    "id": "RD-042",
    "decisionId": "DP-042",
    "status": "DELIVERED",
    "assignments": [
      {
        "scopeId": "evidence-integrity",
        "status": "DELIVERED",
        "reviewer": {
          "id": "reviewer-source",
          "displayName": "Source Examiner",
          "ownerId": "reviewer-owner",
          "modelFamily": "independent-model",
          "evidenceRoutes": ["primary-web"]
        },
        "delivery": {
          "reviewerId": "reviewer-source",
          "deliveredAt": "2026-07-14T16:00:00.000Z",
          "artifacts": [
            {
              "id": "E-1",
              "kind": "PRIMARY_SOURCE",
              "locator": "https://source.example/evidence",
              "observedAt": "2026-07-14T15:59:00.000Z",
              "excerpt": "Traceable supporting or contradicting evidence.",
              "contentHash": "0x..."
            }
          ],
          "findings": [
            {
              "claimId": "C-1",
              "reviewerId": "reviewer-source",
              "verdict": "SUPPORTS",
              "confidence": 0.8,
              "materiality": 0.9,
              "evidence": "The evidence explains why this claim is supported.",
              "evidenceArtifactIds": ["E-1"]
            }
          ]
        },
        "reason": "Delivered with attributable findings."
      }
    ]
  }
}
```

Every procurement scope must be `DELIVERED`. Each delivery must originate from the reviewer assigned to that scope, provide at least one traceable, content-addressed artifact, and explicitly address every claim in the scope. Every finding cites one or more artifact IDs; `/network-aggregate` recomputes each artifact hash before issuing a record.

## Response

```json
{
  "schemaVersion": "0.1",
  "recordId": "dar_a1b2c3d4e5f6...",
  "issuedAt": "2026-07-14T16:02:00.000Z",
  "attributionStatus": "DECLARED_BY_CALLER",
  "decision": { "...": "original decision package" },
  "dispatch": { "...": "original delivered review dispatch" },
  "result": {
    "claims": [{ "id": "C-1", "verdict": "REFUTED" }],
    "action": "HOLD",
    "effectiveIndependence": 2.7,
    "materialRefutations": 1,
    "materialUnresolved": 0
  }
}
```

`recordId` is derived from a SHA-256 hash of the record content. Changing the input, evidence, delivery, or outcome changes the identifier.

Every paid record is additionally issued with an EIP-191 `serviceAttestation` over the complete record payload. The service's public signer is published in `/.well-known/crossexam.json` under `issuer.recordAttestation.signer`. Executors should verify this signature before relying on a record; the SDK provides `getVerifiedRecord` and `preflightVerified` for that purpose.

## Verify a Decision Assurance Record

`POST /api/v1/assurance/verify` is free and stateless. Give it the complete
record, the exact proposed `ActionIntent`, and an **independently pinned**
`expectedServiceSigner`. It verifies the EIP-191 signature, checks that the
action binding is unchanged, and applies the execution gate without accessing
or trusting a private bearer capability.

```json
{
  "record": { "schemaVersion": "0.1", "recordId": "dar_…", "serviceAttestation": { "scheme": "EIP191", "signer": "0x…", "payloadHash": "0x…", "signature": "0x…" } },
  "expectedServiceSigner": "0x…",
  "intent": {
    "decisionId": "DP-042",
    "valueAtRiskUsd": 5000,
    "actionType": "TRADE",
    "target": "evm:196:0x…",
    "parametersHash": "0x…"
  }
}
```

The server never accepts the signer's address from the record as its trust
anchor. Pin it in deployment configuration or retrieve it from an
independently verified service manifest. A result envelope may contain
unsigned transport metadata such as a time-limited `readAccess` capability;
that metadata is intentionally excluded from the canonical signed payload.

Every `REFUTED` or `UNRESOLVED` claim generates a reversal condition. It specifies the class of independently verifiable evidence needed before an action can be reconsidered; it does not fabricate a favorable resolution.

After a successful paid aggregation, the record is atomically persisted before the API responds. The response includes `persistence: "CREATED"` or `"EXISTING"`; a persistence failure returns `500` rather than presenting an unrecorded result as an audit artifact.

The response also includes a time-limited `readAccess` bearer token. Retrieve a persisted record with `GET /api/v1/assurance/records/{recordId}` and `Authorization: Bearer {token}`. The server stores only a SHA-256 token hash and returns `404` for absent, invalid, expired, or unauthorized requests to avoid disclosing record existence.

## Safe public sharing

Records are private by default. An owner with the current record bearer capability may call `POST /api/v1/assurance/records/{recordId}/share` to create a revocable opaque `darshare_…` link, and may revoke it with `DELETE /api/v1/assurance/records/{recordId}/share/{shareToken}` using the same capability. `GET /api/v1/public/records/{shareToken}` returns only a sanitized projection: record ID, time, attribution, verdict, action title, value reviewed, strongest contradiction, source names/times, and service-attestation metadata.

Public shares never return raw action parameters or bindings, raw evidence, reviewer callbacks, payment information, wallet addresses, bearer capabilities, or private decision notes. The share token is a random capability rather than an enumerable record URL.

## Durable review jobs

## Deep Cross-Examination

`POST /api/v1/cross-examinations/prepare` is free. It accepts either a simple
input (`title`, `intent`, `valueAtRiskUsd`, and optional exact transaction) or
an advanced `DecisionPackage`. It deterministically returns the bound action,
generated material claims, server-matched source plan, fixed quote, and any
limitations. It never calls a provider, creates a durable job, or charges a
wallet.

For the live X Layer path, provide a `transaction` with `actionType`,
`chainId`, `to`, `data`, and optional `valueWei`, plus
`tokenRiskTarget: "token:xlayer:0x…"`. That produces the `PRETRADE_ONCHAIN`
profile bound to the exact EVM payload and the only currently active real
sources: OKX Onchain OS liquidity and GoPlus X Layer token security.

`POST /api/v1/cross-examinations` accepts the same input and starts a durable
job only when every required scope has an active server-registered provider.
It returns an owner capability and the request body for the existing
x402-protected `POST /api/v1/review-jobs/authorize` endpoint. This separation
lets a browser show the exact claims, sources, limitations, and quote before it
asks a wallet to pay. Job creation is free and cannot spend CrossExam's buyer
wallet; the returned authorization is the sole customer payment step.

Generic `GENERAL` requests without a complete real-provider plan are returned
with `canStart: false` and an explicit limitation. CrossExam does not take
payment for those requests, does not substitute synthetic research, and cannot
return a fabricated favorable conclusion. Existing durable-job completion
therefore remains fail-closed: missing evidence results in `HOLD`, not
`PERMIT`.

`POST /api/v1/review-jobs` creates a durable, capability-protected procurement job from a valid Decision Package. The service derives the canonical three-scope plan and matches only active reviewers from the server-owned registry. It returns an `rjv_…` access token exactly once; use it as `Authorization: Bearer {token}` for `GET` or `DELETE /api/v1/review-jobs/{jobId}`. The store retains only its SHA-256 hash. New jobs are deliberately `UNFUNDED`: creation alone cannot cause CrossExam's buyer wallet to spend.

Set `reviewProfile: "PRETRADE_ONCHAIN"` on a Decision Package to use the
product's focused two-scope route: `execution liquidity` and `contract token
risk`. This is the intended path for high-value swaps, approvals, transfers,
and deployments; each provider must come from a distinct configured owner.

For transaction-native clients, use `createEvmActionBinding` from
`src/domain/evmAction`. It canonicalizes `chainId`, recipient, calldata and
value before creating the action hash. A Decision Package may also carry
`reviewEvidenceContext.tokenRiskTarget` in the form
`token:<provider-chain>:0x<contract>`; this explicitly tells a contract-risk
provider which asset to inspect when the executable action targets a router.

`POST /api/v1/review-jobs/authorize` is x402-paid and takes `{ "jobId", "accessToken" }`. It has its own `CROSSEXAM_REVIEW_AUTHORIZATION_PRICE_USD` price floor, separate from completed-dispatch aggregation, so a full review can be sold above bounded external cost. Only a confirmed settlement changes the job to `AUTHORIZED` and records its transaction, asset, and atomic amount. The client and server can idempotently reconcile a confirmed transaction when a post-settlement database write is interrupted. Only then will the procurement worker consider the job for bounded external evidence acquisition.

`POST /api/v1/review-jobs/{jobId}/retry` reopens a settled failed job without charging the customer again. Delivered evidence remains immutable; failed scopes are rematched only to active sources whose configured cost fits inside the original authorized per-scope budget.

`POST /api/v1/review-jobs/recover-access` restores a lost paid-job owner capability without customer support or another payment. The caller signs a five-minute EIP-191 recovery message with the wallet that funded the supplied X Layer transaction. CrossExam independently re-reads the exact USDT0 Transfer log, verifies its sender and recipient, rotates the old bearer capability, and returns the paid job. Unfunded quotes cannot use wallet recovery and expire after 24 hours; funded jobs are never silently cancelled without a refund workflow.

The first production X Layer route combines authenticated OKX Onchain OS liquidity evidence with an independent GoPlus X Layer token-security response. Included API quota and public security data are recorded explicitly at zero marginal cost with immutable request/response hashes; neither is represented as an on-chain payment. Paid sources remain supported when their advertised chain and input contract match the reviewed target. All external API evidence yields `PROCUREMENT_VERIFIED`, never a forged reviewer signature.

Agent and browser-wallet integrations call this route through their own
x402-capable fetcher. The CrossExam SDK exposes `ReviewJobClient.authorize`
for that handoff and never accepts a buyer private key in the API payload.

The review worker sends one blind task per matched scope to an external reviewer provider using a stable `{jobId}:{scopeId}` idempotency key. It records every attempted external call, applies a bounded exponential retry policy, and recovers a stale `DISPATCHING` lease only with the same idempotency key. Once its hard attempt ceiling is exhausted, the job becomes terminal `FAILED` and no remaining scope is purchased. `POST /api/v1/review-jobs/{jobId}/deliveries/{scopeId}` accepts a reviewer callback only after that external request was persisted, and only with the assigned reviewer's valid EIP-191 signature. A job becomes `READY_FOR_ASSURANCE` only after every scope returns content-addressed evidence; its owner can then issue the service-signed record through the capability-protected `/result` endpoint without a second payment. No job endpoint fabricates reviewer work or a payment result.

`GET /api/v1/review-jobs/{jobId}/ledger` uses the same owner capability and returns the immutable commercial quote (authorization price, capped external budget, minimum viable price, expected gross margin), the settled customer income leg, and actual settled external spend grouped by token asset and atomic amount. When every paid leg uses the same asset, it reports realized atomic gross margin; otherwise it deliberately does not fabricate a USD conversion. A scope cannot be marked `REQUESTED`, or accept a delivery, until the worker has recorded a successful x402 settlement transaction for it.

`GET /api/v1/review-jobs/{jobId}/result` uses the same owner capability. Once the job is `READY_FOR_ASSURANCE` and its funding is `AUTHORIZED`, it deterministically issues the registry-bound dispatch at the final delivery timestamp, verifies every reviewer signature and evidence hash again, persists the service-attested `NETWORK_VERIFIED` Decision Assurance Record, and returns a time-limited record access token. Before completion it returns `409 REVIEW_JOB_NOT_READY`; it never manufactures missing scopes.

When at least one configured scope is an ordinary paid evidence source, result
issuance instead returns `PROCUREMENT_VERIFIED`. The response still binds the
actual x402 settlement and content-addressed source output, but never asserts
that the external source signed a CrossExam verdict. The default gate will not
permit a high-value action on this weaker status, although it may safely hold
or block the action when the purchased evidence is unresolved or contradictory.

## Truth and attribution boundary

In `0.1`, an API caller may submit its own reviewer information to the declared aggregation endpoint. CrossExam records that as `DECLARED_BY_CALLER`; it does not claim that the reviewer identity has been independently verified by CrossExam.

`PROCUREMENT_VERIFIED` is the intermediate, honest paid-evidence mode: CrossExam verifies a configured source, settled payment, request hash, retained bounded response hash, and artifact graph, but does not call the response reviewer-signed. The network-verified endpoint is the stronger mode: the signed payload binds the delivery to its dispatch ID, decision ID, scope ID, reviewer ID, artifacts, and findings. Server-owned registry data overwrites caller-supplied owner, model, capability, and evidence-route metadata. A changed artifact, missing artifact citation, replay into another scope, unregistered reviewer, reused owner or wallet, or invalid signature is rejected.

## Reviewer reliability boundary

CrossExam does not assign reputation from reviewer agreement or raw task volume. A reviewer becomes `ESTABLISHED` only after at least five independently adjudicated claim outcomes. The resulting signal weights material accuracy, evidence completeness, and timeliness; material misconduct is penalized. Prior to that threshold, the profile remains `PROVISIONAL` and has no ranking score.

`POST /api/v1/outcomes` accepts a registered authority's EIP-191-signed outcome adjudication. It is not x402-paid: this is a permissioned authority write, not a buyer capability. The signed payload binds one persisted assurance record, one claim, the authority identity, and traceable ex-post evidence. Only deliveries in a `NETWORK_VERIFIED` record may feed reviewer reliability. This prevents a caller from manufacturing favorable history for self-declared reviewer identities. Configure `CROSSEXAM_OUTCOME_AUTHORITY_WALLETS` server-side; the server accepts one immutable resolution per record claim and rejects a silent revision or competing conclusion.

`GET /api/v1/reviewers/{reviewerId}/reliability` recomputes the public reliability profile from that immutable outcome trail. It never returns a ranking score before the reviewer has five independently resolved claims, and it does not use reviewer agreement as an input.

## Execution receipts

`POST /api/v1/executions` accepts a registered executor's EIP-191-signed execution receipt. An `EXECUTED` receipt must match the exact action binding, include an execution/transaction reference, and would have had to pass CrossExam's gate at the stated execution timestamp. The server stores one immutable receipt per assurance record, so the same reviewed action cannot acquire conflicting execution history. Configure `CROSSEXAM_EXECUTOR_WALLETS` server-side.

## Blind challenger task

Before a reviewer is selected or paid, CrossExam creates a `BlindReviewTask` from the Decision Package and the reviewer scope. It carries only scope-specific claims, evidence requirements, and the permitted verdict vocabulary. The source recommendation, peer findings, and aggregate verdict are explicitly withheld during the first review round.

## Pre-action gate

Agent executors should evaluate the returned record before spending, trading, deploying, or publishing. The CrossExam SDK domain hook returns one of `PERMIT`, `REMEDIATE`, `REQUIRE_NETWORK_VERIFICATION`, or `DENY`. It rejects action intents that do not match the reviewed decision or exceed its reviewed value-at-risk, requires network-verified delivery at policy-defined high-value thresholds, and surfaces the claim IDs that must be remediated.

```ts
import { CrossExamClient } from './src/sdk'

const crossExam = new CrossExamClient({ baseUrl: 'https://your-crossexam-domain' })
const gate = await crossExam.preflight(
  { recordId, token: readAccess.token },
  { decisionId: 'DP-042', valueAtRiskUsd: 5000, actionType: 'TRADE', target: 'dex:pool', parametersHash: '0x...' },
)

if (!gate.executable) throw new Error(gate.reasons.join(' '))
// Only now invoke the external trade/payment/deployment executor.
```

For high-value actions, the Decision Package must include an `actionBinding` (type, target, and parameter hash). The gate rejects a substituted target or parameter set even if the decision ID and value-at-risk are reused. The default execution policy also expires a record after 15 minutes; high-stakes executors should verify the service issuer and set an explicit shorter or longer freshness window appropriate to the action.

For an execution-bound integration, use the SDK adapter instead of separately computing a hash, preflighting, and invoking the executor. It hashes the precise payload, refuses execution when the gate is non-executable, and only then gives that same immutable payload to your transaction/deployment executor:

```ts
const receipt = await crossExam.executeBoundAction({
  access: { recordId, token: readAccess.token },
  decisionId: 'DP-042', valueAtRiskUsd: 5000,
  actionType: 'TRADE', target: 'dex:pool',
  parameters: '{"side":"buy","amount":"100"}',
  execute: (action) => submitTrade(action),
})
```

For an EVM wallet or smart account, use `executeVerifiedEvmAction` at the
immediate signing boundary. It verifies the record's EIP-191 service
attestation against a trusted issuer address, re-derives the binding from the
transaction, applies the freshness and contradiction gate, and passes only the
canonical transaction to the wallet callback. Do not use a signer address that
was supplied by the untrusted record itself; pin it from your deployment
configuration or an independently verified CrossExam manifest.

```ts
const txHash = await crossExam.executeVerifiedEvmAction({
  access: { recordId, token: readAccess.token },
  expectedServiceSigner: trustedCrossExamIssuer,
  decisionId: 'DP-042',
  valueAtRiskUsd: 5000,
  actionType: 'TRADE',
  chainId: 196,
  to: '0x…',
  data: '0x…',
  valueWei: '0',
  // tx is lower-cased/canonicalized and matches the reviewed hash exactly.
  execute: (tx) => walletClient.sendTransaction({
    account,
    chain: xLayer,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.valueWei),
  }),
})
```

## Errors

| Status | Meaning |
| --- | --- |
| `402` | No valid x402 payment payload. |
| `422` | Invalid input, a partial dispatch, mismatched reviewer, missing evidence artifact, or a delivery that omits a claim. |
| `503` | Local-only mode with facilitator synchronization intentionally disabled; paid business logic is unavailable. |
