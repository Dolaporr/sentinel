/**
 * Verified live, 2026-09-30 (SENTINEL_PROVIDERS.md §0): a real non-streaming
 * call and a real streamed call (with stream_options.include_usage) both
 * returned usage.cost inline -- no follow-up-by-id call needed. Its terminating
 * streamed chunk also carries a `choices` entry alongside `usage`, unlike
 * Orbio's; StreamAccumulator does not assume the two are mutually exclusive,
 * so this needed no change there.
 */
import type { PriceEntry } from "../../governor/types.js";
import type { Provider } from "./types.js";

const CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODELS_URL = "https://openrouter.ai/api/v1/models";

/**
 * Last-resort fallback only, mirroring mission-constants.ts's two Orbio
 * entries. Confirmed identical live via GET /api/v1/models on 2026-09-30 --
 * unsurprising, since Orbio is itself OpenRouter-compatible -- but kept as
 * OpenRouter's own copy rather than importing Orbio's, per Provider.staticPrices
 * being one-per-provider: a real divergence later must not silently vanish
 * because two providers shared a reference.
 */
const staticPrices: Readonly<Record<string, PriceEntry>> = {
  "openai/gpt-4.1-mini": { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6, verifiedAt: "2026-09-30T00:00:00.000Z" },
  "openai/gpt-4.1": { inputPerMillionUsd: 2, outputPerMillionUsd: 8, verifiedAt: "2026-09-30T00:00:00.000Z" }
};

export const openrouterProvider: Provider = {
  name: "openrouter",
  chatCompletionsUrl: CHAT_COMPLETIONS_URL,
  modelsUrl: MODELS_URL,
  apiKeyEnvVar: "OPENROUTER_API_KEY",
  staticPrices,
  costReporting: "exact",
  authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  // Identical to Orbio's today -- both happen to key real cost as usage.cost.
  // Written out per-provider on purpose rather than shared: this method is the
  // one place "exact" can get blurred into "estimated" by accident, and a
  // future change to one provider's response shape must not silently reach
  // into another's through a shared helper.
  readExactCostUsd: (usage) => {
    const cost = usage?.cost;
    return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
  }
};
