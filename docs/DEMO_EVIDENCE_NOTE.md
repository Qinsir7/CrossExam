# Sanitized live demo evidence

Observed on 2026-07-19 (Asia/Shanghai) in the production browser flow. This note deliberately excludes review IDs, read capabilities, payment proofs, wallet addresses, transaction hashes, route calldata, provider credentials, and settlement headers.

## Scenario

- Candidate: exact X Layer 10,000 USDT0-to-WOKB route.
- Boundary: CrossExam generated and reviewed the exact route, but did not request a transaction signature or broadcast a swap.
- Customer review revenue: **0.20 USDT0**.

## Evidence and economics shown by the record

| Scope | Production source | Visible source state | Provenance | Cost basis |
| --- | --- | --- | --- | --- |
| Execution liquidity | OKX Onchain OS Market | REQUESTED | Verified | Included quota (0.005 USDT estimated) |
| Contract and token risk | GoPlus X Layer Token Security | REQUESTED | Verified | Included quota (0 USDT estimated) |

- External settled cost: **0.00 USDT0**.
- Realized gross margin: **0.20 USDT0**.

## Outcome

- Verdict: **CONDITIONAL**.
- Material premise: **C-TOKEN-TRANSFER-SAFETY**.
- Reason: the deterministic GoPlus fields required to resolve transfer safety were incomplete; CrossExam did not label the asset malicious.
- Execution gate: **REMEDIATE**. The exact action remains non-executable until the listed uncertainty is resolved.

The result page refreshed successfully from its protected browser session. The execution-gate control performs a local, deterministic policy re-evaluation only; it cannot sign or broadcast a transaction.
