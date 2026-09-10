import "dotenv/config";
import {
  EXPENSIVE_MODEL,
  estimateTokens,
  missionSteps,
  roundUsd,
  worstCaseUsd
} from "../src/runner/d2-mission.js";

// Calibration pass. Runs ONE call per distinct step shape on the expensive
// model and reports predicted worst case against actual billed cost and actual
// output tokens. The point is to find out whether the recalibrated ceilings
// describe reality before committing to a recorded run -- not to produce
// evidence. Hard-capped well below the session ceiling.

const apiKey = process.env.ORBIO_API_KEY;
if (!apiKey) {
  throw new Error(
    "ORBIO_API_KEY is required in .env for the calibration pass. Mint a fresh gateway key and set it " +
    "before running -- this script never mints or revokes keys itself."
  );
}

const ENDPOINT = "https://www.orbio.so/api/v1/chat/completions";
const HARD_CAP_USD = 0.15;
const timeoutMs = Number(process.env.D2_LIVE_TTL_MS ?? 180_000);

// One of each shape: the cheapest extract step, and the synthesis step.
const sampled = [missionSteps.find((s) => s.kind === "extract")!, missionSteps.find((s) => s.kind === "synthesize")!];

interface Row {
  step: string;
  input_tokens_declared: number;
  max_tokens: number;
  predicted_worst_case_usd: number;
  actual_cost_usd: number | null;
  actual_output_tokens: number | null;
  ceiling_utilisation: string;
  bound_to_billed: string;
}

const rows: Row[] = [];
let spent = 0;

for (const step of sampled) {
  const prompt = step.buildPrompt(1);
  const inputTokens = estimateTokens(prompt);
  const worst = worstCaseUsd(EXPENSIVE_MODEL, inputTokens, step.maxTokens);

  if (spent + worst > HARD_CAP_USD) {
    console.log(`Stopping before ${step.id}: worst case $${worst} would cross the $${HARD_CAP_USD} calibration cap (spent $${spent}).`);
    break;
  }

  console.log(`\n[${step.id}] input_tokens=${inputTokens} max_tokens=${step.maxTokens} predicted_worst_case=$${worst.toFixed(6)}`);

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EXPENSIVE_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: step.maxTokens,
      temperature: 0
    }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error"
  });
  const bodyText = await response.text();
  if (!response.ok) throw new Error(`Gateway HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  const usage = (body.usage ?? {}) as Record<string, unknown>;
  const cost = typeof usage.cost === "number" ? usage.cost : null;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
  spent = roundUsd(spent + (cost ?? worst));

  const choice = Array.isArray(body.choices) ? body.choices[0] as { message?: { content?: string } } | undefined : undefined;
  const text = choice?.message?.content ?? "";

  rows.push({
    step: step.id,
    input_tokens_declared: inputTokens,
    max_tokens: step.maxTokens,
    predicted_worst_case_usd: worst,
    actual_cost_usd: cost,
    actual_output_tokens: outputTokens,
    ceiling_utilisation: outputTokens === null ? "n/a" : `${((outputTokens / step.maxTokens) * 100).toFixed(1)}%`,
    bound_to_billed: cost === null || cost === 0 ? "n/a" : `${(worst / cost).toFixed(2)}x`
  });

  console.log(`  -> HTTP ${response.status} cost=$${cost?.toFixed(6) ?? "MISSING"} output_tokens=${outputTokens ?? "MISSING"} first_line=${JSON.stringify(text.split("\n").find((l) => l.trim()) ?? "")}`);
}

console.log("\n=== CALIBRATION ===");
console.table(rows);
console.log(`Total calibration spend: $${spent} (hard cap $${HARD_CAP_USD})`);
console.log("\n>>> Remove the key from .env and revoke it at the gateway when you are done. <<<");
