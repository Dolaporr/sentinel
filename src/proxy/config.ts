import { RESERVATION_SAFETY_MULTIPLIER, SESSION_CEILING_USD } from "./mission-constants.js";
import type { PriceEntry } from "../governor/types.js";
import { DEFAULT_PROVIDER_NAME, resolveProvider } from "./providers/registry.js";
import type { Provider } from "./providers/types.js";

/**
 * Loopback only, and deliberately not configurable. The proxy holds the real
 * gateway key; binding it to another interface would offer that key's spending
 * power to the network. See docs/PROXY.md.
 */
export const BIND_HOST = "127.0.0.1";

/**
 * SENTINEL_PROVIDER selects one of orbio | openrouter | openai (see
 * src/proxy/providers/). Unset behaves exactly as before this existed:
 * Orbio, unchanged. An unrecognised name fails closed at startup, the same
 * way an unpriced model fails closed at admission -- never a silent default.
 */
export const PROVIDER_NAME = process.env.SENTINEL_PROVIDER ?? DEFAULT_PROVIDER_NAME;
export const PROVIDER: Provider = resolveProvider(PROVIDER_NAME);

/**
 * Overridable only so the streaming and refusal paths can be exercised against a
 * local stub without a live key. It defaults to the active provider's own
 * endpoint; point it anywhere else and you are no longer testing that provider.
 */
export const UPSTREAM_URL = process.env.SENTINEL_PROXY_UPSTREAM ?? PROVIDER.chatCompletionsUrl;

/**
 * The price table's source. Derived from the provider so both track one host,
 * unless the provider has no such endpoint at all (modelsUrl: null), in which
 * case there is nothing to derive and resolvePriceTable goes straight to its
 * cache-then-static fallback.
 */
export const MODELS_URL = process.env.SENTINEL_PROXY_MODELS_URL ?? PROVIDER.modelsUrl;

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
  /**
   * Per-call, agent-attributed record the ledger view reads. On by default,
   * unlike ledgerPath above: a page whose entire point is showing what
   * happened needs something to read out of the box, not an env var nobody
   * sets. See src/proxy/call-ledger.ts for why this is a separate file from
   * the governor's own ledger rather than a reader built on top of it.
   */
  callLedgerPath: string;
  /** Where the live price table is fetched from at startup, or null if this provider has none. */
  modelsUrl: string | null;
  /** The active provider: dispatch URL, auth shape, and cost read-back. See src/proxy/providers/. */
  provider: Provider;
  /** Last known good price table, used when the gateway fetch fails. */
  priceCachePath: string;
  /** Provenance of `prices`, surfaced on /healthz. Set once the table resolves. */
  priceSource?: string;
  priceVerifiedAt?: string;
  /** Gateway ids that cannot be bounded per token, so a refusal can say why. */
  unboundableModels?: ReadonlySet<string>;
  /** The rolling daily ceiling. Survives restarts via spendPath. */
  dailyCapUsd: number;
  spendPath: string;
  /** Spend already committed today when this process started. */
  seededSpendUsd?: number;
  /** True when today's total already met the cap before this process started. */
  capExceeded?: boolean;
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
    // Defaults to the daily cap: the cap is the real control for a proxy serving
    // an interactive tool. Set it lower to bound a single proxy run more tightly.
    budgetUsd: int("SENTINEL_PROXY_BUDGET_USD", int("SENTINEL_PROXY_DAILY_CAP_USD", SESSION_CEILING_USD)),
    dailyCapUsd: int("SENTINEL_PROXY_DAILY_CAP_USD", SESSION_CEILING_USD),
    spendPath: process.env.SENTINEL_PROXY_SPEND ?? ".cache/spend.json",
    // Generous next to the mission runner's 30s: a proxied request is driven by an
    // interactive tool, and an expired reservation would land a late result in the
    // governor's LATE_RESULT_REJECTED path and quarantine admissions.
    reservationTtlMs: int("SENTINEL_PROXY_RESERVATION_TTL_MS", 120_000),
    reservationSafetyMultiplier: RESERVATION_SAFETY_MULTIPLIER,
    maxStepBudgetFraction: 1,
    prices: PROVIDER.staticPrices,
    defaultMaxTokens: int("SENTINEL_PROXY_DEFAULT_MAX_TOKENS", 1_024),
    apiKey: resolveApiKey(),
    ledgerPath: process.env.SENTINEL_PROXY_LEDGER,
    callLedgerPath: process.env.SENTINEL_PROXY_CALL_LEDGER ?? ".cache/calls.jsonl",
    modelsUrl: MODELS_URL,
    provider: PROVIDER,
    priceCachePath: process.env.SENTINEL_PROXY_PRICE_CACHE ?? ".cache/price-table.json"
  };
}

/**
 * ORBIO_API_KEY was, historically, also readable from OPENROUTER_API_KEY --
 * an alias from before the provider name was settled on. Once a provider is
 * explicitly selected, that alias would be a real hazard: someone setting
 * SENTINEL_PROVIDER=openrouter with their own OPENROUTER_API_KEY expects it
 * to mean the OpenRouter provider's key, not a stand-in for Orbio's. So the
 * alias survives only while the active provider is (or defaults to) orbio;
 * every other provider reads its own env var and nothing else.
 */
export function resolveApiKey(): string | undefined {
  const own = process.env[PROVIDER.apiKeyEnvVar];
  if (own) return own;
  if (PROVIDER_NAME === "orbio") return process.env.OPENROUTER_API_KEY;
  return undefined;
}
