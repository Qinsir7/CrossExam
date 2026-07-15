# CrossExam

> Before an agent acts, make it survive a cross-examination.

CrossExam is an adversarial decision-assurance service for AI agents. It procures independent counter-evidence from specialized agents and reports which claims survived, which were refuted, what remains unresolved, and what should reverse the decision.

## Why

Autonomous agents are increasingly able to spend, trade, publish, deploy, and hire other agents. Most systems optimize for producing an answer or completing an action. Few create a real economic incentive to find evidence that the proposed action is wrong.

CrossExam is designed to make consequential agent decisions inspectable before execution.

## Core principles

- Evidence strength, not majority vote.
- Independent review before peer influence.
- Verifiable contradiction is more valuable than agreement.
- Unresolved uncertainty remains visible.
- Every material finding is traceable.

## x402 A2MCP endpoint

CrossExam ships a paid, standardized A2MCP endpoint at `POST /api/v1/assurance/aggregate`. It accepts a decision package plus an independently delivered review dispatch, then applies CrossExam's contradiction-first aggregation and issues a content-derived Decision Assurance Record. It is protected using the official OKX x402 Express SDK on X Layer (`eip155:196`). A request without a valid payment payload receives a standard `402 Payment Required` challenge.

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

## Status

Production-shaped assurance core: durable blind review jobs, server-owned reviewer identity, signed network verification, buyer- and seller-side X Layer x402 rails with spend policy, action-bound execution gates, authority-signed outcomes, and reproducible reviewer reliability. Live operation still requires real reviewer endpoints, dedicated funded wallets, seller facilitator credentials, and a public HTTPS deployment.

## License

License selection is pending. All rights reserved until a license is added.
