import type { PriceEntry } from "../governor/types.js";

/**
 * The handful of constants the proxy shares with the mission runner, restated
 * here so that `src/proxy/` does not import `src/runner/d2-mission.js`.
 *
 * That module builds its corpus at load time from
 * `resolve(process.cwd(), "fixtures", "corpus")`, so importing it anywhere
 * threw ENOENT unless the process happened to be started from the repository
 * root. The proxy is installed and run from a stranger's empty directory
 * (`npx github:Dolaporr/sentinel --budget 5`), where those fixtures do not
 * exist and are not wanted -- it needs four constants, not a document corpus.
 *
 * `src/runner/` belongs to Codex, so the fix lives on this side of the line:
 * the proxy stops depending on that module's load-time side effects. The values
 * below mirror it exactly, and `tests/proxy/verify.ts` asserts they still do,
 * so a change there fails the proxy's own suite rather than drifting quietly.
 */

/** Mirrors `SESSION_CEILING_USD` in src/runner/d2-mission.ts. */
export const SESSION_CEILING_USD = 3;

/** Mirrors `RESERVATION_SAFETY_MULTIPLIER` in src/runner/d2-mission.ts. */
export const RESERVATION_SAFETY_MULTIPLIER = 1.25;

export const CHEAP_MODEL = "openai/gpt-4.1-mini";
export const EXPENSIVE_MODEL = "openai/gpt-4.1";

/**
 * The static fallback table, used only when the gateway's /models fetch fails
 * and no cached table is on disk. Mirrors `prices` in src/runner/d2-mission.ts.
 */
export const prices: Record<string, PriceEntry> = {
  [CHEAP_MODEL]: { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6, verifiedAt: "2026-09-08T00:00:00.000Z" },
  [EXPENSIVE_MODEL]: { inputPerMillionUsd: 2, outputPerMillionUsd: 8, verifiedAt: "2026-09-08T00:00:00.000Z" }
};

/**
 * Mirrors `estimateTokens` in src/runner/d2-mission.ts, including the /3.5
 * divisor that deliberately over-counts: input tokens feed the worst-case
 * bound, and over-counting errs in the safe direction. Never use this to
 * compute a billed amount; billed cost comes from the provider's usage.cost.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
