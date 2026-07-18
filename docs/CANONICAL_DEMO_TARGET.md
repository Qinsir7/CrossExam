# Canonical demo target — WOKB exact-route assurance

Status: **selected read-only candidate; not a precomputed verdict, fixture, or
payment authorization.** Live CrossExam provider responses remain authoritative.

## Candidate

- Proposed trade: exact-in **10,000 USDT0 → WOKB** on X Layer
- Input token: `0x779ded0c9e1022225f8e0630b35a9b54be713736` (USDT0)
- Review target: `0xe538905cf8410324e03a5a23c1c177a474d59b2b` (WOKB)
- Chain: X Layer (`196`)
- Slippage requested from the quote API: **0.5%**

## Why this is the selected honest scenario

On 2026-07-18, CrossExam's deployed read-only route constructor successfully
obtained an official OKX DEX exact-in route for the proposed 10,000 USDT0
trade. The returned route used the official X Layer router and identified
multiple venues, including Uniswap V3/V4, PotatoSwap, CurveNG, Revoswap V2 and
OkieSwap V3. No approval, signature, x402 payment, or transaction broadcast
occurred; the test used a dummy recipient and raw calldata is deliberately not
stored here.

The same-day public GoPlus X Layer response identified WOKB as open-source and
non-proxy and did not report honeypot, buy-disable, blacklist, or creator-link
flags. It nevertheless omitted fields that CrossExam's documented
transfer-safety policy requires, including transfer tax and sell-all status.
That means a live review must keep the transfer-safety premise **unresolved**.
The expected result is therefore a useful, truthful `HOLD`: an apparently good
multi-venue quote is not enough to clear an autonomous 10,000 USD action while
material evidence is incomplete. This is not an allegation that WOKB is unsafe.

The authoritative authenticated OKX Market response at review time determines
the liquidity finding. The GoPlus output and route observation only establish
why a fail-closed result is likely and why the proposed exact action is
constructible.

## Rejected prior candidate

Xwawa (`0x095c1a875b985be6e2c86b2cae0b66a3df702e6a`) remains a useful
read-only liquidity-screen research target, but it is not the canonical
exact-transaction demo. The deployed official OKX DEX quote route returned no
successful route for the proposed 10,000 USDT0 purchase. Do not pretend its
DYORSwap pool address is a tradable router transaction or use a placeholder
calldata to force it into the demo.

## Required before calling it the canonical live demo

1. In a clean browser, connect the intended X Layer wallet and request a fresh
   exact route. The returned recipient/calldata must be visible in the prepared
   action; it must never be copied from this document or a prior quote.
2. Verify the preview shows the exact bound action, two sources, and 0.20 USDT
   authorization before asking the owner for permission to pay.
3. After explicit approval, make exactly one live payment. Record only a
   sanitized result note; do not persist access capabilities, payer data, raw
   provider headers, raw calldata, or settlement credentials.
4. If live GoPlus returns complete support fields or OKX Market reports a
   material liquidity contradiction, describe that actual evidence rather than
   predetermining `HOLD`.
