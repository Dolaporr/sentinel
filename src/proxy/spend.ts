import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DailySpendRecord { date: string; committedUsd: number }

const round = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

/**
 * Local calendar date, not UTC. The cap exists so a person can say "my $5 a
 * day", and their day is the one outside their window.
 */
export function localDateKey(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Survives the process, so a restart cannot hand back a fresh budget.
 *
 * The in-memory governor starts every process at $0 committed, which is the
 * adversarial corpus's "governor cap resets on restart": anyone who restarts
 * after being refused gets their full budget again, and the cap stops being a
 * cap. This file is the part that remembers.
 *
 * It is a rolling daily window, not a cumulative-forever total: a record from a
 * previous date is not carried forward, it is replaced.
 */
export class DailySpendStore {
  constructor(private readonly filePath: string, private readonly clock: () => Date = () => new Date()) {}

  /** Today's committed total, or zero if the stored record is from another day. */
  load(): DailySpendRecord {
    const today = localDateKey(this.clock());
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as { date?: unknown; committed_usd?: unknown };
      const committed = Number(parsed.committed_usd);
      if (parsed.date === today && Number.isFinite(committed) && committed >= 0) {
        return { date: today, committedUsd: round(committed) };
      }
    } catch { /* missing, unreadable or malformed: today starts at zero */ }
    return { date: today, committedUsd: 0 };
  }

  /** Rewritten on every commit, so a crash loses at most the call in flight. */
  record(committedUsd: number): DailySpendRecord {
    const entry: DailySpendRecord = { date: localDateKey(this.clock()), committedUsd: round(Math.max(0, committedUsd)) };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, `${JSON.stringify({ date: entry.date, committed_usd: entry.committedUsd }, null, 2)}\n`, "utf8");
    } catch (error) {
      // Losing durability silently would turn the cap back into a per-process
      // one without anyone noticing, so it is loud.
      console.error(`[spend] FAILED to persist the daily total to ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return entry;
  }
}

export interface DailyBudget {
  /** Spend already committed today, loaded from disk. */
  seededUsd: number;
  /** What remains of the cap. Zero or negative once the cap is met. */
  capRemainingUsd: number;
  capExceeded: boolean;
  /** What the governor is constructed with. Never non-positive. */
  budgetUsd: number;
  date: string;
}

/**
 * Turns today's stored total into the governor's budget.
 *
 * The governor knows nothing about days or restarts; it is handed a budget and
 * starts at zero. Giving it `cap - spent_today` is what makes the daily ceiling
 * durable without touching src/governor/.
 */
export function resolveDailyBudget(input: { store: DailySpendStore; dailyCapUsd: number; ceilingUsd: number }): DailyBudget {
  const today = input.store.load();
  const capRemainingUsd = Math.round((input.dailyCapUsd - today.committedUsd) * 1_000_000_000) / 1_000_000_000;
  const capExceeded = capRemainingUsd <= 0;
  return {
    seededUsd: today.committedUsd,
    capRemainingUsd,
    capExceeded,
    // The governor rejects a non-positive budget; when the cap is met every
    // request is refused before it reaches the governor anyway.
    budgetUsd: capExceeded ? 1e-9 : Math.min(input.ceilingUsd, capRemainingUsd),
    date: today.date
  };
}
