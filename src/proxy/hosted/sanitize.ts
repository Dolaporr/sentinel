/**
 * What a hosted request body may contain. Everything not listed is refused
 * by name, before admission -- fail closed on fields we have not priced.
 *
 * The local proxy forwards bodies as-is because the client spends its own
 * key. Hosted, three ordinary-looking fields would let a free-tier caller
 * spend outside what the governor reserved for:
 *
 * - `models` / `route` (OpenRouter-style fallback routing): the reservation is
 *   priced for `model`, but the gateway may bill a different, allowlist-
 *   excluded model. The allowlist would be bypassed and the reservation wrong.
 * - `plugins` (e.g. web search): billed per request on top of tokens; the
 *   token-based worst case cannot see it.
 * - `n` > 1: n completions, each up to max_tokens, against a reservation for one.
 *
 * And `max_completion_tokens` is OpenAI's newer name for the output ceiling.
 * Forwarded alongside an injected `max_tokens`, a gateway could honour the
 * larger one; here it is folded into the single ceiling we reserve against,
 * and only `max_tokens` goes upstream.
 */
import type { ChatCompletionRequest } from "../messages.js";

const FORWARDED = new Set([
  "model", "messages", "max_tokens", "temperature", "top_p", "stop", "stream", "stream_options",
  "presence_penalty", "frequency_penalty", "seed", "response_format", "tools", "tool_choice",
  "parallel_tool_calls", "user", "logprobs", "top_logprobs", "logit_bias"
]);

const REFUSED_WITH_REASON: Record<string, string> = {
  models: "fallback routing could bill a model outside the allowlist",
  route: "fallback routing could bill a model outside the allowlist",
  provider: "provider routing is fixed by Sentinel",
  plugins: "plugins bill per request on top of tokens, which the budget cannot bound",
  transforms: "prompt transforms change what is billed after admission",
  web_search_options: "web search bills per request on top of tokens, which the budget cannot bound"
};

export type Sanitized =
  | { ok: true; body: ChatCompletionRequest; model: string; declaredMaxTokens: number | null }
  | { ok: false; code: string; message: string; param: string | null };

const positiveInt = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

export function sanitizeHostedBody(raw: unknown): Sanitized {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "invalid_body", message: "Request body must be a JSON object.", param: null };
  }
  const input = raw as Record<string, unknown>;
  const model = typeof input.model === "string" ? input.model : "";
  if (!model) return { ok: false, code: "invalid_body", message: "`model` is required.", param: "model" };
  if (!Array.isArray(input.messages)) return { ok: false, code: "invalid_body", message: "`messages` must be an array.", param: "messages" };

  for (const key of Object.keys(input)) {
    if (key in REFUSED_WITH_REASON) {
      return { ok: false, code: "sentinel_field_refused", message: `Sentinel hosted refuses \`${key}\`: ${REFUSED_WITH_REASON[key]}.`, param: key };
    }
  }
  if (input.n !== undefined && input.n !== 1) {
    return { ok: false, code: "sentinel_field_refused", message: "Sentinel hosted serves one completion per request; `n` must be 1.", param: "n" };
  }

  const body: ChatCompletionRequest = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "n" || key === "max_completion_tokens") continue;
    if (!FORWARDED.has(key)) {
      return { ok: false, code: "sentinel_field_unsupported", message: `Sentinel hosted does not forward \`${key}\`. Remove it and retry.`, param: key };
    }
    body[key] = value;
  }

  const ceilings = [positiveInt(input.max_tokens), positiveInt(input.max_completion_tokens)].filter((v): v is number => v !== null);
  const declaredMaxTokens = ceilings.length ? Math.min(...ceilings) : null;
  delete body.max_tokens;
  return { ok: true, body, model, declaredMaxTokens };
}
