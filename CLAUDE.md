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
  By scope-owner decision on 2026-10-01, `fix/output-ceiling`, `fix/governor-retention` and
  `feat/hosted` were merged to `main`, in that order (the first closes a live `n` /
  `max_completion_tokens` cap bypass); that authorisation covered those three merges only and
  the rule stands otherwise.
  By scope-owner decision on 2026-10-01, `fix/hosted-lifecycle` and `feat/hosted-ops` were
  merged to `main` in one pass, in that order. The IPv6 dual-stack listen path in
  `fix/hosted-lifecycle` is untested (the build sandbox has IPv6 disabled; only the IPv4
  fallback ran). That authorisation covered those two merges only and the rule stands
  otherwise.
  Update, 2026-10-01: the dual-stack path is confirmed in production. On Railway the boot
  banner printed "(IPv6 and IPv4)", which is only printed when the listen on "::" succeeds
  with no IPv4 fallback (observed by the scope owner in the Railway logs), and the service
  answers through its public domain (/healthz, /v1/models and / all 200, checked by Claude Code).
  By scope-owner decision on 2026-10-01 ("fix and push"), `fix/railway-start` was merged to
  `main` to restore Railway builds (Railpack found no start command). That authorisation
  covered that merge only and the rule stands otherwise.
  By scope-owner decision on 2026-10-01, `docs/ipv6-confirmed` was merged to `main` once the
  live smoke test and the redeploy volume check had both passed, so the IPv6 confirmation
  and the status lines landed together. That authorisation covered that merge only and the
  rule stands otherwise.
- `src/governor/` was frozen for the Build Week submission. By scope-owner decision on
  2026-10-01 that freeze is lifted: Claude Code may change the governor and its ledger
  (first change: bounded retention of resolved reservations and in-memory events).
  `fixtures/` stays frozen.
- Every other implementation directory (`src/worker/`, `src/orbio/`, `src/ledger/`,
  `src/runner/`, `src/core/`) stays Codex's. Touch them only with a new recorded decision.
- By scope-owner decision on 2026-10-04, Claude Code applied the scope owner's reviewed Sneak Past Sentinel arcade patch to `src/game/` and its test on `feat/sneak-arcade`; that authorisation covered that change only and `src/game/` otherwise stays Codex's.

## 2. Adversarial review (standing)

Outside `src/proxy/` you are the adversary, not the implementer. Do not write features there.
Your review lane is `tests/adversarial/`.
Your Day 2 deliverable is a prompt-injection corpus targeting the worker in `src/worker/`, plus failure-mode analysis of `src/orbio/client.ts`.
Specifically cover what Sentinel does when the MCP is slow, returns a stale balance, or fails mid-delete.
Read `docs/MCP_SURFACE.md` before assuming any tool behaviour.
Report findings as markdown in `tests/adversarial/findings/`, one file per finding, with a reproduction.

Open review work on a `review/*` branch only. Do not modify implementation files outside these two lanes.
