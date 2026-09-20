import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PriceEntry } from "../governor/types.js";
import { prices as staticPrices } from "../runner/d2-mission.js";

export type PriceSource = "gateway" | "cache" | "static";

export interface PriceTable {
  prices: Readonly<Record<string, PriceEntry>>;
  source: PriceSource;
  verifiedAt: string;
  modelCount: number;
  /** Models the gateway listed but we refused to price. See rejectReasons. */
  skipped: number;
  note: string;
}

interface GatewayModel { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }

/**
 * Per-token prices are tiny decimals, so scaling to per-million reintroduces
 * binary float error: 0.0000004 * 1e6 is 0.39999999999999997, not 0.4. Left
 * unrounded that shows up as drift against a table that has not actually moved,
 * and a drift warning that fires every startup is one nobody reads. Nine places
 * matches the rounding the governor already uses on money.
 */
const roundPrice = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

/**
 * A price is usable only if both legs parse and the *output* leg is positive.
 *
 * A zero output price makes `max_tokens x outputPrice` zero, so the worst case
 * collapses to the input leg and every admission check for that model passes
 * against a bound that cannot bind. The gateway lists ~174 such models: free
 * tiers, and media models (video edit, transcription) that bill per second or
 * per asset rather than per token. Admitting those against a $0 ceiling is
 * exactly the systematic miscalibration described in adversarial finding 06,
 * and SENTINEL_D2_RUNNER.md 2.3 forbids a zero-cost default outright. They are
 * left out of the table, so the governor refuses them as MODEL_UNPRICED.
 */
function toPriceEntry(model: GatewayModel, verifiedAt: string): [string, PriceEntry] | null {
  if (typeof model.id !== "string" || !model.id) return null;
  const input = Number(model.pricing?.prompt);
  const output = Number(model.pricing?.completion);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (input < 0 || output <= 0) return null;
  return [model.id, { inputPerMillionUsd: roundPrice(input * 1_000_000), outputPerMillionUsd: roundPrice(output * 1_000_000), verifiedAt }];
}

export function parseModelsResponse(payload: unknown, verifiedAt: string): { prices: Record<string, PriceEntry>; skipped: number } {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error("models response has no `data` array");
  const prices: Record<string, PriceEntry> = {};
  let skipped = 0;
  for (const model of data) {
    const entry = toPriceEntry(model as GatewayModel, verifiedAt);
    if (entry) prices[entry[0]] = entry[1];
    else skipped++;
  }
  if (Object.keys(prices).length === 0) throw new Error("models response yielded no usable prices");
  return { prices, skipped };
}

/**
 * Compares a freshly fetched table against the hardcoded one. Silent drift here
 * is finding 06's failure: every admission check passes cleanly while being
 * computed against the wrong number. Cheap to check, so we always check.
 */
export function priceDrift(fetched: Readonly<Record<string, PriceEntry>>): string[] {
  const drift: string[] = [];
  for (const [model, known] of Object.entries(staticPrices)) {
    const live = fetched[model];
    if (!live) { drift.push(`${model}: absent from the gateway's list (hardcoded ${known.inputPerMillionUsd}/${known.outputPerMillionUsd} per M)`); continue; }
    if (live.inputPerMillionUsd !== known.inputPerMillionUsd || live.outputPerMillionUsd !== known.outputPerMillionUsd) {
      drift.push(`${model}: gateway ${live.inputPerMillionUsd}/${live.outputPerMillionUsd} vs hardcoded ${known.inputPerMillionUsd}/${known.outputPerMillionUsd} per M`);
    }
  }
  return drift;
}

function readCache(path: string): PriceTable | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { prices?: Record<string, PriceEntry>; verifiedAt?: string };
    if (!parsed.prices || Object.keys(parsed.prices).length === 0) return null;
    return {
      prices: parsed.prices,
      source: "cache",
      verifiedAt: parsed.verifiedAt ?? "unknown",
      modelCount: Object.keys(parsed.prices).length,
      skipped: 0,
      note: `last known good table cached at ${parsed.verifiedAt ?? "unknown"}`
    };
  } catch { return null; }
}

function writeCache(path: string, table: PriceTable): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ verifiedAt: table.verifiedAt, prices: table.prices }, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(`[prices] could not write cache ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resolves the price table at startup: the live gateway first, then the last
 * known good cache, then the hardcoded table. The table is held for the life of
 * the process; it is never re-fetched per request.
 */
export async function resolvePriceTable(options: { modelsUrl: string; cachePath: string; timeoutMs?: number }): Promise<PriceTable> {
  const verifiedAt = new Date().toISOString();
  try {
    const response = await fetch(options.modelsUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { prices, skipped } = parseModelsResponse(await response.json(), verifiedAt);
    const table: PriceTable = {
      prices, source: "gateway", verifiedAt,
      modelCount: Object.keys(prices).length, skipped,
      note: `fetched from ${options.modelsUrl}`
    };
    writeCache(options.cachePath, table);
    return table;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[prices] gateway fetch failed (${reason}); falling back.`);
    const cached = readCache(options.cachePath);
    if (cached) return cached;
    return {
      prices: staticPrices,
      source: "static",
      verifiedAt: Object.values(staticPrices)[0]?.verifiedAt ?? "unknown",
      modelCount: Object.keys(staticPrices).length,
      skipped: 0,
      note: `hardcoded fallback after: ${reason}`
    };
  }
}
