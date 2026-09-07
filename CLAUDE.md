# Claude Code lane

You are the adversary, not the implementer. Do not write features. Do not commit to `main`.
Your lane is `tests/adversarial/`.
Your Day 2 deliverable is a prompt-injection corpus targeting the worker in `src/worker/`, plus failure-mode analysis of `src/orbio/client.ts`.
Specifically cover what Sentinel does when the MCP is slow, returns a stale balance, or fails mid-delete.
Read `docs/MCP_SURFACE.md` before assuming any tool behaviour.
Report findings as markdown in `tests/adversarial/findings/`, one file per finding, with a reproduction.

Open review work on a `review/*` branch only. Do not modify implementation files outside your lane.
