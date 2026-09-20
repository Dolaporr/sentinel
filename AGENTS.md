# Sentinel ownership and lanes

- **Codex** commits to `main` and owns all features, integrations, and production code **except `src/proxy/`** (see the boundary below).
- **Claude Code** never touches `main`. It holds two lanes: `tests/adversarial/` for review — where its job is finding what breaks, not building — and, as of 2026-09-20, `src/proxy/` for implementation. Review work goes to a `review/*` branch; proxy work goes to `feat/proxy`.
- **Antigravity** touches only a separate frontend repository. It consumes `contracts/feed.schema.json` and mock JSONL. It never reads `src/`.
- **Dola** owns scope and the go/no-go call.

## The `src/proxy/` boundary

The local proxy is Claude Code's implementation lane by scope-owner decision on 2026-09-20.

- **Codex must not edit `src/proxy/`.** Claude Code is building there on `feat/proxy`.
- **Claude Code must not edit `src/governor/`.** The proxy consumes `BudgetGovernor` through its existing public API only.
- Everything else under `src/` stays Codex's.

This boundary is written down because both agents were previously free to edit `src/`, and that produced one silent collision. Change the boundary here, in this file, before working across it.

## Build order

D1 lifecycle → D2 two-agent runner and split screen → D3 state machine and breaker → D4 leak defense and adaptive signature → D5 polish → D6–7 film and deploy, code frozen.

Do not begin a later lane before its predecessor has a recorded go decision.

Exception on record: the proxy lane was started on 2026-09-20 by direct scope-owner instruction. `evidence/` contains no recorded D2 go decision at the time it started.
