import { MISSION_BUDGET_USD, RESERVATION_SAFETY_MULTIPLIER, prices } from "../runner/d2-mission.js";
import type { PriceEntry } from "../governor/types.js";

/**
 * §2 step 5: always the www host. The apex `orbio.so` answers a POST with a 308,
 * and a redirected POST loses its body. Verified 2026-09-20: apex returns 308 to
 * www, and www preserves the Authorization header (a bogus key is rejected as
 * `invalid_api_key`, not `missing_api_key`, so the header survives the hop).
 */
export const DEFAULT_UPSTREAM_URL = "https://www.orbio.so/api/v1/chat/completions";

/**
 * Overridable only so the streaming and refusal paths can be exercised against a
 * local stub without a live key. It defaults to the www host above; point it
 * anywhere else and you are no longer testing the real gateway.
 */
export const UPSTREAM_URL = process.env.SENTINEL_PROXY_UPSTREAM ?? DEFAULT_UPSTREAM_URL;

/** The price table's source. Derived from the upstream so both track one host. */
export const MODELS_URL = process.env.SENTINEL_PROXY_MODELS_URL ?? UPSTREAM_URL.replace(/\/chat\/completions$/, "/models");

export interface ProxyConfig {
  port: number;
  budgetUsd: number;
  reservationTtlMs: number;
  reservationSafetyMultiplier: number;
  maxStepBudgetFraction: number;
  prices: Readonly<Record<string, PriceEntry>>;
  /**
   * §2 step 3: a request that arrives without max_tokens has no knowable worst
   * case, which makes its reservation meaningless. We inject this ceiling and
   * forward it upstream, so the bound we reserved against is the bound the
   * gateway is actually held to.
   */
  defaultMaxTokens: number;
  apiKey: string | undefined;
  ledgerPath: string | undefined;
  /** Where the live price table is fetched from at startup. */
  modelsUrl: string;
  /** Last known good price table, used when the gateway fetch fails. */
  priceCachePath: string;
  /** Provenance of `prices`, surfaced on /healthz. Set once the table resolves. */
  priceSource?: string;
  priceVerifiedAt?: string;
}

const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number, got ${raw}.`);
  return parsed;
};

export function loadConfig(): ProxyConfig {
  return {
    port: int("SENTINEL_PROXY_PORT", 8787),
    budgetUsd: int("SENTINEL_PROXY_BUDGET_USD", MISSION_BUDGET_USD),
    // Generous next to the mission runner's 30s: a proxied request is driven by an
    // interactive tool, and an expired reservation would land a late result in the
    // governor's LATE_RESULT_REJECTED path and quarantine admissions.
    reservationTtlMs: int("SENTINEL_PROXY_RESERVATION_TTL_MS", 120_000),
    reservationSafetyMultiplier: RESERVATION_SAFETY_MULTIPLIER,
    maxStepBudgetFraction: 1,
    prices,
    defaultMaxTokens: int("SENTINEL_PROXY_DEFAULT_MAX_TOKENS", 1_024),
    apiKey: process.env.ORBIO_API_KEY ?? process.env.OPENROUTER_API_KEY,
    ledgerPath: process.env.SENTINEL_PROXY_LEDGER,
    modelsUrl: MODELS_URL,
    priceCachePath: process.env.SENTINEL_PROXY_PRICE_CACHE ?? ".cache/price-table.json"
  };
}
