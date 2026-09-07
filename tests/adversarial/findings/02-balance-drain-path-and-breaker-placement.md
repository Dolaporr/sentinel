# Finding: fastest credible balance-drain path beats any post-hoc breaker; the breaker must be pre-request and in-process

**Target:** `src/orbio/client.ts` (`OrbioClient` interface / `MockOrbioClient`), plus the not-yet-built D3 breaker (`AGENTS.md`'s build order).
**Severity:** High — this is an architectural placement question for D3, and getting it wrong makes the breaker decorative.

## Given

- The Orbio gateway spends the account balance directly and has **no documented per-key or per-period spend cap** (project context; consistent with `docs/MCP_SURFACE.md`'s "Product model discovered live": a gateway key "spends the live Orbio balance directly... it has no credit limit of its own").
- `orbio_revoke_key` does not contain the balance: it stops one key, but `orbio_create_key` "retires/replaces the previous gateway key," so a fresh key spends the same account balance (`docs/MCP_SURFACE.md`). Nothing in the observed tool surface ties revocation to the *account*, only to the *key*.
- Every MCP tool call is a real round trip with real, sometimes large latency: `MOCK_FAILURE_MODES` includes `tool_latency_30s` ("Each mock operation waits 30 seconds... production should impose a per-tool deadline" — `docs/DAY1_FAILURE_MODES.md`), and the live bridge in `docs/DAY1_RESULT.md` didn't return inside its safety window at all.
- Nothing in `src/orbio/client.ts` or `scripts/d1-lifecycle.ts` tracks *cumulative* spend. `MockOrbioClient.runInference`'s `maxCostUsd` check (`client.ts:57`) is a **per-call** ceiling supplied by the caller each time — it does nothing to stop 1,000 calls each individually under the cap.

## Fastest credible drain path

An attacker (a compromised/prompt-injected agent, a leaked gateway secret, or a leaked account credential minting its own keys) doesn't need to be clever:

1. Fire multiple concurrent inference calls against the gateway. Nothing observed in `docs/MCP_SURFACE.md` documents a per-request price ceiling or a concurrency/rate limit at the gateway, so a request using a large-context or otherwise expensive model is accepted the same as a trivial one.
2. Because there is no cumulative tracking anywhere in this codebase or (per the given context) at the gateway itself, every one of those concurrent calls lands independently. The account balance is drawn down in parallel, not serially.
3. Revoking a key is not a defense against this, because it only removes future access through *that* key — it does not undo in-flight requests, and (per point above) a new key can be minted immediately against the same balance.

So the fastest credible drain is bounded only by **(cost per call) × (sustainable concurrency) / (one network round trip)** — not by anything Orbio or Sentinel currently enforces.

### Reproduction

[`tests/adversarial/repro/balance_drain_race.ts`](../repro/balance_drain_race.ts) models this against two containment strategies, using the live-observed starting balance ($100.076010, `docs/MCP_SURFACE.md`), a $5/call cost (one moderately expensive call — well within what an unrestricted gateway would plausibly accept), a 150ms round trip (conservative relative to the round-trip magnitudes this repo's own docs already establish), and 20 concurrent in-flight requests:

```bash
npx tsx tests/adversarial/repro/balance_drain_race.ts
```

**Scenario A — post-hoc "poll balance, then revoke" watchdog** (a naive shape D3's breaker could take if implemented as an external monitor):

```
t+157ms call#0 landed, balance=$95.08
...
t+158ms call#19 landed, balance=$0.08
t+313ms call#20 landed, balance=$0.00
...
RESULT: balance drained from $100.08 to $0.00 before/around containment.
```

The balance hits **$0.00 at t+313ms** — the watchdog's first poll (`WATCHDOG_POLL_INTERVAL_MS = 1000`) hasn't even fired yet. It never gets an observation to act on. This holds for *any* poll interval competitive with human-scale monitoring (1s, 5s, even 250ms): the attacker's round trip and the watchdog's round trip are the same primitive, but the attacker gets to run many of them concurrently while the watchdog's decide→revoke path is inherently serial (read, decide, then a second round trip to revoke) and single-threaded against a many-way concurrent attacker.

**Scenario B — pre-request local admission control**, where every call is checked against a locally-held running total *before* it is dispatched, with no round trip required to make that decision:

```
t+1ms call#2 BLOCKED pre-dispatch (committed=$10 + cost=$5 > ceiling=$10)
...(16 more blocked at t+1ms)...
t+248ms call#0 landed, balance=$95.08, committed=$10
t+248ms call#1 landed, balance=$90.08, committed=$10
RESULT: balance stopped at $90.08 (spent $10.00), 18 calls blocked before dispatch, ceiling=$10.
```

18 of 20 concurrent calls never leave the process. Total exposure is bounded by the ceiling plus at most one wave of already-in-flight calls (the two that were admitted before the ceiling was reached) — not by network latency at all.

## Where the breaker must sit

**In-process, synchronous, pre-request — not as an external or interval-based monitor of Orbio's own balance/telemetry.** Specifically:

1. **Admission check before dispatch, not confirmation after the fact.** The breaker must maintain its own running total of *committed* spend, incremented at the moment a call is about to be dispatched (optimistically, before the response — even before the request — is sent), and refuse to dispatch once that total would exceed the ceiling. Any design that waits for `getBalance()` or `getKeyStatus()` to confirm spend before acting is racing against concurrency it structurally cannot win, because the confirmation channel is the same round-trip-latency channel the attacker is exploiting in parallel (Scenario A). This is also consistent with `docs/MCP_SURFACE.md`'s own caveat that live spend-proof-by-balance-read is unverified in production — the breaker cannot depend on a channel the project has already flagged as not fully trustworthy.

2. **Account-scoped authority, not key-scoped.** Because a new key can always be minted against the same balance, "revoke the key" cannot be the breaker's terminal action. Once the local ceiling trips, the breaker must stop *itself* from issuing or authorizing any further calls or key creations for that account/session — the containment is "Sentinel stops asking," not "Orbio stops answering." If Orbio exposes no true account-level stop (nothing in `docs/MCP_SURFACE.md` suggests one exists), the breaker's job past that point is to fail closed (refuse to mint/use any further key) and escalate out-of-band, not to keep polling for a server-side guarantee that doesn't exist.

3. **Tied to [Finding 1](01-revoke-recovery-single-read-trust.md)'s reconciliation state.** Any `RECONCILIATION_FAILED` (or the recovery-read fault that finding 1 shows can occur *without* even reaching that event) must immediately trip the same fail-closed state as hitting the spend ceiling — an unresolved revoke is functionally identical to "spend is currently unbounded," and should be treated with equal urgency, not treated as a softer, retriable condition.

In short: the breaker beats the drain path only if it lives on the dispatch side of every `runInference` call, inside the same trust boundary that makes the call, enforcing a locally-owned ceiling that never depends on a round trip to Orbio to take effect.
