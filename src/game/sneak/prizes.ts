/**
 * Prize runs: recorded, never paid.
 *
 * One prize run per player token per UTC day. A finished prize run writes a
 * pending prize to an append-only JSONL log next to the game's own event log;
 * a person pays it by hand. No wallet key lives on the server. The daily cap
 * is across all players, and both limits are rebuilt from the log at start,
 * so a restart or redeploy forgets neither.
 *
 * Prize amounts default to $0. The operator turns them on with:
 *   SENTINEL_SNEAK_PRIZE_FLAWLESS_USD        fooled 3 times, no life lost
 *   SENTINEL_SNEAK_PRIZE_ONE_LIFE_LOST_USD   fooled 3 times, one life lost
 *   SENTINEL_SNEAK_PRIZE_DAILY_CAP_USD       all pending prizes in a UTC day (default 5)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Outcome, RunEnd } from "./engine.js";

export interface SneakPrizeConfig {
  flawlessUsd: number;
  oneLifeLostUsd: number;
  dailyCapUsd: number;
}
export const DEFAULT_PRIZES: SneakPrizeConfig = { flawlessUsd: 0, oneLifeLostUsd: 0, dailyCapUsd: 5 };

function money(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : fallback;
}

export function prizeConfigFromEnv(env: NodeJS.ProcessEnv): SneakPrizeConfig {
  return {
    flawlessUsd: money(env.SENTINEL_SNEAK_PRIZE_FLAWLESS_USD, DEFAULT_PRIZES.flawlessUsd),
    oneLifeLostUsd: money(env.SENTINEL_SNEAK_PRIZE_ONE_LIFE_LOST_USD, DEFAULT_PRIZES.oneLifeLostUsd),
    dailyCapUsd: money(env.SENTINEL_SNEAK_PRIZE_DAILY_CAP_USD, DEFAULT_PRIZES.dailyCapUsd)
  };
}

export const prizesOn = (c: SneakPrizeConfig) => c.flawlessUsd > 0 || c.oneLifeLostUsd > 0;

export type SneakEventName = "SNEAK_PRIZE_RUN_STARTED" | "SNEAK_PRIZE_RUN_FINISHED" | "SNEAK_PRIZE_PENDING";
export interface SneakEvent {
  id: string;
  ts: string;
  event: SneakEventName;
  /** The UTC day the run started; the run counts against that day's limits. */
  day: string;
  runId: string;
  /** The player token's public handle. Never the token. */
  player: string;
  commitment?: string;
  outcome?: Outcome;
  fooled?: number;
  lives?: number;
  amountUsd?: number;
  reason?: string;
  reveal?: RunEnd["reveal"];
}

export type PrizeStatus = "pending" | "capped" | "cap_reached" | "prizes_off" | "no_prize";
export interface PrizeDecision { amountUsd: number; status: PrizeStatus }

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100) / 100;

export class SneakPrizeLog {
  private readonly started = new Set<string>(); // `${day}|${player}`
  private readonly pendingByDay = new Map<string, number>();
  private readonly finished = new Set<string>(); // runId

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) return;
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      const e = JSON.parse(line) as SneakEvent;
      if (e.event === "SNEAK_PRIZE_RUN_STARTED") this.started.add(`${e.day}|${e.player}`);
      if (e.event === "SNEAK_PRIZE_RUN_FINISHED") this.finished.add(e.runId);
      if (e.event === "SNEAK_PRIZE_PENDING") this.pendingByDay.set(e.day, cents((this.pendingByDay.get(e.day) ?? 0) + (e.amountUsd ?? 0)));
    }
  }

  private append(input: Omit<SneakEvent, "id" | "ts">): void {
    const event: SneakEvent = { id: randomUUID(), ts: new Date().toISOString(), ...input };
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  usedToday(player: string, day: string): boolean { return this.started.has(`${day}|${player}`); }
  pendingUsd(day: string): number { return this.pendingByDay.get(day) ?? 0; }

  /** Claims the player's one prize run for the day. False if it is already used. */
  start(player: string, day: string, runId: string, commitment: string): boolean {
    const key = `${day}|${player}`;
    if (this.started.has(key)) return false;
    this.started.add(key);
    this.append({ event: "SNEAK_PRIZE_RUN_STARTED", day, runId, player, commitment });
    return true;
  }

  /** Records the end of a prize run and, if it earned one, a pending prize under the daily cap. */
  finish(player: string, day: string, runId: string, end: RunEnd, config: SneakPrizeConfig): PrizeDecision {
    if (this.finished.has(runId)) throw new Error("SNEAK_RUN_ALREADY_FINISHED");
    this.finished.add(runId);
    const earned = end.outcome === "flawless" ? config.flawlessUsd : end.outcome === "one_life_lost" ? config.oneLifeLostUsd : 0;
    let decision: PrizeDecision;
    if (end.outcome === "other") decision = { amountUsd: 0, status: "no_prize" };
    else if (earned <= 0) decision = { amountUsd: 0, status: "prizes_off" };
    else {
      const room = cents(Math.max(0, config.dailyCapUsd - this.pendingUsd(day)));
      const amount = cents(Math.min(earned, room));
      decision = amount <= 0 ? { amountUsd: 0, status: "cap_reached" } : { amountUsd: amount, status: amount < earned ? "capped" : "pending" };
    }
    this.append({ event: "SNEAK_PRIZE_RUN_FINISHED", day, runId, player, outcome: end.outcome, fooled: end.fooled, lives: end.lives, reveal: end.reveal, amountUsd: decision.amountUsd, reason: decision.status });
    if (decision.amountUsd > 0) {
      this.pendingByDay.set(day, cents(this.pendingUsd(day) + decision.amountUsd));
      this.append({ event: "SNEAK_PRIZE_PENDING", day, runId, player, amountUsd: decision.amountUsd, reason: decision.status });
    }
    return decision;
  }
}
