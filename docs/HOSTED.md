# Sentinel hosted

Today Sentinel is something you run with your own key. Hosted, it is something
you *call*, with a key you never see.

```
agent → POST https://<host>/v1/chat/completions
        Authorization: Bearer snt_<token>      ← ours, worthless outside Sentinel
             ↓
        kill switch → token → rate limit → body rules → model allowlist
             ↓
        shared daily pool (checked first) → this token's own governor
             ↓  admit, or 402 with a reason
        upstream with ORBIO_API_KEY            ← never leaves the server
             ↓
        commit exact cost to both ceilings, write the ledger, pass the response through
```

**The free tier is only safe to give away because of the product.** Handing
strangers inference on our key would be reckless with a library convention or
a dashboard alert in front of it. It is safe here because every request is
priced and admitted *before* it is sent, against two hard ceilings that hold
under concurrency — and the public ledger shows them holding, live, for every
user at once. Every refusal on that page is the cap working.

## Routes

| Route | Who | What |
|---|---|---|
| `POST /v1/chat/completions` | token holder | OpenAI-compatible; streaming supported |
| `GET /v1/models` | anyone | allowlisted models this deployment can price |
| `POST /v1/redeem` `{"code": "SNT-…"}` | anyone with a code | returns a token **once** |
| `GET /` and `GET /ledger.json` | anyone | the public ledger |
| `GET /healthz` | anyone | status, pool, caps — no secrets |
| `/admin/*` | operator | separate secret; see the runbook below |

Point any OpenAI-compatible client at `https://<host>/v1` with the `snt_` token
as its API key.

## Two ceilings, both fail closed

1. **Shared daily pool, checked first.** A request holds its worst case against
   the pool until it settles — a reservation, not a reading of committed spend,
   so fifty tokens arriving in the same instant cannot all be admitted against
   the same last cents. When the pool is gone, every caller gets one line:
   *"Sentinel's shared free pool is used up for today ($X of $Y). It resets at
   00:00 UTC, in 5h 12m. Nothing was sent or charged."*
2. **Per-token daily cap.** One `BudgetGovernor` per token, never shared.
   Finding 13 is why: a shared governor turns one user's accounting fault into
   everyone's quarantine. Verified in `hosted:verify` — a token quarantined by an
   over-billed call leaves every other token serving.
3. **Per-token lifetime allocation (optional).** "This token has $20 of
   inference", set by the operator, per token. It never resets, and the daily
   cap still applies on top: the token's governor budget is whichever is
   smaller, what is left of today's cap or what is left of the allocation, so
   both are enforced by reservation like everything else — two concurrent calls
   that fit the allocation only once cannot both be admitted (tested). A
   refusal says which limit bound: waiting for midnight does not help a token
   whose allocation ran out. Tokens without one have only the daily cap.

The two daily ceilings reset at **00:00 UTC** (not local time: the users are everywhere). Both,
plus the allowlist and rate limit, are changed at runtime with
`PATCH /admin/config` — no redeploy. Environment variables only seed the state
file on first boot; after that the stored values win, and startup warns if the
environment disagrees, so a redeploy with stale env vars cannot quietly undo a
change.

## The controls that stop this becoming someone else's business

- **Model allowlist** — the anti-resale control. Default: `openai/gpt-4.1-mini`
  only. Anything else is refused before dispatch with the list of what is served.
- **Rate limit per token**, separate from spend (default 20/min), so cheap calls
  cannot be used to hammer the service. Answered with 429 and `Retry-After`.
- **Request body rules.** Only standard OpenAI chat fields are forwarded; anything
  else is refused *by name*. Some refusals exist because the field would spend
  outside what was reserved:
  - `models` / `route` — gateway fallback routing could bill a model that is
    not on the allowlist, at a price the reservation never saw;
  - `plugins`, `web_search_options` — billed per request on top of tokens;
  - `n` > 1 — n completions against a reservation for one;
  - `max_completion_tokens` is folded into the single ceiling that is reserved
    and only `max_tokens` is sent upstream, so a gateway cannot honour the
    larger of two.
- **Revocation**, all instant, no deploy:
  - one token — `POST /admin/tokens/<handle>/revoke`;
  - every token — `POST /admin/revoke-all`, which also voids unredeemed invite
    codes so none can mint a fresh token a moment later;
  - kill switch — `POST /admin/pause` / `POST /admin/resume`: every user request
    refused with 503, reversible.
- **Automatic pause on a broken operator key.** After `operatorFaultPauseAfter`
  (default 3) upstream 401/402s in a row — the operator's key rejected or out of
  credit — **coming from at least two different tokens**, the service pauses
  itself, persists why, and every caller gets one line: *"Sentinel's free tier
  paused itself: the upstream provider rejected the operator's key 3 times in a
  row, across 2 different tokens (last: HTTP 401). This is on Sentinel's side,
  not yours…"*. The two-token rule exists because a 402 can be caller-triggered
  when the operator's balance is below one allowed request's cost; without it,
  one caller repeating that request could pause everyone's free tier. With a
  single active token a dead key therefore never auto-pauses — every request
  still gets the operator-fault 503 and is charged nothing. Any other upstream
  answer resets the count; a network failure,
  which says nothing about the key, leaves it alone. `POST /admin/resume` clears
  the pause and the count. Each of those failed calls is recorded at **$0,
  `cost_source: "not_billed"`** — no inference ran, so an estimate would be
  wrong, not conservative — and charges neither the caller's cap nor the pool.
- **No prompt content, anywhere.** The ledger records token handle, model,
  token-derived cost, outcome, timing. `hosted:verify` sends a marker string in a
  prompt and asserts it appears in no log line and no file, with a control proving
  the marker really reached the upstream.

## Issuance: invite codes, not accounts

The operator issues codes (`SNT-XXXX-XXXX-XXXX-XXXX`, 80 random bits) and hands
them out by hand. One code redeems once, for one token (`snt_…`, 256 bits).
Used, unknown and voided codes all get the identical answer, so a guesser learns
nothing. Only SHA-256 hashes of codes and tokens are stored: a token is shown
exactly once, in the redeem response.

**Upgrade path, not built:** holder-gating, when the pool is large enough for
sybil resistance to matter. The shape already exists in Arden —
`HOLDER_DAILY_CREDIT_MICROUSD`, `HOLDER_DAILY_POOL_MICROUSD`, hold-for-24h — and
would replace `/v1/redeem` as the way a token is issued; the two ceilings stay.

## The public ledger

The local ledger page, in hosted mode: spend today against the shared pool,
pool remaining, by token (anonymised handle such as `t-3f2a9c` — random, not
derived from the token), by model, refusals with reasons. A model name a caller
typed that is not one the gateway prices is published as `unlisted-model`, never
verbatim — the page is public, and that field is free text. Unauthenticated and
rate-limited requests are not written to it, so nobody can fill it with noise.

## Key custody

The upstream key is read from the provider's own environment variable
(`ORBIO_API_KEY`), with no fallbacks or aliases, and exists in exactly two
places: that process's memory and the outgoing `Authorization` header.

- **Responses.** Every byte bound for a client is scrubbed of the key: JSON
  bodies, error bodies, and streams — including a key split across chunk
  boundaries, which a per-chunk replace would miss. Upstream 401/402 (the
  operator's key rejected or unfunded) are replaced with a Sentinel 503 that
  says the fault is on our side — Orbio's own body for this tells the reader to
  set up client-side encryption, which is meaningless to a caller who has never
  seen the key.
- **Logs.** Upstream error bodies are not logged at all (they can quote the
  request back); unhandled errors log only their type.
- **Disk.** The state file holds hashes; the ledger holds metadata.
- **Admin.** A separate secret, ≥32 characters, refused at startup if it starts
  with `snt_` or equals the upstream key. A user token never reaches the
  comparison.

`hosted:verify` proves this against a stub upstream that deliberately echoes the
`Authorization` header back in all three response shapes, then scans every client
response, every log line and every file for the key. A mutation run with
redaction switched off fails it.

## Deploying on Railway

`railway.json` sets the start command, `/healthz` as the health check, and **one
replica** — the pool and rate limiter hold in-flight state in memory, so two
replicas would each admit against the same pool.

Required variables:

| Variable | |
|---|---|
| `ORBIO_API_KEY` | the operator key. Set it here and nowhere else |
| `SENTINEL_HOSTED_ADMIN_TOKEN` | `openssl rand -base64 32` |
| `SENTINEL_HOSTED_DATA_DIR` | **a mounted volume**, e.g. `/data` |

There is no default data directory on purpose. Without a volume, a redeploy
erases tokens, revocations and today's spend — un-revoking everyone and handing
every token a fresh budget. Startup refuses to run until it is set, and refuses
to start on a corrupt state file rather than replacing it with defaults.

First-boot seeds (optional): `SENTINEL_HOSTED_POOL_DAILY_USD` (5),
`SENTINEL_HOSTED_TOKEN_DAILY_USD` (0.25), `SENTINEL_HOSTED_MODELS`
(`openai/gpt-4.1-mini`), `SENTINEL_HOSTED_RPM` (20),
`SENTINEL_HOSTED_OPERATOR_FAULT_PAUSE_AFTER` (3). `PORT` is read from Railway.

## Operator runbook

```bash
A="Authorization: Bearer $SENTINEL_HOSTED_ADMIN_TOKEN"; H=https://<host>

curl -X POST $H/admin/invites -H "$A" -d '{"count": 5}'      # codes, shown once
curl -X POST $H/admin/invites -H "$A" -d '{"count": 1, "lifetimeAllocationUsd": 20}'   # a code worth $20 in total
curl -X PATCH $H/admin/tokens/t-3f2a9c -H "$A" -d '{"lifetimeAllocationUsd": 20}'      # set or change one token's total; null removes it
curl $H/admin/tokens -H "$A"                                  # handles, spend, status
curl -X POST $H/admin/tokens/t-3f2a9c/revoke -H "$A"          # kill one
curl -X POST $H/admin/pause -H "$A"                           # kill switch
curl -X POST $H/admin/resume -H "$A"
curl -X POST $H/admin/revoke-all -H "$A"                      # kill every token
curl -X PATCH $H/admin/config -H "$A" -d '{"poolDailyCapUsd": 10, "tokenDailyCapUsd": 0.5}'
curl -X PATCH $H/admin/config -H "$A" -d '{"operatorFaultPauseAfter": 5}'   # auto-pause threshold
```

A user redeems with:

```bash
curl -X POST $H/v1/redeem -d '{"code": "SNT-XXXX-XXXX-XXXX-XXXX"}'
```

## Limitations

- **One process.** See Railway above. Horizontal scaling needs the pool's
  reservations in shared storage first.
- **Revocation stops new requests, not ones already in flight.** A request
  admitted a moment before a revoke completes and is accounted normally.
- **A quarantined token stays quarantined until restart**, including across a
  UTC midnight: quarantine means the price table was wrong for a call, and a new
  day does not fix that.
- **Upstream errors other than 401/402 still cost the caller an estimate.** A
  400, 429 or 5xx is settled as an estimated input-leg cost, never silently
  released, because there Sentinel cannot see whether the gateway billed. Only a
  401/402 — refused before any inference ran — is recorded as $0 not_billed.
- **Two callers acting together can still trip the automatic pause** with
  caller-triggered 402s, if the operator's balance is below one allowed
  request's cost. One cannot (see the two-token rule above). At that balance
  normal traffic is failing anyway, so the pause is the right outcome.
- **Unredeemed invite codes never expire** unless voided by revoke-all.
- **Not yet run on Railway, and not yet run against a real upstream with a real
  key through the hosted path.** Every behaviour above is proven against the
  stub; the boot, invite, redeem, models and refusal paths were also exercised
  against Orbio's live price list. §7's done-bar — a real agent, a real cheap
  call, a refusal, the kill switch — is for someone other than its author to run.
