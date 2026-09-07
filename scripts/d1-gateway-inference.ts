import { OpenRouter } from "@openrouter/agent";
import { chatSend } from "@openrouter/sdk/funcs/chatSend";
import type { ChatResult } from "@openrouter/sdk/models/chatresult";

const apiKey = process.env.ORBIO_API_KEY;
if (!apiKey) throw new Error("ORBIO_API_KEY is required for the live gateway inference.");

const client = new OpenRouter({
  apiKey,
  serverURL: process.env.ORBIO_GATEWAY_URL ?? "https://orbio.so/api/v1",
  timeoutMs: 30_000
});

// Orbio implements its documented OpenAI-compatible Chat Completions surface.
// The agent package's high-level callModel path targets /responses, which this
// gateway does not expose, so use the agent client's typed chat surface.
const result = await chatSend(client, {
  chatRequest: {
    model: "openai/gpt-4.1-mini",
    messages: [{ role: "user", content: "Reply with exactly: sentinel live proof" }],
    maxCompletionTokens: 16,
    temperature: 0,
    reasoningEffort: "none",
    stream: false as const
  }
}, { timeoutMs: 30_000 });
if (!result.ok) throw new Error(`Gateway inference failed: ${result.error.message}`);
const completed = result.value as ChatResult;
const text = completed.choices[0]?.message.content ?? "";
const cost = completed.usage?.cost;
if (typeof cost !== "number") throw new Error("Gateway response omitted usage.cost; live spend cannot be proved.");
if (cost > 1) throw new Error(`Live call exceeded the $1 ceiling: $${cost}.`);

console.log(JSON.stringify({
  model: completed.model,
  text,
  cost,
  usage: completed.usage
}));
