# The Sentinel proxy

An OpenAI-compatible endpoint that holds the gateway key and puts the budget
governor in front of it. Point any tool with a configurable base URL at it —
Cursor, Codex, Claude Code — and every call passes through admission control
without the tool knowing.

```
npm run proxy
```

```
Base URL   http://127.0.0.1:8787/v1
Route      POST /v1/chat/completions
Health     GET  /healthz
```

The API key the client sends is ignored, so anything non-empty works.

---

## What it does to a request

1. **Prices the model.** A model with no verified per-token price is refused
   before dispatch. There is no assumed price and no zero-cost default.
2. **Derives input tokens** from the assembled messages and any tool
   definitions. Never a declared constant. The estimate deliberately
   over-counts, because it feeds a worst-case bound.
3. **Injects `max_tokens`** when the client sends none, and forwards it. A
   request with no ceiling has an unbounded worst case, which would make its
   reservation meaningless.
4. **Reserves** the worst case × the safety multiplier. If the governor refuses,
   the client gets **HTTP 402** with the numbers in `error.message`, which is
   what Cursor and Codex surface to the user.
5. **Forwards** to `https://www.orbio.so/api/v1/chat/completions`. Always the
   `www` host: the apex answers a POST with a 308, and a redirected POST loses
   its body.
6. **Reconciles.** `usage.cost` commits as exact. A cut stream, a missing
   `usage`, an upstream error or a dispatch that outlives its reservation
   commits an *estimate* instead. Never a silent zero, never a silent release.

Streaming is passed through to the client as it arrives while being accumulated
server-side, so `usage` can be read from the terminating chunk.

---

## The price table

Resolved once at startup, held for the life of the process, never re-fetched per
request. The source is logged and reported by `/healthz` as `price_source`.

| source | what |
| --- | --- |
| `gateway` | `GET /api/v1/models` — ~425 models with live pricing |
| `cache` | `.cache/price-table.json`, rewritten on every successful fetch |
| `static` | the two hardcoded models, only if the gateway fails *and* no cache exists |

A freshly fetched table is compared against the hardcoded one and any
disagreement is logged as `DRIFT`. A wrong price is the one error that lets every
individual admission check pass cleanly while the real ceiling is wrong.

### Models priced at zero

The gateway lists ~178 models with a zero per-token output price. They are two
different things, and the proxy treats them differently:

- **Ends in `:free`** (~27) — genuinely free. Admitted at a zero reservation.
  There is no spend to bound, so zero is the truth.
- **Everything else** (~151) — image, video and transcription models that bill
  per asset or per second. Refused, with:

  > no per-token price — this model may bill per asset, so the budget can't
  > bound it.

  Their real cost is invisible to a per-token bound, so admitting them would
  report a $0 worst case while real money is spent.

---

## The daily cap

A **rolling daily window**, not a cumulative-forever total. Set it with
`SENTINEL_PROXY_DAILY_CAP_USD`.

Today's committed total lives in `.cache/spend.json`:

```json
{ "date": "2026-09-20", "committed_usd": 1.284 }
```

It is rewritten after **every** commit, exact or estimated, so a crash loses at
most the call in flight. On startup the proxy loads today's total and hands the
governor `cap − spent_today` as its budget. A record from a previous date is not
carried forward; a new date starts at zero.

If today's total already meets the cap, the proxy starts in a refusing state,
says so in the banner, and answers every request with
`sentinel_daily_cap_reached`. It does not silently grant a fresh budget.

This is the part that makes the cap survive a restart. The governor itself is
in-memory and starts every process at `$0` committed — without this file,
anyone who restarts after being refused gets their full budget back and the cap
stops being a cap.

### The cap is per-machine, not per-account

`.cache/spend.json` is a local file. It bounds what **this checkout of this
proxy on this machine** spends. It does not know about:

- the same key used from another machine, another checkout, or another tool;
- spend through the gateway's own console or any other client;
- anything the account was charged for outside this proxy.

Two proxies sharing one key each get their own full daily cap. For a real
account-wide ceiling the authority has to be the gateway, not this file.

### Midnight

The window is evaluated at **startup**, against the local calendar date. A proxy
left running across midnight keeps the budget it was given; the stored record
rolls to the new date, but the governor's budget does not grow back until the
process restarts. Restart it after midnight to pick up the new day.

---

## Key custody

The proxy reads `ORBIO_API_KEY` from `.env` and holds it. It is:

- **never forwarded to clients** — client requests get a response body and
  `x-sentinel-*` headers, nothing else;
- **never logged** — the banner reports only whether a key is configured, and
  upstream error bodies are redacted before they reach a log, in case a gateway
  reflects the submitted key in an error;
- **not routed through MCP** — `src/orbio/client.ts`'s MCP path rejects calls
  from this process, and adding that dependency would put an authenticated
  bridge in the path of every completion.

### Client auth is loopback trust, not authentication

The server binds **`127.0.0.1` only**, and this is not configurable. Whatever
bearer token a client sends is accepted and discarded — it is not checked
against anything.

**This is not authentication.** Any process or user on this machine can spend
against the proxy's budget. It is not a multi-user control, and it must not be
exposed to a network. Binding to another interface would offer the key's
spending power to anything that can route to it.

**What it does close:** the tool pointed at the proxy never holds the real key.
Cursor, Codex and anything else configured against it store a throwaway string
in their settings. A leaked client config, a synced settings file or a screen
share exposes nothing that can spend. The key stays in one process, on one
machine, in one `.env`.

---

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `ORBIO_API_KEY` | — | the upstream key. Without it every request is refused with 503 |
| `SENTINEL_PROXY_PORT` | `8787` | loopback port |
| `SENTINEL_PROXY_DAILY_CAP_USD` | `3` | the rolling daily ceiling |
| `SENTINEL_PROXY_BUDGET_USD` | the daily cap | a tighter ceiling for one proxy run |
| `SENTINEL_PROXY_DEFAULT_MAX_TOKENS` | `1024` | injected when the client sends none |
| `SENTINEL_PROXY_RESERVATION_TTL_MS` | `120000` | a dispatch is aborted at its reservation deadline |
| `SENTINEL_PROXY_SPEND` | `.cache/spend.json` | the durable daily total |
| `SENTINEL_PROXY_PRICE_CACHE` | `.cache/price-table.json` | last known good price table |
| `SENTINEL_PROXY_LEDGER` | unset | append governor events to this JSONL path |

`npm run proxy:verify` exercises the route, streaming, cut streams, the price
table's fallback chain and the daily cap against a local stub gateway. No key,
no network, no spend.

`npm run proxy:verify:live` does the same against the **real gateway with a real
key**, and writes `docs/PROXY_VERIFICATION.md` from what it observed: the startup
banner, cost source and real cost for a non-streaming and a streamed completion,
per-chunk arrival times proving the stream is passed through progressively rather
than buffered, wall clock through the proxy against direct, `/healthz`, and a
forced refusal. It aborts above $0.05 and runs under its own $0.10 cap.

---

## Known limitations

- **`committed_estimated` is not exact.** A cut stream or a missing `usage`
  commits an estimate derived from observed output. `/healthz` reports exact and
  estimated separately and they should not be added together and presented as a
  measured figure.
- **A `:free` model that actually bills will quarantine the proxy.** It reserved
  `$0` and was charged, which the governor treats as an over-reservation and an
  integrity fault. That is the intended fail-closed response, and it halts
  admissions until restart. The refusal says which model, what it was advertised
  at, what it actually billed, and that restarting refetches prices:

  > Sentinel has halted admissions: vendor/lying was advertised at $0.0000/M
  > output, so the call reserved $0.000000 — but it billed $0.000123, more than
  > was reserved. The price table is wrong for this model, so no further call
  > can be bounded correctly. Restart the proxy to refetch prices from the
  > gateway and resume.

  `/healthz` carries the same text as `quarantine_reason`. A late result — one
  arriving after its reservation was settled — quarantines through the other
  door and explains itself the same way.
- **Input tokens are estimated, not counted.** The estimate over-counts on
  purpose. Non-text content (images, audio) is counted as its serialized JSON,
  which is a guess; those requests reserve a number that is not derived from
  what the gateway will actually price.
- **The cap is per-machine.** See above.
- **`stream_options: {include_usage: true}` is requested, not confirmed.**
  Whether the gateway honours it has not been verified against a live key. If it
  does not, streamed calls fall back to an estimate from observed output rather
  than an exact cost.
