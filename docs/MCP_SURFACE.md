# Orbio MCP surface — authenticated live observation

**Observed:** 2026-09-07, after OAuth authorization against `https://www.orbio.so/api/mcp`.
**Status:** verified from the live MCP tool definitions. Read-only responses were also observed for `orbio_get_balance` and `orbio_get_key_status`.

## Product model discovered live

The current Orbio key is a **gateway key**, not a funded OpenRouter key. It spends the live Orbio balance through Orbio's OpenAI-compatible gateway; it has no credit limit of its own. Therefore `orbio_revoke_key` stops the key but does not return a balance, because no balance moved onto it.

## Gateway URL inconsistency — 2026-09-07

The MCP has returned inconsistent non-canonical base hosts: an earlier `orbio_get_key_status`/`orbio_create_key` observation returned `https://orbio.so/api/v1`, while the 2026-09-07 raw proof returned `https://api.orbio.so/api/v1`. A raw `POST` to the former returned `308 Permanent Redirect` with `Location: https://www.orbio.so/api/v1/chat/completions` and body `Redirecting...`. A redirect is unsuitable for an inference POST because clients may not preserve the request body or authorization semantics. The direct OpenAI-compatible endpoint `https://www.orbio.so/api/v1/chat/completions` succeeded with HTTP 200; use it rather than the redirecting host. This contradicts the current MCP field and is recorded as a live surface inconsistency.

### Current endpoint re-verification — 2026-09-17

Orbio's public migration guide now specifies `https://api.orbio.so/api/v1`. The recorded Sentinel live race used `https://api.orbio.so/api/v1/chat/completions` and every one of its 45 calls returned HTTP 200 with `usage.cost`. The 2026-09-07 redirect observation remains historical evidence of a host transition; do not assume a prior host is still canonical for a new live run.

`orbio_delete_key` is a legacy-only clean-up operation. It applies only to an account that still holds a pre-gateway provisioned OpenRouter key and returns that legacy key’s unspent amount.

## Live tools

| Tool | Parameters | Return shape | Live behaviour |
| --- | --- | --- | --- |
| `orbio_get_balance` | None | `{ wallets: string[], accrued: { usd: number, microUsd: string }, purchased: Money, spent: Money, claimed: Money, balance: Money }` | Reads the account’s accumulated, purchased, spent, claimed, and currently spendable credits. `Money` is `{ usd: number, microUsd: string }`; micro-USD is exact. |
| `orbio_get_key_status` | None | `{ hasKey: boolean, prefix?: string, createdAt?: string, lastUsedAt?: string, baseUrl: string, legacy: LegacyKey \| null }` | Reads the gateway key’s visible prefix and lifecycle data. `LegacyKey` is `{ disabled: boolean, label: string \| null, limitUsd?: number \| null, readable: boolean, remainingUsd?: number \| null, usageUsd?: number \| null }`. |
| `orbio_create_key` | `{ label?: string }` where label is at most 60 characters | `{ key: string, prefix: string, baseUrl: string, replaced: boolean }` | Mints the single gateway key. Calling it again retires/replaces the previous gateway key. The secret is returned once only. Invoked once for the bounded D1 attempt; the secret was held only in memory. |
| `orbio_revoke_key` | None | `{ revoked: boolean }` | Stops the gateway key. The balance is explicitly unchanged. Invoked once; a following status read reported no key. |
| `orbio_delete_key` | None | `{ label?: string \| null, refunded: { usd: number, microUsd: string } }` | Permanently disables a pre-gateway legacy OpenRouter key and returns its unused credit to the account balance. **Not invoked; no legacy key exists on this account.** |

## Read-only preflight observed

`orbio_get_balance` returned:

- spendable balance: `$100.076010` (`100076010` micro-USD)
- accrued: `$100.076010`
- spent through gateway: `$0.000000`
- claimed onto a legacy key: `$0.000000`

`orbio_get_key_status` returned an active gateway key before the bounded attempt. After `orbio_revoke_key`, it returned `hasKey: false`; the active secret is not retained in this document, evidence, code, or messages.

The key secret is intentionally not stored in this document, code, evidence, or later messages.

## Consequence for Sentinel Day 1

The original D1 lifecycle (`claim → spend → delete → unused amount returns`) is not implementable for this account’s current live Orbio surface. There is no claim/top-up/rotate model for gateway keys, and there is no legacy key available for `orbio_delete_key`.

The accepted gateway criterion is: **balance read → bounded gateway spend → live balance decreases → key revoke disables access while balance remains unchanged**. The revoke/balance portion was observed; the spend portion remains unproven because the Agent SDK request could not complete inside its safety window. See `DAY1_RESULT.md`.
