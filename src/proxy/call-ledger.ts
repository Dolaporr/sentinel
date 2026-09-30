/**
 * A per-call, agent-attributed record, written by the proxy alongside its
 * existing calls into BudgetGovernor -- not a replacement for it.
 *
 * The frozen governor ledger (src/governor/ledger.ts) cannot carry this: its
 * event shape is fixed by src/governor/types.ts, RESERVATION_CREATED carries
 * `model` but COST_COMMITTED does not, refusal events never construct a
 * Reservation at all, and neither has any field for an agent label. Building
 * "by agent" and "by model" views by joining those events after the fact would
 * mean correlating several inconsistent shapes by attempt_id on every read.
 * This ledger instead records, once per resolved request, exactly the row the
 * views need -- computed from data src/proxy/server.ts already holds at each
 * decision point, not from anything new. src/governor/ itself is untouched.
 *
 * Metadata only, by construction: every field below is a model id, a token or
 * dollar count, a timestamp, a boolean, or a reason drawn from a fixed
 * vocabulary. Nothing here is, or is derived from, request or response body
 * content -- see docs/PROXY.md's "What this ledger stores" for the audit.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { localDateKey } from "./spend.js";

export interface CallLedgerEntry {
  ts: string;
  attempt_id: string;
  agent: string;
  model: string;
  admitted: boolean;
  /** Set only when admitted and settled; null for a refusal or a still-open call. */
  cost_usd: number | null;
  cost_source: "exact" | "estimated" | null;
  /** Set only when !admitted. AdmissionRefusalReason, or a proxy-level refusal code. */
  refusal_reason: string | null;
  /** The worst case reserved (admitted) or that would have been reserved (refused). Null when unpriced. */
  worst_case_usd: number | null;
  /** Remaining budget immediately after this call resolved -- the refusal view's "what was left". */
  budget_remaining_usd: number;
  streaming: boolean;
}

const round = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

export class CallLedger {
  constructor(private readonly filePath: string) {}

  /**
   * Called once per resolved request, after the response is already sent or
   * ending -- never on the path that decides admission or dispatch. A single
   * JSON line appended synchronously, matching the write pattern every other
   * durable store in src/proxy/ already uses (spend.ts, prices.ts); a slow
   * disk here delays this write, never the client's response.
   */
  record(entry: Omit<CallLedgerEntry, "ts">): void {
    const full: CallLedgerEntry = { ts: new Date().toISOString(), ...entry };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(full)}\n`, "utf8");
    } catch (error) {
      // Losing a call record silently would make the ledger quietly incomplete
      // rather than visibly broken, so a failure here is loud.
      console.error(`[ledger] FAILED to persist a call record to ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Every entry whose timestamp falls on today's local date -- the same day
   * boundary the daily cap itself resets on (spend.ts's localDateKey), so the
   * page and the budget it explains never disagree about what "today" means.
   * A missing or corrupt file reads as no history, not an error: a fresh
   * install has nothing to show yet, and one bad line does not lose the rest.
   */
  readToday(now: Date = new Date()): CallLedgerEntry[] {
    const today = localDateKey(now);
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }
    const entries: CallLedgerEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as CallLedgerEntry;
        if (typeof parsed.ts === "string" && localDateKey(new Date(parsed.ts)) === today) entries.push(parsed);
      } catch {
        /* one corrupt line does not lose the rest of the day */
      }
    }
    return entries;
  }
}

export interface TodaySummary {
  spentUsd: number;
  budgetUsd: number;
  exactUsd: number;
  estimatedUsd: number;
  callsMade: number;
  callsRefused: number;
}

/** Only settled (admitted, cost known) calls count toward "calls made" and spend here. */
export function summarizeToday(entries: readonly CallLedgerEntry[], budgetUsd: number): TodaySummary {
  let exactUsd = 0;
  let estimatedUsd = 0;
  let callsMade = 0;
  let callsRefused = 0;
  for (const entry of entries) {
    if (!entry.admitted) { callsRefused++; continue; }
    if (entry.cost_usd === null) continue; // admitted but not yet settled
    callsMade++;
    if (entry.cost_source === "exact") exactUsd = round(exactUsd + entry.cost_usd);
    else estimatedUsd = round(estimatedUsd + entry.cost_usd);
  }
  return { spentUsd: round(exactUsd + estimatedUsd), budgetUsd, exactUsd, estimatedUsd, callsMade, callsRefused };
}

export interface BreakdownRow {
  key: string;
  calls: number;
  spendUsd: number;
  avgUsd: number;
  shareOfToday: number;
}

/** Shared by "by agent" and "by model": same shape, different grouping key. */
function aggregateBy(entries: readonly CallLedgerEntry[], keyOf: (entry: CallLedgerEntry) => string): BreakdownRow[] {
  const totals = new Map<string, { calls: number; spendUsd: number }>();
  let grandTotal = 0;
  for (const entry of entries) {
    if (!entry.admitted || entry.cost_usd === null) continue;
    const key = keyOf(entry);
    const row = totals.get(key) ?? { calls: 0, spendUsd: 0 };
    row.calls += 1;
    row.spendUsd = round(row.spendUsd + entry.cost_usd);
    totals.set(key, row);
    grandTotal = round(grandTotal + entry.cost_usd);
  }
  return [...totals.entries()]
    .map(([key, { calls, spendUsd }]) => ({
      key,
      calls,
      spendUsd,
      avgUsd: calls > 0 ? round(spendUsd / calls) : 0,
      shareOfToday: grandTotal > 0 ? round(spendUsd / grandTotal) : 0
    }))
    .sort((a, b) => b.spendUsd - a.spendUsd);
}

export const aggregateByAgent = (entries: readonly CallLedgerEntry[]): BreakdownRow[] =>
  aggregateBy(entries, (entry) => entry.agent);

export const aggregateByModel = (entries: readonly CallLedgerEntry[]): BreakdownRow[] =>
  aggregateBy(entries, (entry) => entry.model);

export interface RefusalRow {
  ts: string;
  agent: string;
  model: string;
  worstCaseUsd: number | null;
  remainingUsd: number;
  reason: string;
}

/** Newest first: the most recent refusal is the one someone just watched happen. */
export function listRefusals(entries: readonly CallLedgerEntry[]): RefusalRow[] {
  return entries
    .filter((entry) => !entry.admitted)
    .map((entry) => ({
      ts: entry.ts,
      agent: entry.agent,
      model: entry.model,
      worstCaseUsd: entry.worst_case_usd,
      remainingUsd: entry.budget_remaining_usd,
      reason: entry.refusal_reason ?? "unknown"
    }))
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

export interface MostExpensiveCall {
  ts: string;
  agent: string;
  model: string;
  costUsd: number;
}

export function mostExpensiveCall(entries: readonly CallLedgerEntry[]): MostExpensiveCall | null {
  let best: MostExpensiveCall | null = null;
  for (const entry of entries) {
    if (!entry.admitted || entry.cost_usd === null) continue;
    if (!best || entry.cost_usd > best.costUsd) {
      best = { ts: entry.ts, agent: entry.agent, model: entry.model, costUsd: entry.cost_usd };
    }
  }
  return best;
}

export interface SparklinePoint { ts: string; cumulativeUsd: number }

/** Cumulative spend over the day, in call order -- the one chart §4 allows. */
export function spendSparkline(entries: readonly CallLedgerEntry[]): SparklinePoint[] {
  const settled = entries
    .filter((entry) => entry.admitted && entry.cost_usd !== null)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  let running = 0;
  return settled.map((entry) => {
    running = round(running + (entry.cost_usd ?? 0));
    return { ts: entry.ts, cumulativeUsd: running };
  });
}

export interface LedgerViewModel {
  generatedAt: string;
  date: string;
  today: TodaySummary;
  byAgent: BreakdownRow[];
  byModel: BreakdownRow[];
  refusals: RefusalRow[];
  mostExpensiveCall: MostExpensiveCall | null;
  sparkline: SparklinePoint[];
  /** Drives the empty state: a fresh install with no traffic explains itself. */
  hasAnyTraffic: boolean;
}

/**
 * Everything the page renders, computed once per request from today's
 * entries. The page itself does no aggregation -- it fetches this and renders
 * it, so the logic worth getting right lives here where it can be tested,
 * not duplicated in client-side JS.
 */
export function buildLedgerViewModel(entries: readonly CallLedgerEntry[], budgetUsd: number, now: Date = new Date()): LedgerViewModel {
  return {
    generatedAt: now.toISOString(),
    date: localDateKey(now),
    today: summarizeToday(entries, budgetUsd),
    byAgent: aggregateByAgent(entries),
    byModel: aggregateByModel(entries),
    refusals: listRefusals(entries),
    mostExpensiveCall: mostExpensiveCall(entries),
    sparkline: spendSparkline(entries),
    hasAnyTraffic: entries.length > 0
  };
}
