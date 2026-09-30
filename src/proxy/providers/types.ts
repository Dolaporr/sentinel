/**
 * The one seam SENTINEL_PROVIDERS.md draws: everything gateway-specific lives
 * behind this interface, and the governor -- which only ever reserves and
 * reconciles dollars -- never knows which provider is active. src/governor/
 * is untouched by this file and everything under providers/.
 */
import type { PriceEntry } from "../../governor/types.js";

export type ProviderName = "orbio" | "openrouter" | "openai";

export interface Provider {
  readonly name: ProviderName;

  /** Where a chat-completions request is dispatched. */
  readonly chatCompletionsUrl: string;

  /**
   * Where the live price table is fetched from at startup, or null when this
   * provider has no such endpoint and staticPrices is the only source.
   */
  readonly modelsUrl: string | null;

  /** Which env var holds this provider's key. */
  readonly apiKeyEnvVar: string;

  /**
   * Used when modelsUrl is null, or as the last-resort fallback in the same
   * fetch-gateway -> last-known-cache -> static chain every provider already
   * follows (see resolvePriceTable in ../prices.ts, which this does not change).
   */
  readonly staticPrices: Readonly<Record<string, PriceEntry>>;

  /** Header(s) this provider expects its key in. Not every provider uses `Authorization: Bearer`. */
  authHeaders(apiKey: string): Record<string, string>;

  /**
   * Whether this provider's completions carry a real, billed cost at all --
   * a category fact about the provider, stated on the banner before a single
   * call has happened, not something derived per-response. "exact" means
   * readExactCostUsd succeeds on a normal call; "estimated" means it never
   * will, and every settled call here is Sentinel's own arithmetic against
   * this provider's price table, not the provider's invoice.
   */
  readonly costReporting: "exact" | "estimated";

  /**
   * A genuine, provider-reported cost for this call, read from the parsed
   * response's own `usage` object -- or null if this provider did not report
   * one. Returning null is not a failure case to work around: it means "let
   * the existing missing-cost path handle this," which already commits an
   * honest estimate from the reservation's own price entry and labels it
   * cost_source: "estimated". This method must never compute or invent a
   * number itself -- only ever read one the provider actually sent. That
   * distinction (never blur "exact" to mean "our arithmetic") is the whole
   * point of cost_source, and it does not get relaxed here to make a table
   * look tidier.
   */
  readExactCostUsd(usage: Record<string, unknown> | undefined): number | null;
}
