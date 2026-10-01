/**
 * Startup for the hosted service. Every check here fails closed: a missing
 * admin secret, upstream key or data directory stops the process before it
 * listens, rather than starting in a state that cannot be governed.
 */
import { join } from "node:path";
import { RESERVATION_SAFETY_MULTIPLIER } from "../mission-constants.js";
import { resolvePriceTable } from "../prices.js";
import { resolveProvider } from "../providers/registry.js";
import { redact } from "../dispatch.js";
import { TOKEN_PREFIX } from "./secrets.js";
import { HostedGateway } from "./server.js";
import type { HostedConfig } from "./state.js";
import { createHostedGameRoutes } from "../../game/hosted-routes.js";

export class HostedStartupError extends Error {}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new HostedStartupError(`${name} must be a positive number, got "${raw}".`);
  return parsed;
}

export async function main(): Promise<void> {
  const provider = resolveProvider(process.env.SENTINEL_PROVIDER ?? "orbio");

  // Read from the provider's own variable and nothing else: no fallbacks, no
  // aliases. This value goes into the upstream Authorization header and is
  // never written, logged or returned (see docs/HOSTED.md, "Key custody").
  const apiKey = process.env[provider.apiKeyEnvVar];
  if (!apiKey) throw new HostedStartupError(`${provider.apiKeyEnvVar} is not set. The hosted service spends against the operator's key and will not start without it.`);

  const adminToken = process.env.SENTINEL_HOSTED_ADMIN_TOKEN ?? "";
  if (adminToken.length < 32) throw new HostedStartupError("SENTINEL_HOSTED_ADMIN_TOKEN must be set to a random secret of at least 32 characters (e.g. `openssl rand -base64 32`).");
  if (adminToken.startsWith(TOKEN_PREFIX)) throw new HostedStartupError(`SENTINEL_HOSTED_ADMIN_TOKEN must not start with "${TOKEN_PREFIX}": that prefix is reserved for user tokens, which can never open admin routes.`);
  if (adminToken === apiKey) throw new HostedStartupError("SENTINEL_HOSTED_ADMIN_TOKEN must not be the upstream key.");

  // No default on purpose. Tokens, revocations and today's spend live here; on
  // Railway this must be a mounted volume, or every redeploy un-revokes every
  // token and hands every one a fresh budget. Making it explicit forces that
  // decision to be made rather than defaulted past.
  const dataDir = process.env.SENTINEL_HOSTED_DATA_DIR;
  if (!dataDir) throw new HostedStartupError("SENTINEL_HOSTED_DATA_DIR is not set. Point it at persistent storage (on Railway, a mounted volume such as /data).");

  const seedConfig: HostedConfig = {
    poolDailyCapUsd: num("SENTINEL_HOSTED_POOL_DAILY_USD", 5),
    tokenDailyCapUsd: num("SENTINEL_HOSTED_TOKEN_DAILY_USD", 0.25),
    modelAllowlist: (process.env.SENTINEL_HOSTED_MODELS ?? "openai/gpt-4.1-mini").split(",").map((s) => s.trim()).filter(Boolean),
    requestsPerMinute: Math.floor(num("SENTINEL_HOSTED_RPM", 20)),
    paused: false,
    operatorFaultPauseAfter: Math.floor(num("SENTINEL_HOSTED_OPERATOR_FAULT_PAUSE_AFTER", 3))
  };

  const table = await resolvePriceTable({
    modelsUrl: process.env.SENTINEL_HOSTED_MODELS_URL ?? provider.modelsUrl,
    cachePath: join(dataDir, "price-table.json"),
    staticPrices: provider.staticPrices
  });
  console.log(`[prices] ${table.modelCount} models from ${table.source}${table.source === "gateway" ? "" : ` (${table.note})`}`);

  const gateway = new HostedGateway({
    port: num("PORT", num("SENTINEL_HOSTED_PORT", 8080)),
    host: "::",
    provider,
    upstreamUrl: process.env.SENTINEL_HOSTED_UPSTREAM ?? provider.chatCompletionsUrl,
    apiKey,
    adminToken,
    prices: table.prices,
    priceSource: table.source,
    priceVerifiedAt: table.verifiedAt,
    unboundableModels: table.unboundable,
    statePath: join(dataDir, "hosted-state.json"),
    callLedgerPath: join(dataDir, "calls.jsonl"),
    seedConfig,
    reservationTtlMs: num("SENTINEL_HOSTED_RESERVATION_TTL_MS", 120_000),
    reservationSafetyMultiplier: RESERVATION_SAFETY_MULTIPLIER,
    defaultMaxTokens: Math.floor(num("SENTINEL_HOSTED_DEFAULT_MAX_TOKENS", 1_024))
  });

  // Opt-in only: without this exact flag the hosted request surface is
  // unchanged. The game has its own event store and pool, and dispatches via
  // the same redacting custody path as hosted completions.
  if (process.env.SENTINEL_GAME_ENABLED === "1") {
    gateway.mountGameRoutes(createHostedGameRoutes({
      dataPath: join(dataDir, "game-events.jsonl"), apiKey, provider,
      upstreamUrl: process.env.SENTINEL_HOSTED_UPSTREAM ?? provider.chatCompletionsUrl,
      prices: table.prices, store: gateway.store,
      reservationTtlMs: num("SENTINEL_HOSTED_RESERVATION_TTL_MS", 120_000),
      safetyMultiplier: RESERVATION_SAFETY_MULTIPLIER
    }));
    console.log("[game] mounted: one sealed-run route enabled");
  }

  // The env values seed the state file once. After that, /admin/config owns
  // them, so a redeploy with stale env vars cannot silently undo a change.
  const stored = gateway.store.config;
  for (const [key, value] of Object.entries(seedConfig) as Array<[keyof HostedConfig, unknown]>) {
    if (key !== "paused" && JSON.stringify(stored[key]) !== JSON.stringify(value)) {
      console.warn(`[config] ${key}: stored value ${JSON.stringify(stored[key])} is in effect; the environment's ${JSON.stringify(value)} is only a first-boot seed. Change it with PATCH /admin/config.`);
    }
  }
  const unpriced = stored.modelAllowlist.filter((id) => !table.prices[id]);
  if (unpriced.length) console.warn(`[config] allowlisted but unpriced, will be refused: ${unpriced.join(", ")}`);

  const server = gateway.listen();

  // Until now an exit after startup left no trace: a platform stop (SIGTERM)
  // and an uncaught error looked the same in the logs -- nothing. Each now
  // says what happened. Messages pass through redact() so even an error that
  // somehow carried the upstream key cannot print it.
  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`[hosted] received ${signal} -- the platform or an operator asked this process to stop. Closing.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const fatal = (kind: string) => (error: unknown) => {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[hosted] FATAL ${kind}: ${redact(detail, apiKey)}`);
    process.exit(1);
  };
  process.on("uncaughtException", fatal("uncaught exception"));
  process.on("unhandledRejection", fatal("unhandled promise rejection"));
}
