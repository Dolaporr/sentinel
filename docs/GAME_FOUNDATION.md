# Game foundation

This is the shared, durable foundation for **The Run** and **Break the Cap**. It deliberately does not modify `src/governor/` or the live proxy.

## Round execution

1. The player submits policy metadata: model, output cap, retry limit, chunk size and escalation threshold. No prompt or executable code is accepted.
2. The game layer quotes the policy using its own game pricing function and records `ROUND_SEALED` plus `GAME_COST_RESERVED` before dispatch.
3. A server-owned transport executes the fixed mission. The player never receives an upstream key.
4. A response carrying `usage.cost` records `GAME_COST_SETTLED`; an upstream error or missing cost releases the reservation through `GAME_COST_NOT_BILLED` and pays no prize.
5. A completed mission can create `PRIZE_ALLOCATION_PENDING`. Pending awards count immediately against both the season pool and player ceiling. A hosted-service allocation is granted only through the explicit `grantPrize` bridge and is recorded as `PRIZE_ALLOCATION_GRANTED`.

## Budget and durability

`GameEventStore` is append-only JSONL. Reconstructing the stream produces the season pool, in-flight reservations, settled provider cost, held prizes and each player's awarded-or-pending total. Place its file on the hosted service volume, separately from the proxy's `.cache/spend.json`; those are two independent pools and neither can borrow from the other.

Season one should be funded with `$50`. The runner refuses an unpriced model, a closed season, an invalid quote, or any run whose worst-case quote exceeds the game's remaining pool. The hard per-player ceiling is enforced on pending as well as already-applied allocations.

## Public board

`publicGameLedger` exposes the durable, checkable event stream: reservation, settlement, refusal reason and provider evidence. It removes request-shaped fields (`prompt`, `messages`, `input`, `instruction`, `instructions`) before evidence is stored or displayed. The hosted API still needs to mount this as a public read-only route.

## Hosted allocation bridge

The game adapter now targets the real hosted admin surface: it reads `GET /admin/tokens`, then patches `PATCH /admin/tokens/<handle>` with the **increased absolute** `lifetimeAllocationUsd`. A game player must use a token issued with a finite `$0.00` allocation; an unlimited hosted token is refused because an increment cannot be audited against its unlimited state.

The hosted route currently has no idempotency key. `PRIZE_ALLOCATION_APPLYING` is written before the PATCH, and any crash in that window blocks retry with a reconciliation error rather than risk a duplicate allocation. A proper hosted allocation endpoint must accept a run reference idempotently before prizes are automated.

## What is deliberately not wired yet

This repository has no hosted-service source, hosted allocation endpoint, player authentication, mounted volume configuration, or admin-authenticated routes. Therefore this foundation provides typed injection points (`GameTransport` and `AllocationGateway`) rather than pretending a local script can issue prizes, receive player policies, or publish a production ledger. Those service boundaries must be wired in the hosted-service repository before either game is opened to players.
