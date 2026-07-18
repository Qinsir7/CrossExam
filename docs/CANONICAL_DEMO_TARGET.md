# Canonical demo target — provisional Xwawa liquidity screen

Status: **candidate only; not a precomputed verdict, a fixture, or a payment
authorization.** The live CrossExam provider responses remain authoritative.

## Candidate

- Asset: `Xwawa` on X Layer
- Token: `0x095c1a875b985be6e2c86b2cae0b66a3df702e6a`
- Reference pool: `0xb84bd1f49b41bdf4f7518385e00c55ef2fdb2e70`
  (`Xwawa/WOKB`, DYORSwap)
- Pair factory observed via X Layer RPC:
  `0x2ccadb1e437aa9cdc741574bda154686b1f04c09`
- Intended review size: **10,000 USD**

## Why this is a useful honest scenario

On 2026-07-18, read-only checks established that the named pool is a live X
Layer pair: `token0()` returned the Xwawa token above and `token1()` returned
WOKB. GeckoTerminal reported about 42,275 USD pool liquidity at the time of
inspection. That observed amount is below ten times a 10,000 USD proposed
trade, so CrossExam's documented liquidity policy makes a live `BLOCK` likely
*if* the configured OKX Market provider returns comparably bounded aggregate
liquidity. This is a size/depth demonstration, not an allegation that Xwawa is
fraudulent.

The same direct GoPlus X Layer lookup returned the token symbol, open source,
non-proxy, and no reported honeypot/blacklist flags. Some required adapter
fields were absent, including taxes and sell-all status. CrossExam must keep
the transfer-safety premise unresolved unless its live normalized response is
complete; no UI or test may call that absence a clean security result.

## Required before calling it the canonical live demo

1. Build a real, non-broadcast exact swap transaction through a confirmed live
   X Layer router. Do not label a placeholder recipient, empty calldata, or a
   pool contract call as a tradable swap.
2. Check the exact route and source coverage read-only immediately before the
   final run. The official OKX Market response, not this note or a third-party
   market page, determines the liquidity finding.
3. Prepare a fresh browser job and verify that the preview shows the exact
   bound action, claims, two sources, and 0.20 USDT authorization before asking
   the owner for permission to pay.
4. After explicit approval, make exactly one live payment. Record only a
   sanitized result note; do not persist access capabilities, payer data, raw
   provider headers, or settlement credentials.

If the live OKX response does not contradict liquidity, retain the honest
`HOLD` or choose another candidate after new read-only checks. Never tune the
policy or hardcode a result to force the recording.
