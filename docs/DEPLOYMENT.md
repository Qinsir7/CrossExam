# CrossExam x402 ASP Deployment

The CrossExam seller is a stateful x402 API: mount a persistent volume for Decision Assurance Records and keep all credentials server-side.

## Build and run

```bash
docker build -t crossexam-asp .
docker run --rm \
  --env-file .env.local \
  --publish 4022:4022 \
  --volume crossexam-records:/var/lib/crossexam \
  crossexam-asp
```

`CROSSEXAM_DATA_DIR` defaults to `/var/lib/crossexam` in the container. The mounted volume is mandatory for any single-instance filesystem deployment.

Railway does not support Dockerfile `VOLUME` declarations. For Railway, provision its managed PostgreSQL service and set `CROSSEXAM_DATABASE_URL` to the Postgres service reference; do not attach a local filesystem volume.

When the web app is hosted on a different origin, set `CROSSEXAM_ALLOWED_ORIGINS` explicitly (for example, `https://cross-exam.xyz,https://www.cross-exam.xyz`). The API rejects browser origins not on this allowlist. Managed container platforms commonly provide `PORT`; CrossExam honours it before `CROSSEXAM_PORT`.

## Shared PostgreSQL production store

For more than one API instance, set `CROSSEXAM_DATABASE_URL` to a managed PostgreSQL connection string. CrossExam then uses PostgreSQL—not the local filesystem—for Decision Assurance Records, bearer-token hashes and expiry, immutable authority outcomes, and paid-request idempotency mappings. The schema is initialized idempotently on first use; deploy the application identity with only the database privileges it needs.

```bash
CROSSEXAM_DATABASE_URL=postgresql://crossexam:...@your-managed-postgres/crossexam?sslmode=require
```

Do not configure a shared network filesystem as a substitute for PostgreSQL: conditional record/outcome/idempotency writes depend on database uniqueness constraints across replicas.

## Required production settings

- `CROSSEXAM_PAY_TO`: a real X Layer receiving wallet.
- `CROSSEXAM_SERVICE_SIGNING_KEY`: a dedicated 32-byte EVM private key for issuing assurance records. It is mandatory when the paid x402 service is enabled; publish only its derived public address in service discovery.
- `CROSSEXAM_TRANSACTION_PREFLIGHT_PRICE_USD`: the fixed buyer price for `POST /api/v1/preflight/transaction` (default `0.02`). It is deliberately separate from the legacy aggregate price. Add it to Railway only in the same authorized deployment as the new route.
- `CROSSEXAM_ASP_TRUST_PRICE_USD`: the fixed buyer price for `POST /api/v1/preflight/asp` (default `0.02`). The passive probe performs no target payment; do not enable a paid target-service call through this setting.
- `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`: seller-side facilitator credentials.
- `CROSSEXAM_X402_SYNC=true`: production default. The server must synchronize supported payment kinds before it presents a paid route.
- `CROSSEXAM_REVIEW_AUTHORIZATION_PRICE_USD`: full-review price floor. CrossExam automatically quotes higher-cost jobs upward to preserve the configured margin.
- `CROSSEXAM_REVIEWER_REGISTRY`: server-owned JSON registry of each reviewer's ID, owner, model family, capabilities, evidence routes, status and EVM wallet when `/network-aggregate` is enabled. Caller-supplied reviewer metadata is not trusted for network-verified records.
- `CROSSEXAM_OUTCOME_AUTHORITY_WALLETS`: authority-ID to EVM-wallet registry for signed outcome ingestion.
- `CROSSEXAM_EXECUTOR_WALLETS`: executor-ID to EVM-wallet registry for signed execution receipt ingestion.
- `CROSSEXAM_DATABASE_URL`: required when horizontally scaling the seller service.

## Buyer-side reviewer procurement

The API process never needs a buyer wallet to serve assurance records or call zero-cost authenticated/public evidence sources. Its embedded procurement loop starts whenever `CROSSEXAM_PUBLIC_URL` is configured. Add the following secrets and spend controls only when enabling paid downstream x402 sources; a separate worker can run as redundant capacity against the same database:

- `CROSSEXAM_PROCUREMENT_SIGNING_KEY`: a dedicated, funded X Layer buyer key—never reuse the issuer key.
- `CROSSEXAM_PROCUREMENT_MAX_PER_SCOPE_ATOMIC`: absolute token-unit cap for one external review request.
- `CROSSEXAM_PROCUREMENT_ALLOWED_ASSETS`: comma-separated X Layer token contract allowlist.
- `CROSSEXAM_PUBLIC_URL`: HTTPS callback base used by reviewers to return their EIP-191-signed deliveries.
- Each active `CROSSEXAM_REVIEWER_REGISTRY` entry needs an HTTPS `procurementEndpoint`. Use `procurementProtocol: "CROSSEXAM_SIGNED_CALLBACK_V1"` for an independent reviewer that implements the signed callback contract. Use `procurementProtocol: "PAID_EVIDENCE_V1"` together with a supported `responseAdapter` and an immutable `paymentRecipient` for a generic JSON x402 evidence API; the worker rejects any 402 challenge whose recipient differs from that binding. Paid evidence is retained as provenance and can never be labeled as a signed reviewer.

The live X Layer pretrade sources (OKX Onchain OS liquidity and GoPlus token security) are registered by the server and require no registry JSON. [PRODUCTION_PROVIDER_REGISTRY.example.json](./PRODUCTION_PROVIDER_REGISTRY.example.json) retains two suspended paid-provider examples for adapter configuration; neither is eligible for the current X Layer product path. Activate a paid entry only after verifying its target-chain coverage and 402 challenge. For X Layer USDT0, allowlist `0x779ded0c9e1022225f8e0630b35a9b54be713736` and set a deliberate atomic per-scope ceiling; it is a hard ceiling, not a target spend.

Run one recoverable pass with `npm run x402:procure`, or run the production loop with `npm run x402:worker`. On Railway, create a second service from the same GitHub repository, point it at the same Postgres service, and set its start command to `npm run x402:worker`; it does not need a public domain. Its deliberate least-privilege variable set is `CROSSEXAM_DATABASE_URL`, `CROSSEXAM_PUBLIC_URL`, `CROSSEXAM_REVIEWER_REGISTRY`, `CROSSEXAM_PROCUREMENT_SIGNING_KEY`, `CROSSEXAM_PROCUREMENT_MAX_PER_SCOPE_ATOMIC`, `CROSSEXAM_PROCUREMENT_ALLOWED_ASSETS`, the three `OKX_*` Market API credentials used by the authenticated liquidity source, and optional worker timing controls. Do not copy `CROSSEXAM_PAY_TO` or `CROSSEXAM_SERVICE_SIGNING_KEY` into the worker. The worker considers only jobs whose owner has completed the x402-paid `/api/v1/review-jobs/authorize` step; creating a job cannot spend the buyer wallet. It rejects all non-`exact`, non-X-Layer, unapproved-asset, over-cap, redirecting, or no-402 procurement flows before it creates a payment signature. Every external request has a durable `{jobId}:{scopeId}` idempotency key and records the settled asset, amount and transaction reference on the job. It applies bounded exponential retry, a stale-dispatch lease, and a hard attempt ceiling; exhausting a single paid review scope terminates the job before it can create further scope spend.

## HTTPS and exposure

Place the container behind an HTTPS reverse proxy and expose a public domain. OKX.AI validates a paid A2MCP endpoint by calling it without a payment header; a live endpoint must answer `402` and include the `PAYMENT-REQUIRED` header. Do not expose the service directly through an unauthenticated development tunnel in production.

## Operational notes

- `/health` is intentionally free and does not expose credentials, reviewer wallets, records, or payment details. It returns whether the x402 payment rail is enabled and a `procurementWorker` state. Once the separate Railway worker is running, it persists a heartbeat every five minutes; `HEALTHY` means the most recent heartbeat is no older than 12 minutes, while `UNSEEN` or `STALE` means no live worker should be trusted to fulfill paid review jobs. Use `/ready` as the API readiness probe because it verifies the configured persistence backend is reachable.
- Paid aggregation is not reported successful until its Decision Assurance Record is persisted.
- The local file store is appropriate for a single instance with a mounted volume. `CROSSEXAM_DATABASE_URL` selects the included PostgreSQL implementation for horizontal scaling.
