import { orbioProvider } from "./orbio.js";
import type { Provider, ProviderName } from "./types.js";

const PROVIDERS: Record<ProviderName, Provider> = {
  orbio: orbioProvider,
  // openrouter and openai are added once SENTINEL_PROVIDERS.md §0 and §3 are
  // done; resolveProvider fails closed on their names until then, same as any
  // other unrecognised value.
} as Record<ProviderName, Provider>;

export class UnknownProviderError extends Error {
  constructor(public readonly requested: string) {
    super(`Unknown SENTINEL_PROVIDER "${requested}". Known: ${Object.keys(PROVIDERS).join(", ")}.`);
  }
}

/**
 * Fails closed on an unrecognised name, exactly like an unpriced model or a
 * missing key: refuse before dispatch, never assume a default silently.
 */
export function resolveProvider(name: string): Provider {
  const provider = PROVIDERS[name as ProviderName];
  if (!provider) throw new UnknownProviderError(name);
  return provider;
}

export const DEFAULT_PROVIDER_NAME: ProviderName = "orbio";
