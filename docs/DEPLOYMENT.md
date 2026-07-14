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

`CROSSEXAM_DATA_DIR` defaults to `/var/lib/crossexam` in the container. The mounted volume is mandatory for any environment where record durability matters.

## Required production settings

- `CROSSEXAM_PAY_TO`: a real X Layer receiving wallet.
- `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`: seller-side facilitator credentials.
- `CROSSEXAM_X402_SYNC=true`: production default. The server must synchronize supported payment kinds before it presents a paid route.
- `CROSSEXAM_REVIEWER_WALLETS`: reviewer-ID to EVM-wallet registry when `/network-aggregate` is enabled.

## HTTPS and exposure

Place the container behind an HTTPS reverse proxy and expose a public domain. OKX.AI validates a paid A2MCP endpoint by calling it without a payment header; a live endpoint must answer `402` and include the `PAYMENT-REQUIRED` header. Do not expose the service directly through an unauthenticated development tunnel in production.

## Operational notes

- `/health` is intentionally free and does not expose credentials, reviewer wallets, records, or payment details.
- Paid aggregation is not reported successful until its Decision Assurance Record is persisted.
- The local file store is appropriate for a single instance with a mounted volume. Before horizontal scaling, replace `AssuranceRecordStore` with a shared durable implementation and preserve the same no-overwrite contract.
