import type { GameEvent, GameSeason } from "./types.js";
import { GameEventStore } from "./store.js";

/** The board reads only the durable game stream. No prompt or private token crosses this boundary. */
export function publicGameLedger(store: GameEventStore, season: GameSeason): {
  pool: ReturnType<GameEventStore["snapshot"]>;
  events: Array<Pick<GameEvent, "id" | "ts" | "event" | "runId" | "playerId" | "amountUsd" | "reason" | "policyHash" | "raw">>;
} {
  return {
    pool: store.snapshot(season),
    events: store.all(season.id).map(({ id, ts, event, runId, playerId, amountUsd, reason, policyHash, raw }) => ({ id, ts, event, runId, playerId, amountUsd, reason, policyHash, raw }))
  };
}
