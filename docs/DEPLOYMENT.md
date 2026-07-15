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

## Shared PostgreSQL production store

For more than one API instance, set `CROSSEXAM_DATABASE_URL` to a managed PostgreSQL connection string. CrossExam then uses PostgreSQL—not the local filesystem—for Decision Assurance Records, bearer-token hashes and expiry, immutable authority outcomes, and paid-request idempotency mappings. The schema is initialized idempotently on first use; deploy the application identity with only the database privileges it needs.

```bash
CROSSEXAM_DATABASE_URL=postgresql://crossexam:...@your-managed-postgres/crossexam?sslmode=require
```

Do not configure a shared network filesystem as a substitute for PostgreSQL: conditional record/outcome/idempotency writes depend on database uniqueness constraints across replicas.

## Required production settings

- `CROSSEXAM_PAY_TO`: a real X Layer receiving wallet.
- `CROSSEXAM_SERVICE_SIGNING_KEY`: a dedicated 32-byte EVM private key for issuing assurance records. It is mandatory when the paid x402 service is enabled; publish only its derived public address in service discovery.
- `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`: seller-side facilitator credentials.
- `CROSSEXAM_X402_SYNC=true`: production default. The server must synchronize supported payment kinds before it presents a paid route.
- `CROSSEXAM_REVIEWER_REGISTRY`: server-owned JSON registry of each reviewer's ID, owner, model family, capabilities, evidence routes, status and EVM wallet when `/network-aggregate` is enabled. Caller-supplied reviewer metadata is not trusted for network-verified records.
- `CROSSEXAM_OUTCOME_AUTHORITY_WALLETS`: authority-ID to EVM-wallet registry for signed outcome ingestion.
- `CROSSEXAM_EXECUTOR_WALLETS`: executor-ID to EVM-wallet registry for signed execution receipt ingestion.
- `CROSSEXAM_DATABASE_URL`: required when horizontally scaling the seller service.

## HTTPS and exposure

Place the container behind an HTTPS reverse proxy and expose a public domain. OKX.AI validates a paid A2MCP endpoint by calling it without a payment header; a live endpoint must answer `402` and include the `PAYMENT-REQUIRED` header. Do not expose the service directly through an unauthenticated development tunnel in production.

## Operational notes

- `/health` is intentionally free and does not expose credentials, reviewer wallets, records, or payment details. It is a liveness probe; use `/ready` as the readiness probe because it verifies the configured persistence backend is reachable.
- Paid aggregation is not reported successful until its Decision Assurance Record is persisted.
- The local file store is appropriate for a single instance with a mounted volume. `CROSSEXAM_DATABASE_URL` selects the included PostgreSQL implementation for horizontal scaling.
