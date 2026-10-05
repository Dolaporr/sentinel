/**
 * Prize runs: recorded, never paid.
 *
 * One prize run per player token per UTC day. A finished prize run writes a
 * pending prize to an append-only JSONL log next to the game's own event log;
 * a person pays it by hand. No wallet key lives on the server. The daily cap
 * is across all players, and both limits are rebuilt from the log at start,
 * so a restart or redeploy forgets neither.
 *
 * A winner adds a Robinhood Chain wallet to their pending prize (format and
 * EIP-55 checksum checked in wallet.ts). The operator lists pending prizes
 * with handle, amount and wallet, pays by hand, and marks each one paid, so a
 * prize is never paid twice and a paid prize's wallet can no longer change.
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

export type SneakEventName = "SNEAK_PRIZE_RUN_STARTED" | "SNEAK_PRIZE_RUN_FINISHED" | "SNEAK_PRIZE_PENDING" | "SNEAK_PRIZE_WALLET" | "SNEAK_PRIZE_PAID";
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
  wallet?: string;
  /** The operator's note when marking a prize paid, e.g. the transaction hash. */
  tx?: string;
}

/** One pending prize as the operator and its winner see it. */
export interface PrizeRecord {
  runId: string;
  player: string;
  day: string;
  amountUsd: number;
  status: Exclude<PrizeStatus, "cap_reached" | "prizes_off" | "no_prize">;
  wonAt: string;
  wallet: string | null;
  paidAt: string | null;
  tx: string | null;
}
export type ClaimResult = { ok: true; prize: PrizeRecord } | { ok: false; code: "prize_not_found" | "not_your_prize" | "already_paid" };
export type PaidResult = { ok: true; prize: PrizeRecord } | { ok: false; code: "prize_not_found" | "already_paid" | "no_wallet" };

export type PrizeStatus = "pending" | "capped" | "cap_reached" | "prizes_off" | "no_prize";
export interface PrizeDecision { amountUsd: number; status: PrizeStatus }

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100) / 100;

export class SneakPrizeLog {
  private readonly started = new Set<string>(); // `${day}|${player}`
  private readonly pendingByDay = new Map<string, number>();
  private readonly finished = new Set<string>(); // runId
  private readonly prizes = new Map<string, PrizeRecord>(); // runId -> prize, in the order won

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) return;
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      const e = JSON.parse(line) as SneakEvent;
      if (e.event === "SNEAK_PRIZE_RUN_STARTED") this.started.add(`${e.day}|${e.player}`);
      if (e.event === "SNEAK_PRIZE_RUN_FINISHED") this.finished.add(e.runId);
      this.apply(e);
    }
  }

  /** Folds the prize-facing events into the in-memory view; used on replay and on append. */
  private apply(e: SneakEvent): void {
    if (e.event === "SNEAK_PRIZE_PENDING") {
      this.pendingByDay.set(e.day, cents((this.pendingByDay.get(e.day) ?? 0) + (e.amountUsd ?? 0)));
      this.prizes.set(e.runId, { runId: e.runId, player: e.player, day: e.day, amountUsd: e.amountUsd ?? 0, status: e.reason === "capped" ? "capped" : "pending", wonAt: e.ts, wallet: null, paidAt: null, tx: null });
    }
    const prize = this.prizes.get(e.runId);
    if (!prize) return;
    if (e.event === "SNEAK_PRIZE_WALLET" && e.wallet) prize.wallet = e.wallet;
    if (e.event === "SNEAK_PRIZE_PAID") { prize.paidAt = e.ts; prize.tx = e.tx ?? null; }
  }

  private append(input: Omit<SneakEvent, "id" | "ts">): void {
    const event: SneakEvent = { id: randomUUID(), ts: new Date().toISOString(), ...input };
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    this.apply(event);
  }

  /** Every prize won, oldest first. */
  list(): PrizeRecord[] { return [...this.prizes.values()].map((p) => ({ ...p })); }
  prizesFor(player: string): PrizeRecord[] { return this.list().filter((p) => p.player === player); }

  /** The winner attaches or corrects their wallet, until the prize is paid. */
  setWallet(runId: string, player: string, wallet: string): ClaimResult {
    const prize = this.prizes.get(runId);
    if (!prize) return { ok: false, code: "prize_not_found" };
    if (prize.player !== player) return { ok: false, code: "not_your_prize" };
    if (prize.paidAt) return { ok: false, code: "already_paid" };
    this.append({ event: "SNEAK_PRIZE_WALLET", day: prize.day, runId, player, wallet });
    return { ok: true, prize: { ...(this.prizes.get(runId) as PrizeRecord) } };
  }

  /** The operator records a hand payment. Once only, and only to a wallet on file. */
  markPaid(runId: string, tx: string | null): PaidResult {
    const prize = this.prizes.get(runId);
    if (!prize) return { ok: false, code: "prize_not_found" };
    if (prize.paidAt) return { ok: false, code: "already_paid" };
    if (!prize.wallet) return { ok: false, code: "no_wallet" };
    this.append({ event: "SNEAK_PRIZE_PAID", day: prize.day, runId, player: prize.player, amountUsd: prize.amountUsd, wallet: prize.wallet, ...(tx ? { tx } : {}) });
    return { ok: true, prize: { ...(this.prizes.get(runId) as PrizeRecord) } };
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
    if (decision.amountUsd > 0) this.append({ event: "SNEAK_PRIZE_PENDING", day, runId, player, amountUsd: decision.amountUsd, reason: decision.status });
    return decision;
  }
}
