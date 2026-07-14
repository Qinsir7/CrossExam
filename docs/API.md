# CrossExam A2MCP API Contract

Version: `0.1`

## Paid capability

`POST /api/v1/assurance/aggregate`

Produces a Decision Assurance Record from a Decision Package and a fully delivered, independently attributed review dispatch. This is a deterministic aggregation service; it does not generate reviewer findings, invent evidence, or complete missing review scopes.

`POST /api/v1/assurance/network-aggregate` accepts the same payload, but requires every delivered review to include an EIP-191 wallet attestation. Each reviewer ID must be bound to a different signing wallet in CrossExam's server-side registry. This endpoint returns `attributionStatus: "NETWORK_VERIFIED"` only after those signatures verify.

## x402 payment

The endpoint is protected by the OKX x402 Express SDK.

1. An unpaid request receives `402 Payment Required` and a `PAYMENT-REQUIRED` header.
2. The buyer selects the X Layer `eip155:196` `exact` option, signs the payment payload, and retries with the payment header.
3. After settlement verification, CrossExam processes the same request and returns the assurance record.

The seller configures the receiving address and price server-side. No credential, key, or signing capability is exposed to the browser.

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
              "excerpt": "Traceable supporting or contradicting evidence."
            }
          ],
          "findings": [
            {
              "claimId": "C-1",
              "reviewerId": "reviewer-source",
              "verdict": "SUPPORTS",
              "confidence": 0.8,
              "materiality": 0.9,
              "evidence": "The evidence explains why this claim is supported."
            }
          ]
        },
        "reason": "Delivered with attributable findings."
      }
    ]
  }
}
```

Every procurement scope must be `DELIVERED`. Each delivery must originate from the reviewer assigned to that scope, provide at least one traceable artifact, and explicitly address every claim in the scope.

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

Every `REFUTED` or `UNRESOLVED` claim generates a reversal condition. It specifies the class of independently verifiable evidence needed before an action can be reconsidered; it does not fabricate a favorable resolution.

After a successful paid aggregation, the record is atomically persisted before the API responds. The response includes `persistence: "CREATED"` or `"EXISTING"`; a persistence failure returns `500` rather than presenting an unrecorded result as an audit artifact.

The response also includes a time-limited `readAccess` bearer token. Retrieve a persisted record with `GET /api/v1/assurance/records/{recordId}` and `Authorization: Bearer {token}`. The server stores only a SHA-256 token hash and returns `404` for absent, invalid, expired, or unauthorized requests to avoid disclosing record existence.

## Truth and attribution boundary

In `0.1`, an API caller may submit its own reviewer information. CrossExam records that as `DECLARED_BY_CALLER`; it does not claim that the reviewer identity has been independently verified by CrossExam. A later network-verified mode will require registry identity proofs and reviewer-signed deliveries.

The network-verified endpoint is the first implementation of that mode: the signed payload binds the delivery to its dispatch ID, decision ID, scope ID, reviewer ID, artifacts, and findings. A changed artifact, replay into another scope, unregistered reviewer, invalid signature, or repeated wallet across scopes is rejected.

## Reviewer reliability boundary

CrossExam does not assign reputation from reviewer agreement or raw task volume. A reviewer becomes `ESTABLISHED` only after at least five independently adjudicated claim outcomes. The resulting signal weights material accuracy, evidence completeness, and timeliness; material misconduct is penalized. Prior to that threshold, the profile remains `PROVISIONAL` and has no ranking score.

## Pre-action gate

Agent executors should evaluate the returned record before spending, trading, deploying, or publishing. The CrossExam SDK domain hook returns one of `PERMIT`, `REMEDIATE`, `REQUIRE_NETWORK_VERIFICATION`, or `DENY`. It rejects action intents that do not match the reviewed decision or exceed its reviewed value-at-risk, requires network-verified delivery at policy-defined high-value thresholds, and surfaces the claim IDs that must be remediated.

## Errors

| Status | Meaning |
| --- | --- |
| `402` | No valid x402 payment payload. |
| `422` | Invalid input, a partial dispatch, mismatched reviewer, missing evidence artifact, or a delivery that omits a claim. |
| `503` | Local-only mode with facilitator synchronization intentionally disabled; paid business logic is unavailable. |
