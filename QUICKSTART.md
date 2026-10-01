# Sentinel quickstart

Two ways in: run the proxy yourself with your own gateway key (below), or, if
you have an invite code for a hosted instance, use that and install nothing.

## Using a hosted instance

You need the instance's URL and an invite code, both from its operator.

```bash
curl -X POST https://<host>/v1/redeem -d '{"code": "SNT-XXXX-XXXX-XXXX-XXXX"}'
```

The response contains your `snt_` token — shown once; keep it. Then point any
OpenAI-compatible client at:

```text
base URL  https://<host>/v1
API key   snt_...
```

Only the models in `GET https://<host>/v1/models` are served. Your token has a
daily cap and may have a lifetime allocation (both in the redeem response); a
call that would exceed either is refused with HTTP 402 and a one-line reason
before anything is spent. Spend is public, by anonymised handle, at
`https://<host>/`. More in [`docs/HOSTED.md`](docs/HOSTED.md).

## Running it yourself

### Requirements

- Node.js **20 or newer**. Node 18 is not supported by this release.
- A gateway key for your chosen provider: `ORBIO_API_KEY` (default) or
  `OPENROUTER_API_KEY` (with `SENTINEL_PROVIDER=openrouter`). Keep it in
  `.env`; it is ignored by Git. Only one provider runs per proxy instance —
  see "Providers and cost accuracy" below.

### Start the local proxy

```bash
npx github:Dolaporr/sentinel --budget 5
```

The proxy binds only to `127.0.0.1:8787` and exposes `POST /v1/chat/completions`,
`GET /v1/models`, and `GET /healthz`. `/v1/models` is what most
OpenAI-compatible clients check before they will save a base URL, so this is
the address to point them at, not just the completions route:

```text
http://127.0.0.1:8787/v1
```

Point only a client that has been explicitly verified against this base URL —
see [`docs/PROXY.md`](docs/PROXY.md) for which ones have.

Use any non-empty client API key, for example `sentinel-local`; the proxy
discards it. The real gateway key stays in the proxy process.

### Providers and cost accuracy

`SENTINEL_PROVIDER` picks the gateway: `orbio` (default) or `openrouter`.
Both report **real, exact cost** — each returns `usage.cost` on the response,
and Sentinel commits that figure as-is (`cost_source: "exact"`). Neither is
computed by Sentinel. A provider that doesn't report a cost figure would have
one **estimated** by Sentinel from a static price table instead, labelled
`cost_source: "estimated"` — that label means Sentinel's own arithmetic, not
the provider's invoice, and it can't see cached-token discounts, tiered
pricing, or a price change the provider hasn't published. No such provider is
wired in yet; the banner and `/healthz` (`cost_reporting`) always name the
active provider and which kind of number you're looking at.

### Verify without spending

```bash
npm install
npm run proxy:verify
```

For the complete, current compatibility record, see
[`docs/PROXY.md`](docs/PROXY.md).
