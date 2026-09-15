// Adversarial repro for tests/adversarial/findings/02-balance-drain-path-and-breaker-placement.md.
//
// Replaces balance_drain_race.ts's assumed inputs ($5/call, 150ms, 20-way) with
// the ones this repo has actually measured, and keeps the one input nobody has
// measured (balance-telemetry lag L) as an explicit parameter.
//
// Measured inputs:
//   - Per-call cost and latency: fixtures/sample-feed.jsonl, the 2026-09-10 live
//     D2 race (read at runtime). The race ran one call at a time, so the gap
//     between one agent's consecutive calls is that call's latency.
//   - Gateway price list: GET https://www.orbio.so/api/v1/models on 2026-09-11,
//     439 models. None lists max_completion_tokens, so the list bounds only input
//     cost: a request whose input fills the context window. Output only adds to
//     that. This is what the gateway advertises, not proof it admits such a request.
//   - Warm round trip: 108-118ms for GETs against www.orbio.so on 2026-09-11.
//   - Balance: $100.076010, the last actual read (docs/MCP_SURFACE.md,
//     2026-09-07). Nothing has read the balance since.
//
// Run: npx tsx tests/adversarial/repro/drain_bound_from_measured_parameters.ts
// Pure computation; no network, no key.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BALANCE_USD = 100.07601;
const RTT_MS = 118; // upper end of the measured warm range
const SESSION_CEILING_USD = 3; // src/runner/d2-mission.ts:9, enforced pre-dispatch by SessionSpendCap
const MODELS_2026_09_11 = [
  { id: "openai/gpt-5.5-pro", contextTokens: 1_050_000, inPerM: 30 },
  { id: "openai/o1-pro", contextTokens: 200_000, inPerM: 150 },
  { id: "openai/gpt-4.1", contextTokens: 1_047_576, inPerM: 2 },
  { id: "openai/gpt-4.1-mini", contextTokens: 1_047_576, inPerM: 0.4 }
];
const fullInputUsd = (id: string) => { const m = MODELS_2026_09_11.find((x) => x.id === id)!; return (m.contextTokens * m.inPerM) / 1e6; };

type FeedEvent = { ts: string; event: string; raw?: { agent?: string; model?: string; usage_cost?: number } };
const feedPath = fileURLToPath(new URL("../../../fixtures/sample-feed.jsonl", import.meta.url));
const feed = readFileSync(feedPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FeedEvent);
const naked = feed.filter((e) => e.event === "INFERENCE_CALL" && e.raw?.agent === "naked").sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
const latenciesMs = naked.slice(1).map((e, i) => Date.parse(e.ts) - Date.parse(naked[i]!.ts)).sort((a, b) => a - b);
const costs = naked.map((e) => e.raw!.usage_cost!).filter((c) => typeof c === "number");
const median = (xs: number[]) => xs[Math.floor(xs.length / 2)]!;
const T_MS = median(latenciesMs);
const C_OBSERVED = Math.max(...costs);
const nakedSpend = costs.reduce((a, b) => a + b, 0);
const nakedWallMs = Date.parse(naked.at(-1)!.ts) - Date.parse(naked[0]!.ts);
const fmt = (ms: number) => ms < 120_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 7_200_000 ? `${(ms / 60_000).toFixed(1)}min` : `${(ms / 3_600_000).toFixed(1)}h`;

console.log("=== Measured inputs ===");
console.log(`naked agent, openai/gpt-4.1: ${naked.length} live calls, $${nakedSpend.toFixed(6)} over ${fmt(nakedWallMs)}`);
console.log(`  per-call latency ${fmt(latenciesMs[0]!)} to ${fmt(latenciesMs.at(-1)!)}, median ${fmt(T_MS)} (${T_MS}ms); max observed cost/call $${C_OBSERVED}`);
console.log(`balance $${BALANCE_USD.toFixed(6)} (last read 2026-09-07), warm RTT <= ${RTT_MS}ms`);

console.log("\n=== Input-only cost of ONE full-context request, from the gateway's own price list ===");
for (const m of MODELS_2026_09_11) {
  const c = fullInputUsd(m.id);
  console.log(`${m.id.padEnd(20)} ${String(m.contextTokens).padStart(9)} input tokens x $${m.inPerM}/M = $${c.toFixed(2).padStart(6)} -> ${String(Math.ceil(BALANCE_USD / c)).padStart(3)} request(s) to exceed the balance`);
}
console.log("(output is extra and its ceiling is not listed, so these are floors on a single request's cost, not ceilings)");

console.log("\n=== Time to drain the balance: N = ceil(B / c) requests, k in flight, T per wave ===");
const scenarios = [
  { label: "naked agent as observed (sequential)", c: nakedSpend / naked.length, k: 1, t: nakedWallMs / (naked.length - 1) },
  { label: "same calls, 20 in flight", c: C_OBSERVED, k: 20, t: T_MS },
  { label: "same calls, 200 in flight", c: C_OBSERVED, k: 200, t: T_MS },
  { label: "gpt-4.1 full-context input, 48 in flight", c: fullInputUsd("openai/gpt-4.1"), k: 48, t: T_MS },
  { label: "gpt-5.5-pro full-context input, 4 in flight", c: fullInputUsd("openai/gpt-5.5-pro"), k: 4, t: T_MS }
];
for (const s of scenarios) {
  const n = Math.ceil(BALANCE_USD / s.c);
  const waves = Math.ceil(n / s.k);
  console.log(`${s.label.padEnd(44)} c=$${s.c.toFixed(4).padStart(8)} N=${String(n).padStart(5)} waves=${String(waves).padStart(4)} drain ~ ${fmt(waves * s.t)}`);
}
console.log("(the last two use the observed median latency as a stand-in; a 1M-token request's real latency is unmeasured and longer)");

console.log("\n=== Earliest a post-hoc breaker can act, vs. telemetry lag L (unmeasured) ===");
console.log("Signal available to the key holder: usage.cost in the response body only; /key, /auth/key and /credits return 404.");
console.log("Signal available to an MCP holder: orbio_get_balance, whose lag behind spend has never been observed.");
const inBandMs = T_MS + RTT_MS; // usage.cost arrives when the response completes, then one revoke round trip
const exposure = (ms: number) => Math.ceil(ms / T_MS) * 20 * C_OBSERVED; // waves started before the trip, 20 in flight
console.log(`breaker in the dispatch path reading usage.cost: trips at ~${fmt(inBandMs)} (T + one RTT) whatever L is; 20-in-flight gpt-4.1 lands >= $${exposure(inBandMs).toFixed(2)} first`);
for (const L of [0, 1_000, 30_000, 60_000]) {
  const balanceMs = T_MS + L + 1_000 + 2 * RTT_MS; // billed at completion, visible after L, seen by a 1s poll, then the read and the revoke
  console.log(`L=${fmt(L).padStart(6)}: balance watcher trips at ~${fmt(balanceMs).padStart(6)}; 20-in-flight gpt-4.1 lands >= $${exposure(balanceMs).toFixed(2)} first`);
}
console.log(`Under either breaker, 4 full-context gpt-5.5-pro requests dispatched together bill $${(4 * fullInputUsd("openai/gpt-5.5-pro")).toFixed(2)} before it can trip.`);

console.log("\n=== Pre-dispatch admission, the SessionSpendCap shape (reserve worst case, then dispatch) ===");
const firstPro = fullInputUsd("openai/gpt-5.5-pro");
console.log(`$${SESSION_CEILING_USD.toFixed(2)} ceiling: the first gpt-5.5-pro request reserves >= $${firstPro.toFixed(2)} and is refused before dispatch; $0.00 leaves the process.`);
console.log(`Worst case for any mix of priced calls: <= $${SESSION_CEILING_USD.toFixed(2)}, whatever T or L is, provided every dispatch passes through it and no call bills above its reservation.`);

console.log("\nREPRO RESULT: four full-context requests to one listed model exceed the balance, and they fit in one concurrent wave,");
console.log("so drain time is one request's latency. A breaker that reacts to cost, in-band or from the balance, learns of those");
console.log("requests only after they are billed, whatever L is. Only an admission check before dispatch bounds it.");
