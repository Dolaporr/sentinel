# Sentinel

**A spend governor for autonomous agents calling LLM gateways.**

A gateway key draws straight from an account balance with no credit limit of
its own — that's true of Orbio and of OpenRouter alike. Sentinel puts an
admission check in front of every call so an agent is stopped by its budget,
not by an account going to zero. One provider runs per instance; Orbio and
OpenRouter are both wired in today, both governed by the same code path.

**[→ Quickstart](QUICKSTART.md)** — run the local proxy in one command.

Two agents. Same model, same mission, same $0.25 budget. One has an admission check in front of every call, the other doesn't.

| Agent | Model | Calls | Spent | Remaining | Outcome |
|---|---|---:|---:|---:|---|
| Unprotected | `openai/gpt-4.1` | 22 | $0.253680 (101.5%) | **−$0.003680** | budget exhausted, ceiling breached |
| Governed | `openai/gpt-4.1` | 19 (1 refused) | $0.232418 (93.0%) | **$0.017582** | refused before dispatch, quarantined solvent |
| Cheap-routed | `openai/gpt-4.1-mini` | 4 | $0.011044 (4.4%) | **$0.238956** | mission complete |

Recorded live against the Orbio gateway on 2026-09-17. 45 paid calls, $0.497142 of real spend, **100% exact costs, zero estimated**. Full event ledger: [`fixtures/sample-feed.jsonl`](fixtures/sample-feed.jsonl). That's one experiment; total live spend across this project's whole week of testing — every script and every provider that ever touched a real key — comes to **~$0.78**. The whole experiment cost less than a dollar.

The first two rows are the experiment. Identical model, identical mission, identical budget — the only independent variable is admission control. Without it an agent does not stop at its limit; it goes past it.

---

## Why this exists

Orbio issues a **gateway key**, not a funded key. That changes the threat model:

- The key draws directly from the account balance. It has **no credit limit of its own**.
- **Revoking does not refund.** No money was ever parked on the key.
- **Revoking is not containment.** A new key mints against the same balance.
- There is **no per-key or per-period spend cap** on the gateway. The account balance is the only native limit.

So an application-level admission check is the only cap that exists.

## Why the check runs before dispatch

A reproduction in [`tests/adversarial/repro/`](tests/adversarial/repro/) drains a $100 balance in **313ms using 20 concurrent calls** — faster than a one-second polling watchdog gets its first reading. Four full-context requests to a single listed model exceed the balance in one wave.

Any breaker that reacts to spend learns about the spend from the same requests that are draining the account. It cannot win that race at any polling interval, including zero.

This isn't an Orbio quirk. Querying OpenRouter's own account usage right after a call showed the rollup hadn't yet caught up with the per-call cost that same response had already reported in `usage.cost`. The same lag, on a second, independent gateway. "You can't govern by watching the balance" isn't a property of one vendor's dashboard — it's what happens whenever the authoritative number is per-call and the balance is a downstream aggregate.

So Sentinel's governor is a **synchronous, in-process admission check that runs before dispatch and makes no network call**. No LLM call and no HTTP round-trip in the hot path. That is the whole design constraint, and it was measured rather than assumed.

## How the accounting works

Real cost is only known *after* a call returns, in `usage.cost`. Admission happens *before*. So the governor reserves:

1. **Estimate the worst case** — `inputTokens × input_price + max_tokens × output_price`, times a safety multiplier. `inputTokens` is derived from the assembled prompt at dispatch time, never a declared constant.
2. **Reserve it.** If `committed + reserved + worst_case > budget`, refuse. Refusal is a decision, not an error.
3. **Dispatch.** An `INFERENCE_INTENT` event is durably appended first, so a detached call is never invisible.
4. **Reconcile** on return: release the reservation, commit the real `usage.cost` as exact.

Failure directions are chosen explicitly rather than falling out of the code:

- A cut stream or a missing `usage` field commits an **estimate**, tagged `cost_source: "estimated"` and tracked separately from exact spend. Losing real spend silently is worse than reporting an approximation.
- An unknown model is **refused before dispatch**, never dispatched at an assumed price.
- Reservations carry a self-enforcing TTL. A hung call cannot hold budget forever, and a late result cannot land in a released slot.
- Actual cost above its reservation raises `OVER_RESERVATION` and quarantines.
- A run that ends with budget remaining and the mission unfinished is `QUARANTINED_UNPRODUCTIVE` — never `MISSION_COMPLETE`.

The worst case is deliberately conservative. Over-estimating *is* the safety property; the calibration bound-to-billed ratio was 1.77×.

## The mission is reproducible

Both agents extract and synthesise over a corpus **inlined in this repo** ([`fixtures/corpus/`](fixtures/corpus/), ~5,240 tokens). No web tools, no live pages. Clone it and the same run is available to you.

That was a deliberate trade. Live search would have looked better and been unverifiable.

---

## What is not proven

These are stated because the project's whole argument is about not overclaiming. Detail in [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

- **Balance telemetry lag has never been measured.** Nobody has observed the live Orbio balance move after a spend. Any figure suggesting otherwise would be invented.
- **The cap is not durable.** Committed and reserved amounts live in memory. A restart resets them, so the session ceiling is a ceiling *per process*.
- **The key is not in custody.** Scripts read `ORBIO_API_KEY` from `.env` directly. Anything that can read `process.env` holds an uncapped key.
- **Minting is not gated.** A terminal state must eventually mean no further dispatch *and* no further key mints.
- **A leaked MCP OAuth grant is unbounded** by anything Sentinel can do. Only an Orbio-side cap would bound it.

## Where it goes

Sentinel now ships a **local OpenAI-compatible proxy** that holds the key and
puts the governor in front of every chat-completions request. It is a single
custodian process rather than a library convention; the tool receives only a
throwaway local token while the real gateway key remains in the proxy.

The proxy runs one gateway per instance, chosen with `SENTINEL_PROVIDER`:

| Provider | `cost_source` | How |
|---|---|---|
| `orbio` | **exact** | `usage.cost` on every response — the gateway's own billed figure, committed as-is |
| `openrouter` | **exact** | same — `usage.cost` on every response |
| *(a future provider with no cost field)* | **estimated** | computed by Sentinel's own arithmetic from a static price table, not the gateway's invoice — blind to cached-token discounts, volume tiers, and any price change the provider hasn't republished |

**`exact` is never returned for a number Sentinel calculated itself.** No
provider is in the `estimated` state today — both wired-in providers report
their own real cost. The banner and `/healthz` (`cost_reporting`) always say,
per provider, which one you're looking at.

The proxy's verified surface, limitations, and configuration are in
[`docs/PROXY.md`](docs/PROXY.md). Editor and agent integrations are deliberately
not claimed until each has completed a real request through it.

A **hosted** variant serves free governed inference on invite-issued tokens,
with a shared daily pool and a per-token cap in front of the operator's key —
the giveaway is only safe because of the governor. See
[`docs/HOSTED.md`](docs/HOSTED.md).

It also serves a **ledger page** at `GET /` — spend today against budget,
broken down by agent and by model, every refusal with what it would have cost,
the single most expensive call. Agent attribution reuses the client's bearer
token, which the proxy already ignored for authentication: point five agents
at the proxy under five different names in the field they already have to
fill in, and the split shows up without any new configuration. **The ledger
stores metadata only — model, cost, timing, the agent label — never prompt or
completion content.** Detail in [`docs/PROXY.md`](docs/PROXY.md#the-ledger).

---

## Running it

```bash
npm install
npm run test:d2        # governor unit + concurrency + race suites
npm run d2:race        # three-agent race, offline, spends nothing
```

Live runs need `ORBIO_API_KEY` in `.env` and spend real money:

```bash
npm run d2:calibrate   # one call per step shape, hard-capped
npm run d2:race:live   # three agents, $0.25 each, $3.00 session cap
```

Mint a key, run, **revoke it immediately**. Nothing in this repo revokes for you.

## Layout

```
src/governor/        admission, reservations, TTL, exact vs estimated, quarantine
src/orbio/           gateway client
src/runner/          mission definition
src/worker/          step loop, transport-injected
src/ledger/          append-only JSONL
contracts/           feed.schema.json — event shape: v1 frozen for the recorded run, extended additively since
fixtures/            corpus/ and the recorded live run
tests/adversarial/   14 findings with runnable reproductions
docs/                MCP_SURFACE, DAY1_RESULT, DAY1_FAILURE_MODES, LIMITATIONS
sentinel-ui/         replay viewer for the recorded feed
```

The feed contract was frozen at v1 for the recorded Build Week run, and that
version still stands for it. Since then `contracts/feed.schema.json` has been
extended additively only — one event (`RESERVATION_RELEASED`) and one
`cost_source` value (`not_billed`), for calls the provider refused before
running them. `fixtures/sample-feed.jsonl` is unchanged and still validates:
all 139 events pass a JSON Schema (draft 2020-12) validator against both v1
and the current schema.

## Notes on the Orbio gateway

Recorded in [`docs/MCP_SURFACE.md`](docs/MCP_SURFACE.md) as observed, not as documented:

- The current public migration guide specifies `https://api.orbio.so/api/v1`; the recorded 2026-09-17 live run succeeded against `https://api.orbio.so/api/v1/chat/completions`. Earlier MCP observations returned a non-canonical host that redirected POSTs, so the endpoint must be verified before each live run.
- `usage.cost` in each response body is the only spend telemetry a gateway key has. `GET /api/v1/key`, `/auth/key` and `/credits` all 404.
- Reading the balance requires the authenticated MCP bridge; the gateway key alone cannot.

---

Built for [Orbio Build Week](https://www.orbio.so/build).
