# Sentinel

Terminal proof of the Orbio **gateway** lifecycle: spend from the Orbio balance, observe the lower balance, revoke the gateway key, and confirm the balance is unchanged. Day 1 is intentionally limited to the append-only evidence ledger and lifecycle script—no UI, worker, state machine, breaker, or deployment.

## Run the safe mock proof

```bash
npm install
npm run d1
```

`ORBIO_BACKEND=mock` is the default. It makes no network inference calls and cannot claim or spend real credits. The evidence stream is written to `evidence/d1-lifecycle.jsonl` and is intentionally ignored by Git.

The local runner is deliberately mock-only. The authenticated live bridge records the exact MCP responses and never writes a gateway secret to disk.
