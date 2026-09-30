/**
 * Orbio, extracted rather than rewritten. Every value and comment here was
 * already true in config.ts/server.ts before this refactor; this file exists
 * so the same facts live behind the Provider interface instead of being
 * spread across the module that dispatches every request.
 */
import { prices as staticPrices } from "../mission-constants.js";
import type { Provider } from "./types.js";

/**
 * §2 step 5 (SENTINEL_PROXY_MD): always the www host. The apex `orbio.so`
 * answers a POST with a 308, and a redirected POST loses its body. Verified
 * 2026-09-20: apex returns 308 to www, and www preserves the Authorization
 * header (a bogus key is rejected as `invalid_api_key`, not `missing_api_key`,
 * so the header survives the hop).
 */
const CHAT_COMPLETIONS_URL = "https://www.orbio.so/api/v1/chat/completions";
const MODELS_URL = "https://www.orbio.so/api/v1/models";

export const orbioProvider: Provider = {
  name: "orbio",
  chatCompletionsUrl: CHAT_COMPLETIONS_URL,
  modelsUrl: MODELS_URL,
  apiKeyEnvVar: "ORBIO_API_KEY",
  staticPrices,
  costReporting: "exact",
  authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  readExactCostUsd: (usage) => {
    const cost = usage?.cost;
    return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
  }
};
