# CrossExam Product Contracts

This document maps the product-facing CrossExam services to the existing
durable review, payment, evidence, and record primitives. It is deliberately
additive: the existing `/api/v1/assurance/aggregate` endpoint remains the
low-level deterministic aggregation API submitted to OKX.AI.

## Shared action contract

All new product services accept or derive an `AssuranceAction` from
`src/domain/assuranceAction.ts`.

For EVM action intake, the action hash is created only through the existing
`createEvmActionBinding` implementation. The binding covers `chainId`, `to`,
`data`, and `valueWei`; no product endpoint may introduce a second transaction
hashing scheme.

| Product concept | Existing durable primitive | Rule |
| --- | --- | --- |
| Normalized action | `ActionBinding` + `DecisionPackage` | Product action maps to a Decision Package before procurement. |
| Exact EVM transaction | `canonicalizeEvmTransaction` + `createEvmActionBinding` | The executor and review path must derive the same canonical payload. |
| Evidence plan | `ReviewPlan` | A profile selects scoped evidence work, never a conclusion. |
| Durable paid work | `ReviewJob` | Job creation is unfunded; only the existing authorization route may unlock evidence procurement. |
| Evidence provenance | `ReviewDelivery` / `ExternalEvidenceProvenance` | Authenticated/public API data remains `PROCUREMENT_VERIFIED`, never a fictional reviewer signature. |
| Signed result | `DecisionAssuranceRecord` + service attestation | Persist before returning a paid success. |
| Enforcement | `evaluatePreAction` / `executeVerifiedEvmAction` | A different target, calldata, value, signer, or stale record fails closed. |

## Product endpoint contracts

The TypeScript request and response contracts live in
`src/domain/assuranceContracts.ts`.

| Endpoint | Price target | Input | Result | Existing implementation to reuse |
| --- | ---: | --- | --- | --- |
| `POST /api/v1/preflight/transaction` | 0.02 USDT | Exact EVM transaction, value at risk, optional intent and token target | Signed `PERMIT` / `HOLD` / `BLOCK` record | EVM binding, pretrade review plan, durable job, existing evidence adapters, attestation, gate |
| `POST /api/v1/preflight/asp` | 0.02 USDT | Endpoint plus optional ASP/service/expected-payment metadata | Signed `BUY` / `CAUTION` / `AVOID` recommendation | New passive probe, existing x402 policy and record attestation |
| `POST /api/v1/cross-examinations/prepare` | Free | Simple intent or a complete Decision Package | Explicit claims, supported evidence plan, quote, limitations | Product action adapter + review planner |
| `POST /api/v1/cross-examinations` | 0.20 USDT | Same as prepare | Durable review job and access capability | Existing review job, authorization, worker, ledger, recovery, result |
| `POST /api/v1/assurance/verify` | Free | Record, pinned expected signer, exact intended action | Signature/action/gate verification | Existing attestation verifier and pre-action gate |

## Canonical primary demo shape

The primary demo is an X Layer token trade. The transaction shape is fixed now;
the live asset/router/calldata is selected only during production demo
acceptance and must be a real target with stable applicable evidence.

```json
{
  "actionType": "TRADE",
  "chainId": 196,
  "from": "0x<demo-wallet>",
  "to": "0x<router-or-executor>",
  "data": "0x<exact-calldata>",
  "valueWei": "0",
  "valueAtRiskUsd": 5000,
  "tokenRiskTarget": "token:xlayer:0x<target-token>",
  "intent": "Buy the target token with up to 5,000 USDT only if executable liquidity and transfer safety survive independent review."
}
```

Required evidence for the demo:

1. Authenticated OKX Onchain OS liquidity evidence tied to the target token.
2. Independent GoPlus X Layer contract/token-risk evidence tied to the target token.
3. Canonical binding of the reviewed chain, recipient, calldata, and native value.
4. A persisted, service-signed assurance record.
5. An execution-gate attempt using the same canonical transaction.

If a source is not applicable to the selected target, the final result must be
`HOLD` or `BLOCK`; it must never be rewritten as supporting evidence.

## Compatibility rule

The following existing routes are submitted and must remain behaviorally
compatible throughout this build:

- `GET /api/v1/assurance/aggregate`
- `POST /api/v1/assurance/aggregate`
- `POST /api/v1/assurance/network-aggregate`
- `POST /api/v1/review-jobs/authorize`

Every new paid route will use its own middleware configuration and price. No
new route may alter the existing aggregate challenge, price, route method,
response latency expectations, or fail-closed behavior.
