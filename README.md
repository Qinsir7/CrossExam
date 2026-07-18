# CrossExam

> The adversarial decision layer for autonomous agents.

[Live product](https://www.cross-exam.xyz/) · [API discovery](https://api.cross-exam.xyz/.well-known/crossexam.json) · [API contract](docs/API.md) · [Product contracts](docs/PRODUCT_CONTRACTS.md) · [Build plan](BUILD_PLAN.md)

CrossExam buys independent counter-evidence before a consequential agent action, then returns an evidence-backed verdict, explicit reversal conditions, and a signed guardrail that software can enforce.

## Why

Autonomous agents can spend, trade, publish, deploy, approve, and hire other agents. Most systems optimize for producing an answer or completing an action. Few create an independent economic incentive to find evidence that the proposed action is wrong.

CrossExam separates proposing from challenging. The origin agent submits the action and the material claims that must be true. Independent evidence providers attack those claims without seeing one another's conclusions. CrossExam preserves contradictions and uncertainty instead of averaging them away, signs the resulting record, and gates the exact action that was reviewed.

## How it works

1. **Package the decision** — proposed action, value at risk, and material claims.
2. **Buy the challenge** — an x402 authorization unlocks a bounded evidence budget.
3. **Procure blind counter-evidence** — independent scopes are routed to distinct evidence providers.
4. **Verify provenance** — requests, responses, artifacts, identities, and settlements are content-addressed.
5. **Issue the verdict** — claims survive, are refuted, or remain unresolved; reversal conditions stay explicit.
6. **Enforce the result** — a signed record is bound to the reviewed action and checked at the execution boundary.

## First production network, not the product boundary

The first live network focuses on high-value X Layer transactions because the consequences are irreversible, evidence can be independently measured, and x402 makes the review an actual economic service. It currently combines authenticated OKX Onchain OS liquidity evidence with independent GoPlus token-security evidence.

That is the initial wedge, not the category. The protocol and domain model are action-agnostic: `SPEND`, `TRADE`, `DEPLOY`, `PUBLISH`, and `OTHER` actions share the same decision package, blind evidence procurement, signed assurance record, reversal conditions, and execution gate. The same primitive can protect treasury payments, vendor selection, model releases, production deployments, policy-sensitive publishing, and agent-to-agent delegation.

## Core principles

- Evidence strength, not majority vote.
- Independent review before peer influence.
- Verifiable contradiction is more valuable than agreement.
- Unresolved uncertainty remains visible.
- Every material finding is traceable.

## x402 A2MCP endpoint

CrossExam ships a paid, standardized A2MCP endpoint at `GET|POST /api/v1/assurance/aggregate`. Generic agent inputs receive a prompt, signed, fail-closed intake record; a complete decision package plus an independently delivered review dispatch receives contradiction-first aggregation and a content-derived Decision Assurance Record. It is protected using the official OKX x402 Express SDK on X Layer (`eip155:196`). A request without a valid payment payload receives a standard `402 Payment Required` challenge through the `PAYMENT-REQUIRED` header.

Agents can discover its capabilities at `/.well-known/crossexam.json`.

Paid clients can attach an `Idempotency-Key` to safely recover a completed record after a timeout or network retry, without buying the exact same aggregation twice. The server binds that key to the canonical request body and rejects reuse for different work. Each paid record is also EIP-191-attested by CrossExam's configured service signer; execution clients can verify the issuer before trusting the record.

The endpoint intentionally rejects partial reviews: payment buys deterministic aggregation of attributable evidence, never a fabricated “AI verdict.” The standard route labels caller-supplied review attribution honestly; the network route verifies server-registered reviewer identity, independence, EIP-191 delivery signatures, evidence hashes, and finding-to-artifact links.

## Run the complete offline lifecycle

```bash
npm run demo
```

This creates a Decision Package, obtains three independently signed reviewer deliveries, issues a `NETWORK_VERIFIED` record, blocks its unsafe bound action, accepts an authority-signed ex-post outcome, and rebuilds the challenger's reliability profile. It uses deterministic demo-only keys and an OS temporary data directory—no wallet, payment, or OKX credential is needed. The live paid x402 route remains separate and requires the seller configuration below.

To run the seller service after provisioning an OKX API credential and X Layer receiving address:

```bash
cp .env.example .env.local
npm run x402:serve
```

See [the A2MCP API contract](docs/API.md) for the payment flow, durable review-job lifecycle, request schema, Decision Assurance Record semantics, and explicit truth boundary. The real independent-review provider contract is in [docs/REVIEW_PROVIDER.md](docs/REVIEW_PROVIDER.md).

For a production-style container with a persistent record volume, see [deployment instructions](docs/DEPLOYMENT.md).

For horizontally scaled production, configure `CROSSEXAM_DATABASE_URL`; the included PostgreSQL store shares records, access grants, signed outcomes, and paid-request idempotency across API replicas.

The API runs a recoverable embedded procurement loop against that same
PostgreSQL database. A separate `npm run x402:worker` service is optional
redundancy; database compare-and-swap claims prevent duplicate work across
replicas. Zero-marginal-cost authenticated/public sources run without a buyer
key, while paid downstream x402 sources remain spend-locked behind the
dedicated procurement wallet and per-scope policy.

## Live implementation

Live on [cross-exam.xyz](https://www.cross-exam.xyz/) with its API at [api.cross-exam.xyz](https://api.cross-exam.xyz/.well-known/crossexam.json): durable paid review jobs, real OKX Onchain OS liquidity evidence, independent GoPlus X Layer token-security evidence, provenance-qualified signed records, commercial ledgers, dynamic x402 quotes, action-bound execution gates, authority-signed outcomes, and reproducible reviewer reliability. Paid downstream providers can be added without changing the customer flow when a chain-compatible API service is available.

## North star

CrossExam should become the neutral assurance market between agent intent and irreversible action: any agent can buy adversarial review, any qualified provider can earn by finding decision-changing evidence, and any wallet, runtime, or enterprise policy engine can enforce the signed result.

## License

License selection is pending. All rights reserved until a license is added.
