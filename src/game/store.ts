import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { JsonObject, JsonValue } from "../orbio/types.js";
import type { GameEvent, GameEventName, GamePoolSnapshot, GamePolicy, GameSeason } from "./types.js";

const round = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

/**
 * Durable game state is an event stream rather than a mutable in-memory board.
 * The same volume that holds this file can survive a redeploy and reconstruct
 * every reservation, settlement and pending prize without trusting a cache.
 */
export class GameEventStore {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  append(input: Omit<GameEvent, "id" | "ts">): GameEvent {
    const event: GameEvent = { id: randomUUID(), ts: new Date().toISOString(), ...input };
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  all(seasonId?: string): GameEvent[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GameEvent)
      .filter((event) => seasonId === undefined || event.seasonId === seasonId);
  }

  snapshot(season: GameSeason): GamePoolSnapshot {
    let fundedUsd = 0;
    let reservedUsd = 0;
    let spentUsd = 0;
    let prizeHeldUsd = 0;
    const playerAwardsUsd: Record<string, number> = {};
    const pending = new Map<string, { playerId: string; amountUsd: number }>();

    for (const event of this.all(season.id)) {
      const amount = event.amountUsd ?? 0;
      if (event.event === "SEASON_FUNDED") fundedUsd = round(fundedUsd + amount);
      if (event.event === "GAME_COST_RESERVED") reservedUsd = round(reservedUsd + amount);
      if (event.event === "GAME_COST_SETTLED") { reservedUsd = round(Math.max(0, reservedUsd - Number(event.raw.reserved_usd ?? 0))); spentUsd = round(spentUsd + amount); }
      if (event.event === "GAME_COST_NOT_BILLED") reservedUsd = round(Math.max(0, reservedUsd - Number(event.raw.reserved_usd ?? 0)));
      if (event.event === "PRIZE_ALLOCATION_PENDING" && event.playerId) {
        pending.set(event.runId, { playerId: event.playerId, amountUsd: amount });
        prizeHeldUsd = round(prizeHeldUsd + amount);
        // A manual allocation is still money promised to this player. Count it
        // immediately so concurrent rounds cannot stack pending prizes beyond
        // the server-side per-player ceiling.
        playerAwardsUsd[event.playerId] = round((playerAwardsUsd[event.playerId] ?? 0) + amount);
      }
      if (event.event === "PRIZE_ALLOCATION_GRANTED") {
        const award = pending.get(event.runId);
        if (award) pending.delete(event.runId);
      }
    }
    // Pending prizes remain held. The pool may never be promised twice.
    return {
      fundedUsd,
      reservedUsd,
      spentUsd,
      prizeHeldUsd,
      remainingUsd: round(Math.max(0, fundedUsd - reservedUsd - spentUsd - prizeHeldUsd)),
      playerAwardsUsd
    };
  }
}

export const policyHash = (policy: GamePolicy): string =>
  createHash("sha256").update(JSON.stringify({ ...policy, model: policy.model.trim() })).digest("hex");

/** Raw upstream objects are public evidence. Request payload fields are never retained. */
export function providerEvidence(value: JsonObject): JsonObject {
  const forbidden = new Set(["prompt", "messages", "input", "instruction", "instructions"]);
  const walk = (item: JsonValue): JsonValue => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item)
        .filter(([key]) => !forbidden.has(key.toLowerCase()))
        .map(([key, child]) => [key, walk(child)])) as JsonObject;
    }
    return item;
  };
  return walk(value) as JsonObject;
}

export const gameEvent = (
  event: GameEventName,
  input: Omit<GameEvent, "id" | "ts" | "event">
): Omit<GameEvent, "id" | "ts"> => ({ event, ...input });
