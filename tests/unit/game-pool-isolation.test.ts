import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameRoundRunner } from "../../src/game/round-runner.js";
import { GameEventStore } from "../../src/game/store.js";
import type { GamePolicy, GameSeason } from "../../src/game/types.js";
import { HostedStateStore, type HostedConfig } from "../../src/proxy/hosted/state.js";

const root = mkdtempSync(join(tmpdir(), "sentinel-game-isolation-"));
const config: HostedConfig = {
  poolDailyCapUsd: 5, tokenDailyCapUsd: 0.25, modelAllowlist: ["openai/gpt-4.1-mini"], requestsPerMinute: 20, paused: false, operatorFaultPauseAfter: 3
};
const hosted = new HostedStateStore(join(root, "hosted", "state.json"), config, () => new Date("2026-10-01T00:00:00.000Z"));
const season: GameSeason = { id: "season-isolation", poolUsd: 0.10, perPlayerCeilingUsd: 0, prizePerWinUsd: 0, allowedModels: ["openai/gpt-4.1-mini"], active: true };
const store = new GameEventStore(join(root, "game", "events.jsonl"));
const runner = new GameRoundRunner(season, store, {
  async execute() { return { completed: true, usage: { cost: 0.04 }, upstreamRaw: { usage: { cost: 0.04 } } }; }
}, () => 0.08);
const policy: GamePolicy = { model: "openai/gpt-4.1-mini", maxTokens: 32, retryLimit: 0, chunkSize: 1, escalateAfter: null };

runner.fund(0.10);
await runner.run("game-player", policy);
assert.equal(store.snapshot(season).remainingUsd, 0.06, "a game round consumes the game season pool");
assert.equal(hosted.today().poolCommittedUsd, 0, "a drained game pool never debits the hosted free-tier pool");

const gameRemainingBeforeFreeTierSpend = store.snapshot(season).remainingUsd;
hosted.recordSpend("free-tier-token", 4.99);
assert.equal(hosted.today().poolCommittedUsd, 4.99, "the hosted free-tier pool can settle independently");
assert.equal(store.snapshot(season).remainingUsd, gameRemainingBeforeFreeTierSpend, "a drained free-tier pool never touches the game season pool");
console.log("game pool isolation tests passed");
