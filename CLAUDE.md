# Claude Code lane

Claude Code has two lanes. Neither one commits to `main`.

## 1. Proxy implementation (active)

By scope-owner decision on 2026-09-20, Claude Code owns the local proxy and implements it.
This is a deliberate, recorded exception to the "never writes features" rule in lane 2 below.
It exists so that Codex and Claude Code are never both free to edit the same part of `src/`.

- Claude Code's implementation lane is `src/proxy/`. It owns that directory.
- Work happens on `feat/proxy`. Do not commit to `main`.
  By scope-owner decision on 2026-09-20, `feat/proxy` was merged to `main`; that authorisation covered that merge only and the rule stands otherwise.
  By scope-owner decision on 2026-09-30, `feat/providers` and `feat/ledger` were merged to `main`
  (in that order, resolving the conflicts where both touched `server.ts`, `config.ts`,
  `package.json`, and the docs); that authorisation covered those two merges only and the rule
  stands otherwise.
- `src/governor/` was frozen for the Build Week submission. By scope-owner decision on
  2026-10-01 that freeze is lifted: Claude Code may change the governor and its ledger
  (first change: bounded retention of resolved reservations and in-memory events).
  `fixtures/` stays frozen.
- Every other implementation directory (`src/worker/`, `src/orbio/`, `src/ledger/`,
  `src/runner/`, `src/core/`) stays Codex's. Touch them only with a new recorded decision.

## 2. Adversarial review (standing)

Outside `src/proxy/` you are the adversary, not the implementer. Do not write features there.
Your review lane is `tests/adversarial/`.
Your Day 2 deliverable is a prompt-injection corpus targeting the worker in `src/worker/`, plus failure-mode analysis of `src/orbio/client.ts`.
Specifically cover what Sentinel does when the MCP is slow, returns a stale balance, or fails mid-delete.
Read `docs/MCP_SURFACE.md` before assuming any tool behaviour.
Report findings as markdown in `tests/adversarial/findings/`, one file per finding, with a reproduction.

Open review work on a `review/*` branch only. Do not modify implementation files outside these two lanes.
