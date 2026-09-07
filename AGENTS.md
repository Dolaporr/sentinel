# Sentinel ownership and lanes

- **Codex** is the only agent that commits to `main`. It owns all features, integrations, and production code.
- **Claude Code** never writes features and never touches `main`. It works only in `tests/adversarial/`, reviews Codex diffs, and opens PRs against a `review/*` branch. Its job is finding what breaks, not building.
- **Antigravity** touches only a separate frontend repository. It consumes `contracts/feed.schema.json` and mock JSONL. It never reads `src/`.
- **Dola** owns scope and the go/no-go call.

## Build order

D1 lifecycle → D2 two-agent runner and split screen → D3 state machine and breaker → D4 leak defense and adaptive signature → D5 polish → D6–7 film and deploy, code frozen.

Do not begin a later lane before its predecessor has a recorded go decision.
