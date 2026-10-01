import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GameRoundRunner } from "../../src/game/round-runner.js";
import { HostedAllocationGateway } from "../../src/game/hosted-allocation.js";
import { publicGameLedger } from "../../src/game/public-ledger.js";
import { GameEventStore } from "../../src/game/store.js";
import type { GamePolicy, GameSeason, GameTransport } from "../../src/game/types.js";

const season: GameSeason = { id: "season-one", poolUsd: 1, perPlayerCeilingUsd: 0.20, prizePerWinUsd: 0.10, allowedModels: ["openai/gpt-4.1-mini"], active: true };
const policy: GamePolicy = { model: "openai/gpt-4.1-mini", maxTokens: 300, retryLimit: 0, chunkSize: 1, escalateAfter: null };
const store = new GameEventStore(join(mkdtempSync(join(tmpdir(), "sentinel-game-")), "game-events.jsonl"));
const transport: GameTransport = { async execute() { return { completed: true, usage: { cost: 0.04 }, upstreamRaw: { usage: { cost: 0.04 }, messages: [{ content: "must never persist" }] } }; } };
const runner = new GameRoundRunner(season, store, transport, () => 0.15);
runner.fund(1);
const outcome = await runner.run("player-1", policy);
assert.equal(outcome.completed, true);
assert.equal(outcome.prizePendingUsd, 0.1);
assert.equal(store.snapshot(season).remainingUsd, 0.86, "settled spend and held prize reduce only the game pool");
const board = publicGameLedger(store, season);
assert.equal(JSON.stringify(board).includes("must never persist"), false, "prompt-like raw fields are stripped from public evidence");
await runner.grantPrize(outcome.runId, { async grant() { return { lifetimeAllocationUsd: 0.1, raw: { status: "ok" } }; } });
assert.equal(store.snapshot(season).playerAwardsUsd["player-1"], 0.1);
const second = await runner.run("player-1", policy);
assert.equal(second.prizePendingUsd, 0.1, "the remaining personal allocation is reservable");
const capped = await runner.run("player-1", policy);
assert.equal(capped.prizePendingUsd, 0, "pending prizes count toward the hard per-player ceiling");
await assert.rejects(() => runner.run("player-1", { ...policy, model: "unknown/model" }), /GAME_MODEL_REFUSED/);
const failing = new GameRoundRunner(season, store, { async execute() { throw new Error("gateway_down"); } }, () => 0.05);
const unbilled = await failing.run("player-2", policy);
assert.equal(unbilled.reason, "upstream_error");
assert.equal(store.snapshot(season).reservedUsd, 0, "upstream failures release the game reservation and never award a prize");

const requests: Array<{ url: string; method: string; body?: string }> = [];
const hosted = new HostedAllocationGateway(
  { baseUrl: "https://sentinel.example/", adminToken: "admin-test" },
  async (url, init) => {
    requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ tokens: [{ handle: "t-player", revoked_at: null, lifetime_allocation_usd: 0, lifetime_spent_usd: 0 }] }), { status: 200 });
    return new Response(JSON.stringify({ handle: "t-player", lifetime_allocation_usd: 0.1 }), { status: 200 });
  }
);
const granted = await hosted.grant({ playerId: "t-player", amountUsd: 0.1, reference: "run-1" });
assert.equal(granted.lifetimeAllocationUsd, 0.1);
assert.deepEqual(requests.map((request) => request.method), ["GET", "PATCH"]);
assert.equal(requests[1].body, '{"lifetimeAllocationUsd":0.1}', "real hosted route receives the new absolute allocation");
console.log("game foundation tests passed");
