# CrossExam — Final Product Build Plan

> Canonical execution document for the final OKX.AI Genesis build.
>
> Last planned: 2026-07-18 (Asia/Shanghai)
>
> Competition deadline: 2026-07-27 23:59 UTC
>
> This document is intentionally explicit. A future implementation agent must follow it in order, update the checkboxes as work lands, and never replace production truth with mock behavior.

## 0. How to use this document

This is the single source of truth for the next build phase. Do not begin by redesigning the architecture or inventing a different product direction.

Before changing code, the implementation agent must:

1. Read this file completely.
2. Read `README.md`, `docs/API.md`, `docs/DEPLOYMENT.md`, and `.env.example` completely.
3. Inspect `git status`, the last five commits, and all existing routes in `server/app.ts`.
4. Run the existing baseline checks:
   - `npm run lint`
   - `npm test -- --run`
   - `npm run build`
5. Confirm that no `.env*` secret file is tracked.
6. Confirm current production health before deployment:
   - `https://www.cross-exam.xyz/`
   - `https://api.cross-exam.xyz/health`
   - `https://api.cross-exam.xyz/ready`
   - `https://api.cross-exam.xyz/.well-known/crossexam.json`
7. Preserve backward compatibility for the currently submitted paid endpoint:
   - `GET /api/v1/assurance/aggregate`
   - `POST /api/v1/assurance/aggregate`
8. Never mutate the OKX.AI ASP listing, activate/deactivate an identity, spend from a wallet, change DNS, change Railway/Vercel production variables, or push a destructive deployment without the required user confirmation.

When a task is complete, change only its checkbox from `[ ]` to `[x]`, add a concise evidence note below it, and commit the implementation. Do not mark a task complete based only on code existing; its acceptance criteria must pass.

## 1. Product decision — do not reinterpret

### 1.1 Category

CrossExam is the execution firewall and adversarial assurance layer for autonomous agents.

It is not:

- a generic token scanner;
- a dashboard that merely displays third-party data;
- a chatbot that produces confident prose;
- an ordinary multi-agent debate;
- a security score with no execution consequence;
- a marketplace directory;
- a demo that fabricates reviewers, payments, evidence, or verdicts.

### 1.2 One-sentence promise

Before an agent spends, trades, approves, deploys, publishes, or hires another agent, CrossExam buys counter-evidence and returns a signed `PERMIT`, `HOLD`, or `BLOCK` decision that the executor can enforce against the exact action.

### 1.3 Product wedge and category boundary

The production wedge is high-value onchain action on X Layer because:

- the action is irreversible;
- the parameters can be bound exactly;
- evidence can be fetched and verified programmatically;
- x402 provides real machine-to-machine revenue;
- the final result can block a wallet call at the signing boundary.

The category remains broader than Web3 security. The same engine must support:

- transaction preflight;
- payment and treasury decisions;
- ASP/service purchase decisions;
- deployment and upgrade decisions;
- eventually publishing and other policy-sensitive actions.

The website and copy must always communicate both facts: a real onchain wedge today and an action-agnostic assurance layer long term.

### 1.4 Primary demo story

The canonical demo is:

1. An agent proposes a $5,000 X Layer token purchase based on apparently positive claims.
2. CrossExam extracts the material claims required for the trade to be rational and executable.
3. The customer pays CrossExam through x402.
4. CrossExam obtains real OKX Onchain OS liquidity evidence and independent contract/token risk evidence.
5. At least one material premise is contradicted or unresolved by real provider output.
6. CrossExam issues a signed, action-bound `BLOCK` or `HOLD` record.
7. The execution guard attempts the exact transaction and refuses to send it.
8. The UI shows customer payment, evidence sources, realized evidence cost, signed record, protected value, and the precise contradiction.

No pre-written fake result may be presented as a live run. A prefilled input is allowed; the output must come from production services.

## 2. Target users and jobs to be done

### 2.1 Primary user: autonomous-agent developer

Job:

> “Before my agent invokes a consequential tool, give me a machine-readable, evidence-backed decision that can prevent a bad action.”

Success means:

- one API/SDK call before the executor;
- low integration effort;
- deterministic action binding;
- predictable latency and pricing;
- a signed record suitable for logs and policy audits;
- no private key sent to CrossExam.

### 2.2 Secondary user: treasury/operator

Job:

> “Before a large transfer, approval, swap, or deployment, show the strongest contradiction and stop execution when policy is violated.”

Success means:

- natural-language input or wallet transaction input;
- explicit value at risk;
- human-readable evidence;
- a clear recommendation rather than an opaque score;
- a downloadable/shareable record.

### 2.3 Native OKX.AI user: agent buying an ASP service

Job:

> “Before paying another ASP, check that the identity, endpoint, x402 challenge, advertised price, availability, and service behavior are coherent.”

Success means:

- input can be an agent ID, service endpoint, or both;
- CrossExam never pays the target service unless the caller explicitly selects an active-call depth that includes purchase;
- the result distinguishes listing facts, endpoint facts, and inferred risk;
- the result is `BUY`, `CAUTION`, or `AVOID`, mapped internally to the common assurance verdict.

### 2.4 Future enterprise user

Job:

> “Apply assurance policy to every agent action and maintain an immutable evidence trail.”

This informs architecture but is not a ten-day requirement. Avoid enterprise administration screens until the core live flow is excellent.

## 3. Service catalog and monetization

One CrossExam ASP should expose multiple discoverable services backed by one assurance engine. Services must have distinct buyer outcomes, schemas, endpoints, and prices. Do not create filler services such as a paid health check.

### 3.1 Service A — Transaction Preflight

- Marketplace name: `Transaction Preflight`
- Mode: paid standardized API service
- Recommended price: `0.02 USDT` per call
- Endpoint target: `POST /api/v1/preflight/transaction`
- Buyer outcome: signed `PERMIT`, `HOLD`, or `BLOCK` for an exact EVM transaction.
- Required input:
  - `chainId`
  - `from` when known
  - `to` (optional only for contract creation)
  - `data`
  - `valueWei`
  - `valueAtRiskUsd`
  - optional `tokenRiskTarget`
  - optional natural-language `intent`
- Required output:
  - normalized action binding and hash;
  - material claims automatically derived from the transaction and intent;
  - evidence observations with source and timestamp;
  - strongest contradiction;
  - verdict and reasons;
  - reversal conditions;
  - service attestation;
  - record access token/URL;
  - `canExecute` boolean.

This is the fastest, highest-frequency paid entry point and the primary live demo endpoint.

### 3.2 Service B — Agent Trust Check

- Marketplace name: `Agent Trust Check`
- Mode: paid standardized API service
- Recommended price: `0.02 USDT` per call
- Endpoint target: `POST /api/v1/preflight/asp`
- Buyer outcome: signed `BUY`, `CAUTION`, or `AVOID` recommendation for a particular ASP service purchase.
- Required input:
  - `agentId` and/or `endpoint`;
  - optional `serviceId`;
  - optional expected price;
  - optional intended request and value at risk;
  - `probeMode`: `PASSIVE` by default, `PAID_CALL` only when explicitly selected.
- Passive checks:
  - identity/listing status when an official supported lookup is available;
  - HTTPS and response reachability;
  - expected method behavior;
  - standard 402 challenge presence;
  - x402 version, network, asset, amount, timeout, and recipient;
  - advertised price versus challenged price;
  - redirects and host mismatch;
  - content type and latency;
  - service description versus endpoint behavior where deterministically observable.
- Active check:
  - optional real x402 purchase through the procurement wallet;
  - same spend caps, recipient binding, asset allowlist, redirect rejection, idempotency, and ledger rules as existing provider procurement.
- Required output:
  - facts grouped into `IDENTITY`, `LISTING`, `PAYMENT`, `AVAILABILITY`, and `BEHAVIOR`;
  - no invented reputation or ownership data;
  - strongest contradiction;
  - signed recommendation;
  - evidence/probe hashes;
  - actual paid-call settlement only when performed.

Important dependency: first investigate whether OKX exposes an official server-side agent/service discovery API. If no supported API exists, ship endpoint-first trust checking and clearly label agent metadata as unavailable rather than scraping private endpoints.

### 3.3 Service C — Deep Cross-Examination

- Marketplace name: `Decision Cross-Examination`
- Mode: paid standardized API service
- Recommended launch price: `0.20 USDT`; increase only after real demand.
- Endpoint target: `POST /api/v1/cross-examinations`
- Buyer outcome: multi-source adversarial review of a consequential decision, ending in a signed assurance record.
- Required input supports two shapes:
  1. Simple: `intent`, `valueAtRiskUsd`, and optional action/transaction details.
  2. Advanced: existing complete `DecisionPackage`.
- The server must:
  - compile simple input into explicit material claims;
  - expose generated claims before spending external budget when the web client uses the two-step flow;
  - choose a supported review profile;
  - purchase/fetch evidence through registered adapters;
  - preserve source independence and provenance;
  - aggregate contradictions without majority voting;
  - issue a signed record;
  - persist revenue, costs, and gross margin.
- For the first ten-day version, production-grade profiles are:
  - `PRETRADE_ONCHAIN`
  - `ASP_PURCHASE`
- `GENERAL` may accept caller-supplied evidence and explicit claims, but must not pretend that arbitrary claims were independently researched unless a real provider completed that scope.

The current durable review-job lifecycle should power this service. Build a simpler façade; do not delete the hardened job, authorization, recovery, procurement, and record code.

### 3.4 Service D — Verify Assurance Record

- Marketplace name: `Verify Assurance Record`
- Mode: free standardized API service
- Endpoint target: `POST /api/v1/assurance/verify`
- Buyer outcome: independent verification that a record is authentic, fresh, and bound to the proposed action.
- Required input:
  - record plus attestation, or protected `recordId` plus access token;
  - proposed exact action;
  - expected service signer;
  - optional freshness policy.
- Required output:
  - signature validity;
  - record hash validity;
  - action-binding match;
  - freshness;
  - attribution status;
  - executable status and reasons.

This is free because it drives SDK adoption and makes paid CrossExam records useful to other wallets and agents.

### 3.5 Service E — Deep Investigation

- Marketplace name: `Deep Adversarial Investigation`
- Mode: negotiated agent-to-agent service
- Suggested starting quote: `5 USDT`, negotiated upward by scope.
- Buyer outcome: custom high-value investigation with an evidence bundle and assurance record.
- Appropriate work:
  - multi-round protocol/vendor due diligence;
  - complex treasury decisions;
  - deployment/upgrade review;
  - decisions requiring sources not yet standardized as adapters.
- Do not register this service until communication, task intake, delivery, and dispute handling are tested end to end.
- It is optional for the competition submission if the standardized services are stronger without it.

### 3.6 Existing aggregate endpoint

The current paid endpoint remains supported:

- `GET /api/v1/assurance/aggregate`
- `POST /api/v1/assurance/aggregate`

Rules:

- Never break its standard unpaid 402 challenge.
- Never increase its latency enough to trigger marketplace timeout.
- Keep generic GET/POST fail-closed behavior for backward compatibility.
- Do not use it as the website’s primary product entry after the new façades exist.
- Treat it as a low-level deterministic aggregation capability, not the whole product.

## 4. Shared product model

### 4.1 Canonical action

Every paid service must normalize input into a common `AssuranceAction`:

```ts
type AssuranceAction = {
  id: string
  kind: 'TRANSACTION' | 'ASP_PURCHASE' | 'DEPLOYMENT' | 'PUBLISH' | 'OTHER'
  title: string
  valueAtRiskUsd: number
  intent?: string
  binding: {
    actionType: 'SPEND' | 'TRADE' | 'DEPLOY' | 'PUBLISH' | 'OTHER'
    target: string
    parametersHash: `0x${string}`
  }
  evm?: {
    chainId: number
    from?: `0x${string}`
    to?: `0x${string}`
    data: `0x${string}`
    valueWei: string
  }
  aspPurchase?: {
    agentId?: string
    serviceId?: string
    endpoint: string
    expectedPriceAtomic?: string
  }
}
```

Do not create a parallel action-binding algorithm. Reuse and extend `src/domain/actionBinding.ts` and `src/domain/evmAction.ts` so SDK and server derive identical hashes.

### 4.2 Claim compiler

The buyer should not need to invent all material claims manually.

Implement a deterministic claim compiler first:

- Transaction claims:
  - target matches user intent;
  - calldata/value are within stated scope;
  - asset is transferable and not honeypot-like;
  - approval amount/operator are acceptable;
  - executable liquidity is sufficient for intended size;
  - expected loss/slippage is below policy;
  - destination/contract is not contradicted by available risk evidence.
- ASP purchase claims:
  - endpoint is reachable over HTTPS;
  - payment challenge is standard and on X Layer;
  - asset and price match expectations;
  - payment recipient is stable and expected when a binding exists;
  - service behavior matches the advertised contract at the level actually observed.

An optional LLM may improve natural-language extraction, but it must only produce candidate claims and structured intent. It must never be treated as truth or evidence.

If an LLM provider is added:

- define a provider interface;
- use server-only credentials;
- validate every result against a strict schema;
- cap latency, retries, and token usage;
- record model/provider/version in provenance;
- fall back to deterministic claims;
- never expose prompts or secrets in public responses;
- never let model output directly set `PERMIT`.

### 4.3 Evidence observation

Normalize every source into:

```ts
type EvidenceObservation = {
  id: string
  scopeId: string
  sourceId: string
  sourceOwner: string
  kind: 'AUTHENTICATED_API' | 'PUBLIC_API' | 'PAID_API' | 'SIGNED_REVIEWER'
  observedAt: string
  requestHash: `0x${string}`
  responseHash: `0x${string}`
  locator: string
  facts: Array<{
    key: string
    value: string | number | boolean | null
    unit?: string
  }>
  addressedClaimIds: string[]
  cost?: {
    asset: `0x${string}`
    amountAtomic: string
    transaction?: `0x${string}`
  }
}
```

Requirements:

- Store bounded source output or a content-addressed representation sufficient to reproduce the fact extraction.
- Never turn a generic API response into a “reviewer signature.”
- Preserve `PROCUREMENT_VERIFIED` versus `NETWORK_VERIFIED` distinctions.
- Treat source owner independence as explicit data, not a guessed score.
- Store observation timestamps and apply freshness policy.
- Do not allow evidence fetched for one action/asset to be replayed as evidence for another action/asset.

### 4.4 Verdict vocabulary

Internally use one common set:

- `PERMIT`: required claims survived, no material contradiction, attribution/freshness policy satisfied.
- `HOLD`: evidence incomplete, stale, conflicting, or below the required verification tier.
- `BLOCK`: one or more material premises were refuted or an explicit safety policy failed.

Scenario-specific presentation aliases:

- ASP purchase: `BUY`, `CAUTION`, `AVOID`.
- Existing aggregate record may retain current `action` vocabulary for compatibility.

Hard rule: only deterministic policy plus normalized evidence may produce `PERMIT`. Missing evidence must never silently become support.

### 4.5 Verdict explanation

Every result must prioritize:

1. Final verdict.
2. Strongest decision-changing contradiction.
3. Exact action/value protected.
4. Evidence sources and freshness.
5. Reversal conditions.
6. Signature and audit details.

Do not lead with an aggregate score. Scores may be secondary; a contradiction with traceable evidence is the product.

### 4.6 Economics

Every paid call must record:

- customer settlement asset, amount, and transaction;
- external paid evidence cost;
- included-quota/public-source zero marginal cost with honest cost basis;
- realized gross margin when all legs use comparable assets;
- quote version and price at purchase time;
- idempotency mapping so retries do not double-charge.

The public verdict UI may summarize economics as:

> Review cost 0.20 USDT · protected value $5,000 · external evidence cost 0.00 USDT · gross margin 0.20 USDT

Never claim “loss prevented” as a fact. Use “value protected” or “value reviewed” unless a later independently adjudicated outcome proves avoided loss.

## 5. Backend implementation plan

### 5.1 Preserve the hardened core

Reuse rather than rewrite:

- `server/app.ts`: routing and x402 middleware integration.
- `server/reviewJob.ts`: job state and validation.
- `server/reviewJobStore.ts`: durable job persistence.
- `server/reviewJobWorker.ts`: evidence procurement loop.
- `server/x402ReviewProvider.ts`: paid provider safety.
- `server/procurementLedger.ts`: economic truth.
- `server/assuranceRecord.ts`: deterministic records.
- `server/serviceAttestation.ts`: service signatures.
- `server/postgresStore.ts`: shared production persistence.
- `src/domain/preActionGate.ts`: enforcement semantics.
- `src/sdk/crossExamClient.ts`: record verification and action gate.

Do not introduce a new database or job queue during the ten-day build unless PostgreSQL cannot meet a measured requirement.

### 5.2 New modules

Preferred file layout:

```text
server/
  actionIntake.ts                 # normalize simple and advanced inputs
  claimCompiler.ts                # deterministic material claims
  transactionPreflight.ts         # transaction service orchestration
  aspTrustCheck.ts                # ASP endpoint/payment checks
  evidence/
    types.ts
    normalize.ts
    okxLiquidity.ts               # wrap existing source cleanly
    goPlusTokenRisk.ts            # wrap existing source cleanly
    aspEndpointProbe.ts
    aspDiscovery.ts               # official adapter or explicit unavailable result
  policy/
    transactionPolicy.ts
    aspPurchasePolicy.ts
  publicRecord.ts                 # safe public/share representation
src/
  domain/
    assuranceAction.ts
    claimCompiler.ts              # shared deterministic primitives if browser-safe
  sdk/
    transactionPreflightClient.ts
    aspTrustClient.ts
    assuranceVerifier.ts
```

If functionality already exists under another module, extend it instead of duplicating logic merely to match this filename proposal.

### 5.3 API endpoints

Implement in this dependency order:

1. `POST /api/v1/assurance/verify` — free.
2. `POST /api/v1/preflight/transaction` — x402-paid.
3. `POST /api/v1/preflight/asp` — x402-paid.
4. `POST /api/v1/cross-examinations/prepare` — free claim/quote preparation.
5. `POST /api/v1/cross-examinations` — x402-paid deep review façade.
6. `GET /api/v1/public/records/:recordId` — optional safe share view; never expose bearer-protected private evidence.

Each paid route must have:

- the official OKX Payment SDK middleware;
- a standard version-2 `PAYMENT-REQUIRED` challenge;
- `exact` scheme;
- `eip155:196` network;
- official X Layer USDT0 asset;
- configured pay-to address;
- route-specific fixed price;
- GET only if the marketplace/audit requires it and a meaningful default input exists;
- fast fail-closed behavior for malformed or empty input;
- idempotency before paid work;
- no request body logging that could leak sensitive decisions.

### 5.4 Route-specific prices

Add server-only configuration:

```env
CROSSEXAM_TRANSACTION_PREFLIGHT_PRICE_USD=0.02
CROSSEXAM_ASP_TRUST_PRICE_USD=0.02
CROSSEXAM_DEEP_REVIEW_PRICE_USD=0.20
```

Requirements:

- Validate each as a positive decimal.
- Keep `CROSSEXAM_X402_PRICE_USD` for the legacy aggregate endpoint.
- Do not overload one variable for all services.
- Document every variable in `.env.example` and `docs/DEPLOYMENT.md`.
- Update Railway only after code is deployed and the user authorizes the configuration change.

### 5.5 Transaction evidence profile

Minimum real evidence for launch:

- OKX Onchain OS liquidity for applicable token trades.
- GoPlus X Layer token security for applicable token targets.
- Deterministic transaction binding and calldata/value inspection.
- Explicit `NOT_APPLICABLE` rather than fabricated results when a source does not apply.

Recommended additional evidence only after the minimum works:

- transaction simulation from an official/supported provider;
- allowance/approval risk decoding;
- holder concentration and liquidity ownership;
- destination contract/account metadata;
- current quote versus expected minimum output.

Do not add a provider merely because an API exists. It must have X Layer coverage, deterministic input binding, bounded output, reliable latency, and legally/operationally acceptable usage.

### 5.6 ASP trust profile

Implement passive endpoint analysis first:

- URL parser blocks non-HTTPS, credentials in URL, local/private network targets, and unusual ports unless explicitly allowlisted.
- Resolve and prevent SSRF/rebinding to loopback, link-local, RFC1918, and metadata addresses.
- Do not follow redirects automatically.
- Apply strict connect/read timeout and maximum response size.
- Request unpaid service once and inspect the 402 challenge.
- Decode `PAYMENT-REQUIRED` safely.
- Validate version, scheme, network, asset, amount, recipient, and timeout.
- Compare challenged price to caller expectation when provided.
- Hash the request and bounded response.
- Record latency and HTTP behavior.

Only after the passive path is safe should `PAID_CALL` reuse the existing procurement safety layer.

### 5.7 Public share record

The product needs a beautiful URL for demos and social sharing, but private decisions must remain protected.

Create a sanitized public projection containing only fields explicitly marked shareable:

- record ID;
- issued time;
- scenario;
- verdict;
- public action title;
- value reviewed if the user opted in;
- strongest contradiction;
- source names and observation times;
- attribution status;
- service signer/signature verification status;
- payment/economic summary without wallet deanonymization if not needed.

Default records remain private. Public sharing must be an explicit action with a revocable share token or stored share flag. Do not make existing bearer-protected records enumerable.

### 5.8 Service manifest

Update `server/serviceManifest.ts` only after endpoints exist and pass acceptance.

The manifest must distinguish:

- paid product services;
- free verification/discovery services;
- low-level legacy capabilities;
- private/administrative callbacks that should not be advertised as buyer products.

## 6. Frontend and product experience plan

### 6.1 Design objective

The homepage must communicate the product in three seconds and demonstrate value in under ninety seconds.

Desired feeling:

- consequential;
- intelligent;
- forensic;
- calm rather than alarmist;
- premium enterprise infrastructure rather than a crypto casino;
- memorable “cross-examination” identity without courtroom clichés.

Keep the strong dark visual direction, warm editorial typography, and red/green verdict contrast. Simplify structure aggressively.

### 6.2 Information architecture

Create these user-facing routes or route-equivalent views:

```text
/                         Product landing + live action composer
/check/transaction        Transaction preflight workspace
/check/agent              ASP trust workspace
/review/:jobId            Durable deep-review progress
/record/:recordId         Private authenticated verdict
/share/:shareToken        Sanitized shareable verdict
/developers               Integration/API/SDK overview
```

A full router library is optional. If introduced, keep bundle and complexity reasonable. Route behavior must survive direct refresh on Vercel via rewrites.

### 6.3 Homepage structure

The homepage should contain, in order:

1. Minimal navigation:
   - brand;
   - `How it works`;
   - `For developers`;
   - `Check an action` primary button;
   - recovery access moved into a menu/account utility, not hidden on mobile.
2. Hero:
   - headline: “Before an agent acts, make the decision survive.”
   - one short supporting sentence;
   - live action composer visible without opening a large modal;
   - scenario tabs: `Trade`, `Pay`, `Approve`, `Hire an Agent`, `Deploy`.
3. A compact five-step live flow visualization:
   - understand action;
   - extract claims;
   - buy evidence;
   - find contradiction;
   - permit or block.
4. One real verdict showcase loaded from a sanitized production record or an explicitly labeled historical live run.
5. Integration section showing the execution boundary in a few lines of code.
6. Trust footer with live API/worker/network status and links.

Remove procurement ledger, reviewer registry internals, and long result details from the first screen.

### 6.4 Action composer

Default experience:

- one large input: “What is your agent about to do?”
- scenario selector;
- value at risk;
- primary CTA: `Cross-examine`;
- advanced transaction fields collapsed.

For transaction mode, support:

- pasted transaction JSON;
- separate chain/to/data/value fields;
- token target when router calldata cannot identify it safely;
- natural-language intent.

Before payment, show a preparation step:

- normalized action;
- automatically extracted material claims;
- evidence sources that will be consulted;
- fixed price;
- expected time;
- exact scope of what CrossExam can and cannot conclude.

The user may edit the action/intent before paying. Once payment starts, freeze and hash the canonical input.

### 6.5 Live progress

After payment, do not leave the user staring at an unchanged button.

Display persisted stages driven by real backend state:

- `Payment confirmed`
- `Action bound`
- `Liquidity evidence received`
- `Contract risk evidence received`
- `Contradiction analysis complete`
- `Signed verdict issued`

Requirements:

- recover after refresh;
- show honest pending/failed/retry states;
- never use a fake timer;
- poll with bounded backoff or use an existing safe mechanism;
- provide recovery via payer-wallet proof;
- keep the access token out of URLs and analytics.

### 6.6 Verdict page

The verdict is the product’s visual climax.

Above the fold:

- large `PERMIT`, `HOLD`, or `BLOCK` stamp;
- action title and exact bound target;
- value reviewed;
- review price;
- strongest contradiction in one sentence;
- `Execution blocked` or `Eligible to execute` status;
- `Attempt guarded execution` only when a safe connected-wallet flow exists.

Second layer:

- material claims with verdict and evidence source;
- reversal conditions;
- source freshness;
- what changed the decision.

Collapsed audit layer:

- request/response hashes;
- source owners;
- payment settlements;
- attribution tier;
- service signature;
- record ID;
- gross-margin ledger.

Actions:

- copy record ID;
- download JSON;
- verify signature;
- create sanitized share link;
- start another review.

### 6.7 Developer page

Show the simplest integration first:

```ts
const verdict = await crossExam.preflightTransaction(tx, {
  intent: 'Buy TOKEN with 5,000 USDT',
  valueAtRiskUsd: 5000,
})

if (!verdict.canExecute) throw new Error(verdict.strongestContradiction)
await wallet.sendTransaction(tx)
```

Then document:

- endpoint and schemas;
- x402 payment behavior;
- trusted signer pinning;
- idempotency;
- action binding;
- record verification;
- retry/recovery;
- privacy boundary.

Do not make developers read the full internal review-job protocol to achieve the first integration.

### 6.8 Copy rules

Use:

- “evidence” only for traceable observations;
- “signed verdict” only when the service signature exists;
- “network verified” only when current attribution rules pass;
- “value reviewed” or “value protected,” not “money saved”;
- “independent source” only when source ownership/routing is actually distinct;
- “live” only for production calls.

Avoid:

- vague “AI-powered” copy;
- claiming universal safety;
- unexplained protocol jargon above the fold;
- long paragraphs;
- invented reviewers or sample economics mixed into live screens;
- “audit” when the service performs a narrower preflight.

### 6.9 Responsive and accessibility requirements

Before UI completion:

- no horizontal overflow at 320, 375, 390, 768, 1024, and 1440 CSS pixels;
- primary CTA visible without accidental overlap;
- recovery available on mobile;
- modal/dialog surfaces use `role="dialog"`, `aria-modal`, labeled headings, focus containment, Escape close, and focus restoration;
- minimum body text 14px on mobile; metadata may be smaller but must remain legible;
- keyboard operation for all buttons, tabs, details, and forms;
- visible focus rings;
- color is not the only verdict signal;
- respect `prefers-reduced-motion`;
- loading states announce status with restrained `aria-live`;
- error messages identify the failed stage and recovery action.

### 6.10 Asset cleanup

After the new UI is stable:

- remove unused Vite/React SVG assets;
- remove `.DS_Store` from tracked assets if tracked and add ignore coverage;
- retire unused old favicon files;
- ensure `logo.jpg`/final logo dimensions work for favicon, social card, and marketplace avatar;
- create a deliberate Open Graph image rather than stretching the avatar if time permits;
- verify page title, description, canonical URL, and social metadata.

## 7. SDK plan

### 7.1 Public API surface

Add ergonomic methods without removing existing ones:

```ts
crossExam.prepareAction(input)
crossExam.preflightTransaction(transaction, context)
crossExam.checkAsp(input)
crossExam.startDeepReview(input)
crossExam.getReview(jobAccess)
crossExam.verifyRecord(record, action, policy)
crossExam.executeVerifiedEvmAction(...)
```

### 7.2 SDK rules

- Browser SDK never accepts a private key.
- Payment is delegated to an injected x402-capable fetcher/wallet.
- Every mutation accepts an idempotency key or generates one and returns it to the caller.
- Types come from one shared contract; avoid browser/server drift.
- Errors expose machine codes plus safe human messages.
- A timeout after payment must be recoverable without another payment.
- The default verifier pins an expected signer from configuration, not from the untrusted record itself.
- No silent execution; the exact verified payload must be passed to the execution callback.

## 8. Data, privacy, and security plan

### 8.1 Data classification

Classify fields:

- Public: service manifest, source names, signer address, public share records.
- Capability-protected: private decision records, evidence details, job state, ledgers.
- Secret: wallet private keys, API secrets, bearer access tokens, database URL.
- Sensitive input: unpublished transactions, deployment bytecode, vendor/payment details, user intent.

### 8.2 Logging

- Never log private keys, API secrets, payment signatures, bearer tokens, full unpublished calldata, or full decision bodies.
- Log request ID, route, status, latency, safe job/record ID, and error code.
- Redact external provider responses by default.
- Keep worker heartbeat low-volume.
- Add structured errors sufficient to diagnose timeout/settlement/provider failures.

### 8.3 SSRF and provider safety

Any caller-supplied endpoint probing is a new high-risk surface. Mandatory controls:

- HTTPS only;
- DNS/IP validation before connecting;
- block loopback, private, link-local, multicast, and metadata destinations;
- reject embedded credentials;
- reject redirects or revalidate every redirect target;
- fixed method allowlist;
- tight timeout;
- bounded response bytes;
- safe content-type handling;
- no arbitrary headers from callers;
- no procurement payment without recipient/asset/network/amount policy.

### 8.4 Production secrets

- Keep all secrets only in Railway/Vercel-local environment stores as appropriate.
- Never put server keys in `VITE_*` variables.
- Never commit `.env.local`.
- Keep procurement, receiving, and service-signing wallets separate.
- Do not expose private keys in logs, screenshots, issues, commits, or chat.
- When adding an LLM/search provider, use a separate server-only key and spending cap.

## 9. Test and acceptance strategy

The user does not want excessive time spent on low-value testing. Focus on critical economic, security, and demo paths.

### 9.1 Required automated tests

Add focused tests for:

- canonical action hashing and mismatch rejection;
- deterministic claim compilation;
- evidence normalization and source/action binding;
- verdict fail-closed behavior;
- route-specific 402 challenges and prices;
- idempotent paid replay;
- ASP endpoint URL/SSRF rejection;
- x402 challenge decoding and mismatch detection;
- record verification and signer pinning;
- public record redaction;
- frontend reducer/state transitions for paid progress and recovery.

Do not chase arbitrary coverage percentage. Every critical branch above must have at least one positive and one negative test.

### 9.2 Required local acceptance

- `npm run lint`
- `npm test -- --run`
- `npm run build`
- no unexpected tracked changes;
- no secret patterns in tracked files;
- production bundle loads without fatal console error;
- no broken public links.

### 9.3 Required production black-box acceptance

For every paid service endpoint:

1. Unpaid request returns HTTP 402.
2. `PAYMENT-REQUIRED` exists and decodes as x402 v2.
3. Network is `eip155:196`.
4. Scheme is `exact`.
5. Asset is official X Layer USDT0.
6. Amount equals the registered marketplace fee.
7. Pay-to is the configured receiving address.
8. Payment timeout is acceptable.
9. A real paid request returns HTTP 200 within the marketplace timeout.
10. The paid result is useful for empty/default audit input and full real input.
11. A retry with the same idempotency key does not charge again.
12. A reused idempotency key with changed input is rejected.

For the demo path:

1. Wallet payment visibly completes.
2. Customer settlement is recorded.
3. Real evidence arrives.
4. Result is signed and persisted.
5. Refresh/recovery returns the same job/result.
6. Exact guarded action is blocked or permitted according to the result.
7. The UI reflects each state without manual database edits.

Any real paid test is an onchain spend and must be explicitly confirmed by the user at execution time, even if prior turns gave broad testing permission.

### 9.4 Required UI acceptance

- Desktop and mobile visual inspection of all primary states:
  - landing;
  - prepared quote;
  - wallet/payment request;
  - pending evidence;
  - BLOCK verdict;
  - HOLD verdict;
  - PERMIT verdict if a real safe input exists;
  - failure/retry;
  - access recovery;
  - public share record;
  - developer page.
- Verify copy never labels sample content as live.
- Verify mobile recovery path exists.
- Verify keyboard and dialog behavior.
- Verify long addresses/hashes cannot overflow.

## 10. Deployment and migration strategy

### 10.1 Do not destabilize the reviewed endpoint

The current ASP submission is under review. Until its status changes:

- do not rename or remove the registered service;
- do not change its endpoint;
- do not change its price;
- do not remove GET compatibility;
- do not deploy an incompatible schema;
- additive backend endpoints and frontend work may be built locally and on preview deployments.

### 10.2 Safe production release sequence

1. Merge additive backend modules and tests.
2. Deploy to Railway without changing existing endpoint behavior.
3. Verify `/health`, `/ready`, discovery, legacy GET/POST 402, and legacy paid replay.
4. Test new endpoints unpaid.
5. With explicit user approval, perform one paid transaction preflight.
6. Deploy the new frontend to a Vercel preview URL.
7. Complete desktop/mobile/product acceptance on preview.
8. Promote frontend to `www.cross-exam.xyz`.
9. Run production end-to-end demo path.
10. Only when endpoints are stable, prepare an ASP service-list update card.
11. Show current versus proposed services, descriptions, prices, and endpoints to the user.
12. Wait for explicit confirmation before any identity/service update.
13. Submit/re-submit early enough for review before the competition deadline.

### 10.3 Railway services

Preserve:

- API service with public domain;
- procurement worker without public domain;
- shared PostgreSQL database;
- least-privilege environment variables per service.

Do not copy the service signing key into the worker. Do not expose the procurement key to the frontend.

### 10.4 Rollback

Before production promotion:

- identify the last known-good Git commit;
- retain previous Railway/Vercel deployment for instant platform rollback;
- use additive schema migrations;
- do not delete old columns/tables/routes during the competition window;
- if a new service fails, disable only its route/manifest entry, not the legacy paid endpoint.

## 11. ASP listing strategy

### 11.1 Proposed final service list

After all endpoints pass production acceptance, propose these marketplace services:

1. `Transaction Preflight` — API service — 0.02 USDT — `/api/v1/preflight/transaction`
2. `Agent Trust Check` — API service — 0.02 USDT — `/api/v1/preflight/asp`
3. `Decision Cross-Examination` — API service — 0.20 USDT — `/api/v1/cross-examinations`
4. `Verify Assurance Record` — API service — 0 USDT — `/api/v1/assurance/verify`
5. Optional `Deep Adversarial Investigation` — agent-to-agent — negotiated/fixed starting fee only after communication testing.

Whether the existing `Decision Assurance API` remains separately listed or is replaced must be decided only after checking how OKX.AI handles service updates and re-review. Backward-compatible API support remains regardless of marketplace display.

### 11.2 Listing descriptions

Each description must have exactly two concise parts:

1. What the service does and the result returned.
2. What the caller must provide.

Do not mention implementation stack, example prompts, disclaimers, or unverified claims in listing descriptions. Do not update the listing until the final exact descriptions are reviewed by the user.

### 11.3 Revenue and reviews

After approval:

- perform legitimate end-to-end purchases from the test client identity;
- never manufacture sales or reviews;
- ask real testers to call the service and leave honest feedback;
- keep low-price services frictionless;
- expose a shareable result that motivates organic posts;
- monitor errors and latency so paid calls reliably return results.

## 12. Demo and submission plan

### 12.1 Final 90-second video

Target 70–85 seconds to leave margin.

Storyboard:

- `0–7s`: “Agents can spend and trade autonomously. Who is paid to stop the wrong decision?”
- `7–15s`: Show the proposed $5,000 trade and exact transaction.
- `15–23s`: Click Cross-examine; show extracted claims and 0.20/0.02 USDT quote.
- `23–32s`: Approve the real x402 payment in the wallet.
- `32–47s`: Show real evidence stages: OKX liquidity and independent token/contract evidence.
- `47–60s`: Reveal the decision-changing contradiction and signed `BLOCK` verdict.
- `60–69s`: Attempt the exact transaction; execution guard refuses it.
- `69–77s`: Show evidence/payment/signature audit and value reviewed.
- `77–85s`: Show services: transaction, ASP trust, deep review, verification; close with the category vision.

No terminal scrolling, long forms, fake progress animation, or unexplained JSON should dominate the video.

### 12.2 Demo reliability

- Use a carefully selected real X Layer target whose evidence response is stable enough for the intended verdict.
- Prefill the action to avoid typing errors.
- Ensure the demo wallet has sufficient USDT0 before recording.
- Ensure Railway worker is healthy.
- Warm the deployment without precomputing/faking the paid result.
- Record at readable browser zoom and resolution.
- Hide wallet balances, email, API keys, private addresses not intended for publication, and unrelated browser tabs.
- Prepare a fallback recording only after the live path has already been proven; do not substitute an illustrative UI for a live claim.

### 12.3 Submission assets

- Production URL.
- GitHub URL with correct homepage metadata.
- Approved/live ASP link or ID.
- X post using `#OKXAI`.
- Video under 90 seconds.
- One-sentence value proposition.
- Three concise differentiators.
- Architecture diagram showing customer x402 payment, evidence procurement, signed verdict, and execution gate.
- Real transaction/payment references safe to publish.
- Honest statement of current production sources and supported scenarios.

## 13. Ten-day execution order

The order matters. Do not spend early days polishing secondary pages while the primary paid result is weak.

### Day 1 — freeze contracts and simplify product model

- [x] Define `AssuranceAction`, normalized evidence, and shared verdict types.
- [x] Write request/response contracts for Transaction Preflight, Agent Trust Check, Deep Cross-Examination, and Verify Record.
- [x] Map existing job/record types to the new façade without duplication.
- [x] Confirm the exact primary demo transaction shape and required evidence.
- [x] Add this plan to README navigation.

Acceptance: contracts compile, legacy contracts are unchanged, and the primary flow can be described as one request-to-verdict sequence.

Evidence (2026-07-18): `src/domain/assuranceAction.ts` reuses `canonicalizeEvmTransaction` and `createEvmActionBinding`; `src/domain/assuranceContracts.ts` defines the additive endpoint contracts; `docs/PRODUCT_CONTRACTS.md` maps them to existing durable jobs, records, evidence and the execution gate; focused mapping tests pass. The live demo asset remains intentionally unset until production evidence acceptance, but its exact transaction shape and required sources are fixed.

### Day 2 — transaction claim compiler and policy

- [x] Implement deterministic transaction claim compilation.
- [x] Decode/inspect transaction value, recipient, approval patterns where supported.
- [x] Implement transaction evidence-to-claim mapping.
- [x] Implement fail-closed transaction policy.
- [x] Add focused positive/negative tests.

Acceptance: a real-shaped transaction deterministically yields material claims and cannot receive `PERMIT` with missing required evidence.

Evidence (2026-07-18): `src/domain/transactionClaims.ts` derives explicit claims from canonical EVM actions and recognizes a bounded subset of ERC-20/operator approval calldata; `src/domain/transactionEvidence.ts` maps only named, normalized provider facts; `src/domain/transactionPolicy.ts` blocks one material contradiction and holds on missing evidence or insufficient attribution. Focused positive/negative tests cover liquidity contradiction, missing evidence, unlimited approval, and high-value attribution gating.

### Day 3 — paid Transaction Preflight endpoint

- [x] Implement transaction orchestration façade over existing evidence/job/record code.
- [x] Add route-specific x402 price and middleware.
- [x] Add idempotency and persistence.
- [x] Return signed action-bound record.
- [x] Update manifest/discovery after tests pass.
- [x] Run local and preview unpaid 402 acceptance.

Acceptance: unpaid 402 is standard; a locally authorized test path yields a useful signed verdict; legacy aggregate remains green.

Evidence (2026-07-18): `server/transactionPreflight.ts` reuses the bounded provider, evidence-delivery, record, attestation, and idempotency primitives without relabeling API results as reviewer signatures. The production endpoint returned standard x402 v2 challenge data for X Layer USD₮0 at `0.02`; a real customer authorization created persisted signed record `dar_f93fb424e39721fa5fc2e6d2` with a fail-closed `HOLD`, explicit source failures for an intentionally unrecognized bound token, and a time-limited record capability. This is a real negative-path result, not fabricated evidence. Production legacy aggregate continued to return standard 402. Local lint, 35 test files / 141 tests, and build passed before deployment.

### Day 4 — ASP Trust Check

- [x] Research supported OKX agent/service discovery access.
- [x] Implement secure endpoint probe with SSRF protections.
- [x] Parse and validate standard 402 challenges.
- [x] Compare expected and actual price/network/recipient.
- [x] Implement passive `BUY/CAUTION/AVOID` mapping.
- [x] Keep paid active-call mode disabled until a target-recipient binding and dedicated spend policy are configured.

Acceptance: the service detects at least one real coherent endpoint and multiple controlled mismatch cases without connecting to forbidden network destinations.

Evidence (2026-07-18): Official OKX.AI discovery is exposed through the authenticated Onchain OS identity CLI; no documented server-to-server public listing API was used for this passive product path, so agent metadata is intentionally not scraped or asserted. `server/aspEndpointProbe.ts` accepts only HTTPS GET probes, rejects credential URLs/unusual ports/private or rebinding-prone destinations, pins the resolved public IP for TLS, forbids redirects, and bounds latency/response size. Controlled tests cover coherent challenge, recipient mismatch, redirect, POST refusal, and forbidden private address. Production `POST /api/v1/preflight/asp` returned a standard challenge and then a real signed/persisted `BUY` record `dar_3718b311d9355b66ce37d929` for CrossExam's own public unpaid endpoint; its immutable observation includes availability and payment-contract facts. The target endpoint was not purchased. Production discovery now lists the new paid service.

### Day 5 — Deep Cross-Examination façade

- [x] Add simple intent intake and deterministic claim preparation.
- [x] Add free prepare/quote endpoint.
- [x] Connect paid deep-review endpoint to durable jobs, funding, procurement, result, recovery, and ledger.
- [x] Reduce launch price from the existing 2 USDT floor only after confirming external cost/margin constraints.
- [x] Make incomplete/general evidence return honest HOLD, never a fabricated conclusion.

Acceptance: the website can start a deep review without requiring the user to manually construct the internal dispatch schema.

Evidence (2026-07-18): `server/crossExamination.ts` accepts either simple intent/action input or an action-bound advanced package, deterministically compiles transaction and generic material claims, matches only server-owned provider capabilities, and returns a free prepare/quote response. `POST /api/v1/cross-examinations` creates only fulfillable durable jobs and returns the existing x402 authorization capability; the existing authorization, procurement, recovery, ledger and result routes remain the sole economic lifecycle, so job creation cannot spend a wallet. The new `CROSSEXAM_DEEP_REVIEW_PRICE_USD` defaults to `0.20`; the current X Layer matched plan has a `0.005` USDT estimated external cost, which leaves a 97.5% estimated margin above the configured 40% minimum. Unmatched GENERAL work returns `canStart: false` and cannot be purchased. `src/App.tsx` now uses the simple façade, shows generated claims/sources/limitations/quote before authorization, and invalidates a quote when input changes. Focused façade and SDK tests pass; desktop and 375px local visual inspection showed the flow without horizontal overflow. This is local/additive only: production configuration and deployment remain deliberately unchanged.

### Day 6 — new homepage and composer

- [x] Implement simplified homepage information architecture.
- [x] Put the action composer directly in the hero.
- [x] Add scenario tabs and collapsed advanced fields.
- [x] Add prepare/quote view before payment.
- [x] Remove architecture-heavy internals from above the fold.
- [x] Preserve recovery access on mobile.

Acceptance: a new user can state what CrossExam does and start the correct scenario within ten seconds.

Evidence (2026-07-18): The direct first-screen composer in `src/App.tsx` presents Trade, Pay, Approve, Hire agent and Deploy scenarios, a natural-language intent field, value-at-risk, and an expandable exact X Layer transaction section. It delegates all claim/source/quote generation to the free server façade before it renders a payment continuation; opaque dispatch schema, reviewer registry detail and economics remain below the primary action. Input changes invalidate the prior preparation. The desktop and 375px viewport were inspected locally; the mobile path has no horizontal page overflow and exposes `Recover paid review` below the composer. Lint, all 150 focused tests, and production build passed.

### Day 7 — live progress and verdict experience

- [ ] Implement persisted live stage UI.
- [ ] Implement verdict-first result page.
- [ ] Add strongest contradiction, reversal conditions, source freshness, and execution gate.
- [ ] Add private JSON download and safe share flow.
- [ ] Add error/retry/recovery states.

Acceptance: refresh during a paid job recovers state, and the final page clearly shows why execution is blocked or permitted.

### Day 8 — SDK, developer page, and production hardening

- [ ] Add ergonomic SDK methods.
- [ ] Add Verify Assurance Record endpoint and UI.
- [ ] Build developer page.
- [ ] Complete accessibility/mobile pass.
- [ ] Complete secret/logging/SSRF review.
- [ ] Clean unused assets and metadata.

Acceptance: a developer can understand integration from one code example; verification rejects changed actions and untrusted signers.

### Day 9 — production economics and end-to-end acceptance

- [ ] Deploy additive backend safely.
- [ ] Deploy frontend preview, then production after acceptance.
- [ ] Run unpaid black-box acceptance for every endpoint.
- [ ] With explicit user confirmation, run the minimum real paid tests.
- [ ] Confirm customer income, evidence, record, recovery, gate, and gross margin.
- [ ] Fix only demonstrated failures; avoid unnecessary refactors.

Acceptance: the canonical demo works from a clean browser and fresh job without manual intervention.

### Day 10 — listing, demo, submission, and buffer

- [ ] Prepare exact ASP service update card.
- [ ] Obtain user confirmation and submit service updates if strategically safe.
- [ ] Confirm listing status and endpoint audit.
- [ ] Record final 70–85 second video.
- [ ] Publish X post with `#OKXAI`.
- [ ] Complete submission form before deadline.
- [ ] Preserve several hours for review feedback or rollback.

Acceptance: approved/live ASP, valid submission, public demo, production URL, and reproducible paid flow.

## 14. Priorities if time slips

### P0 — must ship

- Legacy ASP endpoint remains compliant and responsive.
- Transaction Preflight produces a real useful paid result.
- Real evidence, signed record, and action gate work.
- Homepage/composer/verdict flow is polished and understandable.
- Production payment/recovery works.
- ASP is approved/live and submission requirements are complete.

### P1 — should ship

- Agent Trust Check passive endpoint.
- Verify Assurance Record free endpoint.
- Shareable sanitized verdict.
- Developer integration page.
- Multiple marketplace service entries.

### P2 — ship only if P0/P1 are stable

- Paid active-call ASP probing.
- Negotiated deep investigation service.
- General-purpose LLM claim extraction.
- Additional evidence providers.
- Advanced public analytics/reputation screens.

If time slips, cut P2 entirely. Do not weaken the primary live transaction story to preserve breadth.

## 15. Known risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Current ASP still under review | Listing changes may reset/reopen review | Keep existing endpoint stable; build additively; submit service updates only after production acceptance and user confirmation |
| Multiple services confuse users | Product looks like unrelated tools | Use one shared promise and three outcome-based entry points |
| Generic input only returns HOLD | Paid call feels useless | Build automatic deterministic claim compilation and scenario-specific evidence routing |
| External provider latency/failure | Paid request times out | Durable job flow, async progress, retry, strict timeouts, fast standard endpoint behavior |
| Evidence does not apply | False certainty | Explicit `NOT_APPLICABLE`/`UNRESOLVED`; fail closed |
| ASP endpoint probe enables SSRF | Severe backend security issue | Mandatory DNS/IP/redirect/timeout/size controls before launch |
| Marketplace discovery API unavailable | Agent metadata cannot be verified | Ship endpoint-first trust check and label unavailable dimensions; do not scrape private APIs |
| LLM hallucination | False claims/verdicts | LLM only structures candidate claims; evidence/policy controls verdict |
| Demo result is nondeterministic | Recording failure | Choose a stable real target, prefill input, verify providers/worker/wallet immediately before recording |
| Price exceeds willingness to test | Low revenue/orders | 0.02 entry services, 0.20 deep review, free verification |
| Frontend exposes internals | Weak product experience | Verdict-first hierarchy; audit details collapsed |
| Secret leakage | Loss of funds/credentials | server-only keys, ignore checks, redacted logs, no screenshots of secrets |

## 16. Explicit non-goals for this competition window

- Building a new blockchain or token.
- Creating a DAO/governance system.
- Supporting every EVM chain.
- Claiming comprehensive smart-contract audit coverage.
- Fully autonomous general web research without reliable providers.
- Building enterprise RBAC, billing dashboards, or organization administration.
- Replacing OKX Wallet execution.
- Creating a new reviewer-token incentive system.
- Rewriting the existing persistence/payment core.
- Artificially inflating marketplace orders, revenue, or reviews.

## 17. Definition of done

The final product is complete for submission only when all of the following are true:

### Product

- [ ] A first-time visitor understands the product in three seconds.
- [ ] The primary CTA starts a real action review without requiring internal schema knowledge.
- [ ] The canonical transaction demo uses real payment and evidence.
- [ ] The final verdict is signed and action-bound.
- [ ] The exact guarded transaction is blocked or permitted by the returned record.
- [ ] The UI explains the strongest contradiction and reversal condition.

### Economics

- [ ] At least one customer x402 settlement is recorded for the final service.
- [ ] External evidence cost basis is honest.
- [ ] Revenue and realized margin are visible in the protected ledger.
- [ ] Retry/recovery does not double-charge.

### Engineering

- [ ] Lint, tests, and build pass.
- [ ] No tracked secrets.
- [ ] No production dependency vulnerability at high/critical severity.
- [ ] API and worker health are green.
- [ ] Every listed paid endpoint passes standard 402 and paid replay acceptance.
- [ ] Existing registered aggregate endpoint remains compatible.
- [ ] Mobile and desktop primary flows pass visual inspection.

### Marketplace/submission

- [ ] ASP is approved and live.
- [ ] Listed service names, prices, descriptions, and endpoints match production.
- [ ] X participation post includes `#OKXAI` and a clear demo under 90 seconds.
- [ ] Submission form is completed before 2026-07-27 23:59 UTC.
- [ ] GitHub homepage and production links are correct.

## 18. Stop conditions — ask the user instead of guessing

The implementation agent must stop and request user action when:

- an onchain payment or wallet signature is required;
- an ASP identity/service write or listing update is ready;
- Railway or Vercel production environment variables must change;
- a new paid provider/API account or credential is required;
- an LLM/search provider key is required;
- a pricing change would affect marketplace registration or production buyers;
- a DNS/domain change is required;
- a destructive database migration is proposed;
- real provider terms/coverage are ambiguous;
- the canonical demo target requires the user to accept financial or legal risk.

For ordinary local implementation, tests, additive code changes, preview deployment inspection, and read-only production checks, continue without asking unnecessary questions.

## 19. Required user-provided items — only when the relevant phase begins

Do not request all of these immediately. Ask only when needed:

- explicit confirmation for each real x402 spend;
- confirmation of final service prices;
- confirmation of ASP service-list update;
- optional LLM provider/API key if natural-language extraction is enabled;
- optional official discovery credentials if OKX requires them for server-side ASP lookup;
- sufficient X Layer USDT0 in the test customer wallet and procurement wallet;
- final X account/post access handled by the user unless explicitly delegated through an available authorized connector;
- final submission form answers/approval before external submission.

## 20. First instruction for the next implementation model

Use this exact starting directive:

> Open `/Users/zhangchi/Desktop/OKXAIGenesis/CrossExam/BUILD_PLAN.md` and follow section 0 before making changes. Continue from the first unchecked task in section 13. Preserve all existing production behavior and do not use mocks as live output. Work autonomously through local implementation and verification, but stop before any real payment, ASP identity/service update, production secret/configuration change, or external submission that requires my confirmation. Update BUILD_PLAN.md checkboxes only after each acceptance criterion passes, commit coherent batches, and report only meaningful blockers or completed milestones.
