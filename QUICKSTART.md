# Sentinel quickstart

## Requirements

- Node.js **20 or newer**. Node 18 is not supported by this release.
- An Orbio gateway key in `ORBIO_API_KEY`. Keep it in `.env`; it is ignored by Git.

## Start the local proxy

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

## Verify without spending

```bash
npm install
npm run proxy:verify
```

For the complete, current compatibility record, see
[`docs/PROXY.md`](docs/PROXY.md).
