# The Sentinel proxy

An OpenAI-compatible endpoint that holds the gateway key and puts the budget
governor in front of it. It is shipped and accepts chat-completions traffic from
clients with a configurable base URL. Editor and agent integrations must be
verified individually before being claimed; compatibility is not an endorsement
that Cursor, Codex, or Claude Code has completed a real request through it.

```
npm run proxy
```

```
Base URL   http://127.0.0.1:8787/v1
Route      POST /v1/chat/completions
Models     GET  /v1/models
Health     GET  /healthz
Ledger     GET  /            (page)
           GET  /ledger.json (data)
```

## Client compatibility — 2026-09-23

Verified against the real gateway: a direct OpenAI-compatible `POST
/v1/chat/completions` request, including streamed responses with a terminating
`usage.cost` chunk. The generated record is
[`PROXY_VERIFICATION.md`](PROXY_VERIFICATION.md).

Verified locally against a stub: request fields `tools`, `tool_choice`,
`response_format`, `seed`, `stop`, `temperature`, `top_p`,
`parallel_tool_calls` and `user` are forwarded unchanged; streamed `tool_calls`
deltas and their arguments are forwarded progressively and settle exactly when
the stream includes `usage.cost`.

**`GET /v1/models` is implemented.** It returns a 200 with an OpenAI-compatible
`{ object: "list", data: [...] }` body, synthesised from the price table
already resident at startup -- no gateway round trip per client connect, and it
lists exactly the models this proxy can actually admit, since admission checks
the same table. `owned_by` comes from the id's `provider/` prefix; `created`
from the entry's `verifiedAt`. This is the route most OpenAI-compatible
clients, Cursor confirmed among them, GET before they will save a base URL, so
its absence was a hard block on that whole class of client rather than a
missing nicety.

Not verified for release: a real Cursor, Codex CLI, Claude Code, or OpenAI SDK
session actually completing a request through this proxy. `/v1/models`
responding is necessary for those clients to get as far as attempting one; it
is not proof any of them did. Do not claim a client as supported until it has.

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

## The ledger

**Sentinel never stores prompt or completion content in the ledger. Metadata
only** — model, token counts, cost, timing, the agent label below, and the
refusal reason when one applies. Nothing else. That sentence is repeated at
startup, at the top of `GET /`, and in the README, because it is what makes it
safe to point another agent's traffic at this proxy at all.

`GET /` serves a single self-contained HTML page — no build step, no CDN,
matching the artifacts — that fetches `GET /ledger.json` and answers, in
order: what was spent today against budget, exact versus estimated; spend by
agent; spend by model; every refusal today, with what it would have cost and
what was left; and the single most expensive call. At most one sparkline of
cumulative spend across the day. Both routes read from a durable store on
disk; neither sits on the admission path, so a slow read here never delays a
completion.

### Attribution — the client's bearer token becomes a label

The proxy already ignored the client's `Authorization` bearer token for
authentication (see above): every OpenAI-compatible client is forced to put
*something* in that field regardless, so it is reused as a name instead of
being pure junk.

```
Authorization: Bearer roberto-ranker   -> agent "roberto-ranker"
Authorization: Bearer sentinel-local   -> agent "unnamed"
(missing or empty)                     -> agent "unnamed"
```

`sentinel-local` is the literal example this README and the startup banner
tell every unconfigured client to type, so it is treated as a placeholder, not
a name — otherwise every default install would report a distinct-looking
`sentinel-local` agent that is really just everyone who copy-pasted the
example.

**It is a label, not authentication.** Anyone on the loopback can claim any
name, exactly as anyone on the loopback can already spend the budget — see
"Client auth is loopback trust, not authentication" above. Two agents that
both send `Authorization: Bearer roberto-ranker` are indistinguishable in the
ledger. This is the same trust boundary the proxy already has, written down a
second time because attribution is the part someone could mistake for identity.

The label is hostile input the moment it leaves the client: it is lower-cased,
restricted to `[a-z0-9_-]`, and capped at 40 characters before it reaches the
ledger file or the page, falling back to `unnamed` only when nothing usable
survives — a pasted `"Roberto Ranker!!"` becomes `roberto-ranker`'s plainer
cousin `robertoranker` rather than being thrown away outright. The page never
interpolates the result into markup either way: every dynamic value, agent and
model names included, reaches the DOM through `textContent`, never `innerHTML`
or a template string, so there is no interpolation point for an escaper to be
missing from.

### Why a second ledger file

`SENTINEL_PROXY_LEDGER` below (unset by default) is the frozen governor's own
event journal — `src/governor/`'s shape, untouched. It has no field for an
agent label, and cost commits don't even carry the model id, so building "by
agent" or "by model" from it would mean joining several inconsistent event
shapes by `attempt_id` on every page load. `SENTINEL_PROXY_CALL_LEDGER` is a
separate, proxy-owned file (`src/proxy/call-ledger.ts`) written alongside the
governor's own bookkeeping, one row per resolved request, in exactly the shape
the ledger page needs. It does not replace the governor's ledger and does not
touch `src/governor/`; it is on by default because a page whose entire point
is "here is what happened" needs something to read without an env var nobody
sets.

**Found while building this:** `SENTINEL_PROXY_LEDGER` has no default and is
unset out of the box, so the governor's own frozen event journal is not
currently durable across a restart unless someone sets that variable
themselves — a pre-existing gap, not something this feature introduced or
fixed. Left as-is here rather than silently changed, since it is a decision
about an already-shipped default, not about attribution or the view.

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
| `SENTINEL_PROXY_LEDGER` | unset | append the frozen governor's own events to this JSONL path |
| `SENTINEL_PROXY_CALL_LEDGER` | `.cache/calls.jsonl` | per-call, agent-attributed rows the ledger page reads — see "Why a second ledger file" above |

`npm run proxy:verify` exercises the route, streaming, cut streams, the price
table's fallback chain and the daily cap against a local stub gateway. No key,
no network, no spend.

`npm run proxy:verify:live` does the same against the **real gateway with a real
key**, and writes `docs/PROXY_VERIFICATION.md` from what it observed: the startup
banner, cost source and real cost for a non-streaming and a streamed completion,
per-chunk arrival times proving the stream is passed through progressively rather
than buffered, wall clock through the proxy against direct, `/healthz`, and a
forced refusal. It aborts above $0.05 and runs under its own $0.10 cap.

A run against the live gateway is recorded in
[docs/PROXY_VERIFICATION.md](PROXY_VERIFICATION.md).

`npm run --silent demo:call` sends one real completion through a running proxy
and prints three lines — model, cost, remaining budget — or the refusal message
if the governor says no. Use `--silent` so npm's own header lines stay out of
the output.

`npm run proxy:verify:ledger` covers attribution (bearer-token extraction and
normalisation, including the `sentinel-local` placeholder and hostile input),
the call ledger's storage and aggregates, both routes, and — the check that
matters most — a real request carrying a distinctive prompt string, read back
from the actual ledger file and the actual `/ledger.json` response, asserting
that string appears nowhere in either.

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
- **Input tokens are estimated, not counted, and the correction is proxy-local.**
  The proxy adds chat-template overhead — 3 tokens per message plus 3 for reply
  priming — on top of `estimateTokens`, because the gateway prices a rendered
  chat template whose delimiter and role tokens never appear in the message
  text. The constants are calibrated against one live response
  (`prompt_tokens: 23` against a raw estimate of 18) and are biased high: that
  request now estimates 24.

  **This correction lives in `src/proxy/messages.ts` only.** `estimateTokens` in
  `src/runner/` is unchanged and still under-counts real `prompt_tokens` by
  roughly 20% for anything that calls it directly — the mission runner and the
  calibration script both do. Its own documentation says it over-counts and
  "errs high"; measured against a live response, it does not. Correcting it
  there would change the D2 runner's reservations, which is Codex's lane.

  Non-text content (images, audio) is still counted as its serialized JSON,
  which is a guess; those requests reserve a number not derived from what the
  gateway will actually price.
- **The cap is per-machine.** See above.
- **A streamed response does not report its cost source.** `x-sentinel-cost-source`
  is set on non-streaming responses but is absent on streamed ones: headers
  flush before the stream begins, so the cost is not known in time. A streaming
  client cannot tell an exact cost from an estimated one; only `committed_exact`
  versus `committed_estimated` on `/healthz` shows it. Measured 2026-09-20: the
  gateway does honour `stream_options: {include_usage: true}`, so streamed calls
  currently commit as exact — this is a reporting gap, not an accounting one,
  until a stream is cut.
- **Attribution is a label, not identity.** Anyone on the loopback can claim any
  agent name; two agents both sending the same bearer token are indistinguishable
  in the ledger. Per-agent budgets are out of scope — see "The ledger" above.
- **`SENTINEL_PROXY_LEDGER` (the frozen governor's own event journal, distinct
  from the ledger page's `SENTINEL_PROXY_CALL_LEDGER`) has no default and is
  unset out of the box**, so it is not durable across a restart unless set
  explicitly. Pre-existing, found while building the ledger page, left
  unchanged — see "Why a second ledger file" above.
- **The ledger page has no historical retention beyond what
  `SENTINEL_PROXY_CALL_LEDGER` already keeps**, no export, and no authentication
  of its own beyond the loopback trust the whole proxy already runs on.
