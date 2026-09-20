/**
 * One real completion through the proxy, in three lines.
 *
 *   npm run --silent demo:call
 *
 * Built for a screen recording, so the contract is the output: three aligned
 * lines on success, one line on a refusal, one line on any other failure. No
 * stack traces, and the process always exits 0 -- a non-zero exit makes npm
 * print its own multi-line error block, which is the opposite of short.
 */
import "dotenv/config";
import { CHEAP_MODEL } from "../src/runner/d2-mission.js";

const PROXY = process.env.SENTINEL_DEMO_URL ?? "http://localhost:8787";
const MODEL = process.env.SENTINEL_DEMO_MODEL ?? CHEAP_MODEL;
const PROMPT = "Say hello in five words.";

const usd = (value: number) => `$${value.toFixed(6)}`;
const line = (label: string, value: string) => console.log(`${label.padEnd(10)} ${value}`);

interface Completion {
  model?: string;
  usage?: { cost?: number };
  error?: { message?: string };
}

/** The proxy's own view of the budget, which is the number worth showing. */
async function remainingUsd(): Promise<string> {
  try {
    const response = await fetch(`${PROXY}/healthz`);
    if (!response.ok) return "unknown";
    const health = await response.json() as { daily_remaining_usd?: number; remaining_usd?: number };
    const remaining = health.daily_remaining_usd ?? health.remaining_usd;
    return typeof remaining === "number" ? usd(remaining) : "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer demo" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: PROMPT }], max_tokens: 64 })
    });
  } catch {
    // Much the likeliest way this fails mid-recording, so it says what to do.
    line("error", `no proxy at ${PROXY} - start it with: npm run proxy`);
    return;
  }

  const body = await response.json().catch(() => ({})) as Completion;

  // A refusal is the governor working, not a crash: show the message it wrote
  // for exactly this purpose and nothing else.
  if (response.status === 402) {
    line("refused", body.error?.message ?? "Sentinel refused the call.");
    return;
  }

  if (!response.ok) {
    line("error", `HTTP ${response.status} - ${body.error?.message ?? "upstream call failed"}`);
    return;
  }

  const cost = body.usage?.cost;
  line("model", body.model ?? MODEL);
  line("cost", typeof cost === "number" ? usd(cost) : "not reported");
  line("remaining", await remainingUsd());
}

await main();
