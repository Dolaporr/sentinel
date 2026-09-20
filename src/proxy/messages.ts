import { estimateTokens } from "../runner/d2-mission.js";

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
  return estimateTokens(prompt + toolText);
}

/** Counts output tokens from streamed text when the gateway gives us no usage. */
export function estimateOutputTokens(text: string): number {
  return text.length === 0 ? 0 : estimateTokens(text);
}
