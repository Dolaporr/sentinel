import { estimateTokens } from "./mission-constants.js";

/** The subset of the OpenAI chat-completions body the governor needs to price. */
export interface ChatCompletionRequest {
  model?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  stream?: unknown;
  stream_options?: unknown;
  [key: string]: unknown;
}

/**
 * Flattens message content to the text actually sent. Content is a string on
 * ordinary requests and an array of typed parts on multimodal ones; both shapes
 * reach a proxy, because the client picks the shape, not us.
 *
 * Non-text parts (images, audio) contribute tokens upstream that this cannot
 * see. They are counted as their serialized JSON rather than skipped, so the
 * estimate errs high — the safe direction for a worst-case bound. It is still
 * an estimate, never a billed amount.
 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return JSON.stringify(part);
    })
    .join("\n");
}

/**
 * Chat-template overhead the assembled text cannot see.
 *
 * `estimateTokens` measures characters, but the gateway prices a rendered chat
 * template: every message carries delimiter and role-marker tokens, and the
 * reply is primed with a few more. None of that appears in the message text, so
 * a character count misses it no matter what divisor it uses.
 *
 * Calibrated against the live run recorded in docs/PROXY_VERIFICATION.md: one
 * user message, 60 assembled characters, estimated 18 tokens, gateway reported
 * `prompt_tokens: 23` -- 22% under, in the direction `estimateTokens` documents
 * itself as erring away from. These constants put that case at 24, one token
 * high, which is the safe side.
 *
 * Per-message rather than a flat correction on purpose: the overhead scales with
 * message count, so a constant fitted to a single-message request would grow
 * more wrong with every turn of a real conversation.
 *
 * One live observation is not a calibration set. It is deliberately biased high
 * and should be re-checked against `prompt_tokens` on a multi-message request.
 */
const PER_MESSAGE_OVERHEAD_TOKENS = 3;
const REPLY_PRIMING_TOKENS = 3;

/**
 * §2 step 2: input tokens are derived from the assembled messages, never from a
 * declared constant. Role labels, tool calls and tool results are all counted,
 * because all of them are sent.
 */
export function assemblePromptText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message) => {
      if (!message || typeof message !== "object") return String(message ?? "");
      const record = message as Record<string, unknown>;
      const role = typeof record.role === "string" ? record.role : "unknown";
      const parts = [flattenContent(record.content)];
      if (record.name) parts.push(String(record.name));
      if (record.tool_calls) parts.push(JSON.stringify(record.tool_calls));
      return `${role}: ${parts.filter(Boolean).join("\n")}`;
    })
    .join("\n");
}

export function deriveInputTokens(body: ChatCompletionRequest): number {
  const prompt = assemblePromptText(body.messages);
  // Tools are part of the prompt the gateway prices, so they are part of ours.
  const toolText = body.tools ? JSON.stringify(body.tools) : "";
  const messageCount = Array.isArray(body.messages) ? body.messages.length : 0;
  return estimateTokens(prompt + toolText) + messageCount * PER_MESSAGE_OVERHEAD_TOKENS + REPLY_PRIMING_TOKENS;
}

/** Exposed so the correction can be asserted against real `prompt_tokens`. */
export const chatTemplateOverhead = (messageCount: number) =>
  messageCount * PER_MESSAGE_OVERHEAD_TOKENS + REPLY_PRIMING_TOKENS;

/** Counts output tokens from streamed text when the gateway gives us no usage. */
export function estimateOutputTokens(text: string): number {
  return text.length === 0 ? 0 : estimateTokens(text);
}
