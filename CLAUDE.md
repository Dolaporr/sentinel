# Claude Code lane

Claude Code has two lanes. Neither one commits to `main`.

## 1. Proxy implementation (active)

By scope-owner decision on 2026-09-20, Claude Code owns the local proxy and implements it.
This is a deliberate, recorded exception to the "never writes features" rule in lane 2 below.
It exists so that Codex and Claude Code are never both free to edit the same part of `src/`.

- Claude Code's implementation lane is `src/proxy/`. It owns that directory.
- Work happens on `feat/proxy`. Do not commit to `main`.
- `src/governor/` is off-limits. The proxy consumes `BudgetGovernor` through its existing
  public API only (`reserve`, `commitExact`, `commitEstimated`, `expire`, `snapshot`,
  `assertStepFitsBudget`). It does not modify governor internals or the ledger.
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
