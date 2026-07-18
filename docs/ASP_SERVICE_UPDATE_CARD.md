# CrossExam ASP service-update card

Status: **strategic hold — draft only; no ASP identity or service update has been submitted.**

The 2026-07-18 independent audit found the current ASP still `not listed` / `Listing under review`. Do not submit this delta while that review is pending. First complete the winner-grade clean-browser demo gate in `BUILD_PLAN.md` Day 9.5, then re-check the platform status. This card is retained only for a later explicit owner decision after approval or a concrete rejection.

Prepared against the read-only state of CrossExam ASP `#6065` on 2026-07-18:

- the identity is online but not listed and remains under review;
- the existing `Decision Assurance API` service is present at `GET|POST /api/v1/assurance/aggregate` for `0.02 USDT`;
- the verified production API has x402 enabled, a healthy procurement worker, and a live signed-record issuer;
- no existing service will be renamed, removed, repriced, or pointed to a different endpoint in this update.

## Safe service delta

Keep the existing legacy service unchanged. Add the following direct API services only. Each paid endpoint was observed returning a standard 402 challenge before payment; the free verifier is stateless and returns only after its required structured input is supplied.

| Operation | Name | Type | Fee | Endpoint |
|---|---|---:|---:|---|
| unchanged | Decision Assurance API | API service | 0.02 USDT | `https://api.cross-exam.xyz/api/v1/assurance/aggregate` |
| create | Transaction Preflight ✏️ | API service | 0.02 USDT | `https://api.cross-exam.xyz/api/v1/preflight/transaction` |
| create | Agent Trust Check ✏️ | API service | 0.02 USDT | `https://api.cross-exam.xyz/api/v1/preflight/asp` |
| create | Verify Assurance Record ✏️ | API service | 0 USDT | `https://api.cross-exam.xyz/api/v1/assurance/verify` |

`✏️` means the name and two-part description below are editorial drafts based on the established product contract and need the owner's review before an update.

## Exact service text

### Transaction Preflight ✏️

① Returns a signed PERMIT, HOLD, or BLOCK for one exact EVM transaction using current liquidity and token-risk evidence.

② Provide chain ID, transaction target, calldata, value, value at risk, and token target when relevant.

### Agent Trust Check ✏️

① Returns a signed BUY, CAUTION, or AVOID recommendation after checking an API service's reachable payment contract and behavior.

② Provide the HTTPS endpoint, value at risk, and optional expected price, recipient, or service identity.

### Verify Assurance Record ✏️

① Verifies a signed Decision Assurance Record against a pinned issuer and exact proposed action, then returns the execution gate.

② Provide the record, expected signer, proposed action, and optional freshness policy.

## Intentionally deferred services

Do **not** list `Decision Cross-Examination` as a separate pay-per-call API service yet. Its public start endpoint intentionally creates no payment and returns an authorization capability; payment occurs at the follow-up protected authorization endpoint after a durable review job is created. Advertising the start endpoint itself as a paid service would make the marketplace's direct unpaid-402 probe misleading. The real deep-review path remains live on the product site and API, but its listing must wait until the marketplace supports this explicit multi-step purchase flow.

Do **not** list the internal worker, review-job, result, ledger, recovery, public-share, or outcome endpoints. They are protected protocol surfaces, not standalone buyer services.

## Required owner decision before any update

1. Confirm that the three drafted services and their English copy are acceptable.
2. Confirm that adding services while the current listing remains under review will not be avoided in favor of a clean re-review.
3. Explicitly authorize the external service update; only then may the listing be validated and submitted.
