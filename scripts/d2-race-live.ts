import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GovernorEvent } from "../src/governor/types.js";
import {
  CHEAP_MODEL,
  EXPENSIVE_MODEL,
  MISSION_BUDGET_USD,
  RESERVATION_SAFETY_MULTIPLIER,
  SESSION_CEILING_USD,
  createSentinel,
  roundUsd,
  runGovernedExpensiveAgent,
  runNakedAgent,
  sentinelSteps,
  worstCaseUsd
} from "../src/runner/d2-mission.js";
import type { WorkerTransport } from "../src/worker/shared-worker.js";

// --- Key handling -----------------------------------------------------------
// Read-only from .env (ORBIO_API_KEY). Fail loudly if absent. This script does
// not mint or revoke the key -- that is a manual step around this run. The key
// is never logged and never written to the feed; both are enforced below with
// a runtime check against the actual serialized output, not just by omission.
const apiKey = process.env.ORBIO_API_KEY;
if (!apiKey) {
  throw new Error(
    "ORBIO_API_KEY is required in .env for the live D2 race. Mint a fresh gateway key and set it before " +
    "running -- this script never mints or revokes keys itself."
  );
}

// Hardcoded, not env-overridable: the non-www host 308-redirects and drops the POST body.
const ENDPOINT = "https://www.orbio.so/api/v1/chat/completions";

const sessionBudgetUsd = Number(process.env.D2_BUDGET_USD ?? SESSION_CEILING_USD);
if (!Number.isFinite(sessionBudgetUsd) || sessionBudgetUsd <= 0 || sessionBudgetUsd > SESSION_CEILING_USD) {
  throw new Error(`D2_BUDGET_USD must be greater than $0 and no more than the $${SESSION_CEILING_USD.toFixed(2)} session ceiling.`);
}

const liveTtlMs = Number(process.env.D2_LIVE_TTL_MS ?? 180_000);
const fixturePath = resolve(process.cwd(), "fixtures", "sample-feed.jsonl");

// No prompt fiction here any more. The mission's own buildPrompt() carries the
// corpus and the task; the previous "use as much of the output budget as
// possible" instruction existed only to inflate utilisation toward a fantasy
// max_tokens, which is the thing being corrected, not preserved.

interface LiveCall {
  ts: string;
  agent: string;
  model: string;
  prompt: string;
  max_tokens: number;
  cost: number | null;
  output_tokens: number | null;
  cost_source: "exact" | "estimated";
  status: number;
}

/**
 * Global, real-dollar backstop across ALL agents, including the deliberately
 * ungoverned naked one. This is the experimenter's safety net, not the thing
 * being tested -- naked's own code has no awareness of it and no way to check
 * it. Reserve-before-dispatch / commit-after, atomic, so it holds regardless
 * of call ordering (kept even though the three agents now run sequentially
 * per instruction -- a session-wide cap should not depend on that).
 */
class SessionSpendCap {
  private spent = 0;
  private reserved = 0;
  private mutexTail: Promise<void> = Promise.resolve();

  snapshot() {
    return { spent_usd: roundUsd(this.spent), reserved_usd: roundUsd(this.reserved), ceiling_usd: sessionBudgetUsd };
  }

  async dispatch<T>(worstCase: number, fn: () => Promise<{ value: T; costUsd: number }>): Promise<T> {
    await this.atomic(() => {
      if (this.spent + this.reserved + worstCase > sessionBudgetUsd) {
        throw new Error(
          `SESSION_CAP_TRIPPED: spent=$${this.spent} reserved=$${this.reserved} proposed=$${worstCase} ceiling=$${sessionBudgetUsd}`
        );
      }
      this.reserved = roundUsd(this.reserved + worstCase);
    });
    try {
      const { value, costUsd } = await fn();
      await this.atomic(() => {
        this.reserved = roundUsd(this.reserved - worstCase);
        this.spent = roundUsd(this.spent + costUsd);
      });
      return value;
    } catch (error) {
      await this.atomic(() => { this.reserved = roundUsd(this.reserved - worstCase); });
      throw error;
    }
  }

  private async atomic(operation: () => void): Promise<void> {
    let unlock!: () => void;
    const gate = new Promise<void>((res) => { unlock = res; });
    const previous = this.mutexTail;
    this.mutexTail = previous.then(() => gate);
    await previous;
    try { operation(); } finally { unlock(); }
  }
}

function createLiveTransport(agent: string, cap: SessionSpendCap, calls: LiveCall[]): WorkerTransport {
  return {
    async complete(input) {
      const inputTokens = input.inputTokens ?? 0;
      const worst = worstCaseUsd(input.model, inputTokens, input.maxTokens);
      return cap.dispatch(worst, async () => {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: input.model,
            messages: [{ role: "user", content: input.prompt }],
            max_tokens: input.maxTokens,
            temperature: 0
          }),
          signal: AbortSignal.timeout(liveTtlMs),
          redirect: "error" // never silently follow a redirect -- the non-www host drops the POST body
        });
        const bodyText = await response.text();
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(bodyText) as Record<string, unknown>; } catch { body = { parse_error: true, body_length: bodyText.length }; }
        if (!response.ok) throw new Error(`Gateway HTTP ${response.status}: ${bodyText.slice(0, 300)}`);

        const usage = (body.usage ?? {}) as Record<string, unknown>;
        const cost = typeof usage.cost === "number" ? usage.cost : null;
        const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens
          : typeof usage.output_tokens === "number" ? usage.output_tokens : null;
        const billed = cost ?? worst;
        const choice = Array.isArray(body.choices) ? body.choices[0] as { message?: { content?: string } } | undefined : undefined;
        const text = choice?.message?.content ?? "";

        calls.push({
          ts: new Date().toISOString(), agent, model: input.model, prompt: input.prompt.slice(0, 120),
          max_tokens: input.maxTokens, cost, output_tokens: outputTokens,
          cost_source: cost === null ? "estimated" : "exact", status: response.status
        });

        const session = cap.snapshot();
        const costLabel = cost === null ? `MISSING (estimated $${billed.toFixed(6)})` : `$${cost.toFixed(6)}`;
        console.log(`  [${agent}] ${input.model} max_tokens=${input.maxTokens} -> HTTP ${response.status}, cost=${costLabel}, session_spent~$${(session.spent_usd + billed).toFixed(6)}`);

        return {
          value: { text, usage: cost === null ? { outputTokens: outputTokens ?? undefined } : { cost, outputTokens: outputTokens ?? undefined } },
          costUsd: billed
        };
      });
    }
  };
}

interface FeedEvent {
  ts: string;
  seq: number;
  event: string;
  actor: "sentinel";
  key_id: string | null;
  orbio_balance: number | null;
  orbio_spent: number | null;
  key_state: "active" | "revoked" | null;
  reason: string;
  threshold: number | null;
  raw: Record<string, unknown>;
  reservation_id: string | null;
  logical_call_id: string | null;
  committed_exact: number;
  committed_estimated: number;
  reserved_total: number;
  cost_source: "exact" | "estimated" | null;
  reservation_safety_multiplier: number;
  mission_state: "complete" | "quarantined_unproductive" | null;
}

function feedFromGovernor(events: readonly GovernorEvent[], agent: string): Omit<FeedEvent, "seq">[] {
  return events.map((event) => ({
    ts: event.ts,
    event: event.event,
    actor: "sentinel" as const,
    key_id: null,
    orbio_balance: null,
    orbio_spent: roundUsd(event.committed_exact + event.committed_estimated),
    key_state: "active" as const,
    reason: typeof event.raw.reason === "string" ? event.raw.reason : event.event.toLowerCase(),
    threshold: MISSION_BUDGET_USD,
    raw: { agent, ...event.raw },
    reservation_id: event.attempt_id,
    logical_call_id: event.logical_call_id,
    committed_exact: event.committed_exact,
    committed_estimated: event.committed_estimated,
    reserved_total: event.reserved_total,
    cost_source: event.cost_source,
    reservation_safety_multiplier: RESERVATION_SAFETY_MULTIPLIER,
    mission_state: event.event === "MISSION_COMPLETE"
      ? "complete" as const
      : event.event === "QUARANTINED_UNPRODUCTIVE"
        ? "quarantined_unproductive" as const
        : null
  }));
}

// --- Run, sequentially: safest first, most dangerous last -------------------
// A burst of concurrent commits can cross the session cap before the wrapper
// sees it -- the same admission race already found and fixed once in the
// governor itself. Sequential removes that race entirely for this run and
// makes the console recording legible: one agent's story finishes before the
// next one's begins.

const cap = new SessionSpendCap();
const liveCalls: LiveCall[] = [];

console.log(`=== D2 LIVE RACE === session_cap=$${sessionBudgetUsd.toFixed(2)} mission_budget=$${MISSION_BUDGET_USD.toFixed(2)} endpoint=${ENDPOINT}`);

console.log("\n--- [1/3] sentinel (cheap-routed, governed) ---");
const sentinelTransport = createLiveTransport("sentinel", cap, liveCalls);
const sentinel = createSentinel("sentinel", sentinelTransport, liveTtlMs);
const sentinelResult = await sentinel.worker.run(sentinelSteps);
console.log(`sentinel done: completed=${sentinelResult.completed} committed_exact=$${sentinel.governor.snapshot().committedExact} committed_estimated=$${sentinel.governor.snapshot().committedEstimated}`);

console.log("\n--- [2/3] governed-expensive (expensive model, governed) ---");
const governedTransport = createLiveTransport("governed-expensive", cap, liveCalls);
const governedExpensive = await runGovernedExpensiveAgent(governedTransport, undefined, liveTtlMs);
console.log(`governed-expensive done: died=${governedExpensive.died} refusal=${governedExpensive.refusal} on step=${governedExpensive.refused_step} spent=$${governedExpensive.spent_usd} remaining=$${governedExpensive.remaining_usd}`);

console.log("\n--- [3/3] naked (expensive model, ungoverned) ---");
const nakedTransport = createLiveTransport("naked", cap, liveCalls);
const spentBeforeNaked = cap.snapshot().spent_usd;

interface NakedCrashed {
  died: true;
  reason: "CRASHED";
  error: string;
  spent_usd: number;
  budget_usd: number;
  completed_mission: false;
  calls: never[];
}
let naked: Awaited<ReturnType<typeof runNakedAgent>> | NakedCrashed;
try {
  naked = await runNakedAgent(nakedTransport);
} catch (error) {
  // Deliberately not caught inside runNakedAgent itself -- naked has no
  // safety net by design, including no error handling. This outer catch
  // exists only so a real network fault doesn't also destroy sentinel's and
  // governed-expensive's already-real results and skip the report/fixture.
  const message = error instanceof Error ? error.message : String(error);
  const spentByNaked = roundUsd(cap.snapshot().spent_usd - spentBeforeNaked);
  console.log(`naked CRASHED (an actual uncaught error, not a graceful budget death): ${message}`);
  naked = { died: true, reason: "CRASHED", error: message, spent_usd: spentByNaked, budget_usd: MISSION_BUDGET_USD, completed_mission: false, calls: [] };
}
console.log(`naked done: died=${naked.died} reason=${naked.reason} spent=$${naked.spent_usd}`);

const session = cap.snapshot();
console.log(`\n=== SESSION TOTAL: $${session.spent_usd} of $${sessionBudgetUsd.toFixed(2)} cap ===`);
if (session.spent_usd > sessionBudgetUsd) {
  // Structurally unreachable -- SessionSpendCap refuses any dispatch that would
  // cross this before it happens. Kept as a loud, visible failure rather than
  // silently trusting the invariant never to have a bug in it.
  throw new Error(`INVARIANT VIOLATED: live session spend $${session.spent_usd} exceeds the $${sessionBudgetUsd} cap.`);
}

// This script holds only the gateway key, and the gateway key cannot read the
// Orbio balance: that is readable only through the authenticated MCP bridge. It
// performs no balance read, so it emits no BALANCE_READ. That event is written
// only when a read actually happened, carrying the value the read returned.
const events: Omit<FeedEvent, "seq">[] = [];
const push = (event: Omit<FeedEvent, "seq">) => { events.push(event); };

for (const call of liveCalls) {
  push({
    ts: call.ts,
    event: "INFERENCE_CALL",
    actor: "sentinel",
    key_id: null,
    orbio_balance: null,
    orbio_spent: call.cost,
    key_state: "active",
    reason: "bounded_gateway_spend",
    threshold: MISSION_BUDGET_USD,
    raw: {
      agent: call.agent,
      model: call.model,
      max_tokens: call.max_tokens,
      output_tokens: call.output_tokens,
      usage_cost: call.cost,
      cost_source: call.cost_source,
      http_status: call.status,
      prompt_prefix: call.prompt
    },
    reservation_id: null,
    logical_call_id: null,
    committed_exact: call.cost_source === "exact" ? (call.cost ?? 0) : 0,
    committed_estimated: call.cost_source === "estimated" ? (call.cost ?? 0) : 0,
    reserved_total: 0,
    cost_source: call.cost_source,
    reservation_safety_multiplier: RESERVATION_SAFETY_MULTIPLIER,
    mission_state: null
  });
}

for (const event of feedFromGovernor(sentinel.ledger.all(), "sentinel")) push(event);
for (const event of feedFromGovernor(governedExpensive.events, "governed-expensive")) push(event);

// Every event keeps the timestamp taken when it occurred: an INFERENCE_CALL when
// its response arrived, a governor event when the governor recorded it. seq then
// follows that order, so reading the feed by seq reads it in time order. The sort
// is stable, so events stamped in the same millisecond keep their recorded order.
const feed: FeedEvent[] = [...events]
  .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  .map((event, index) => ({ ...event, seq: index + 1 }));

const resultPayload = {
  mode: "live",
  session_budget_usd: sessionBudgetUsd,
  mission_budget_usd: MISSION_BUDGET_USD,
  endpoint: ENDPOINT,
  default_model: EXPENSIVE_MODEL,
  cheap_model: CHEAP_MODEL,
  session,
  fixture: fixturePath,
  sentinel: {
    result: sentinelResult,
    committed_exact: sentinel.governor.snapshot().committedExact,
    committed_estimated: sentinel.governor.snapshot().committedEstimated
  },
  governed_expensive: {
    survived: governedExpensive.survived,
    died: governedExpensive.died,
    refusal: governedExpensive.refusal,
    refused_step: governedExpensive.refused_step,
    spent_usd: governedExpensive.spent_usd,
    remaining_usd: governedExpensive.remaining_usd,
    committed_exact: governedExpensive.governor.committedExact,
    committed_estimated: governedExpensive.governor.committedEstimated,
    calls: governedExpensive.calls
  },
  naked
};

// --- Key-leak guards: check the ACTUAL bytes about to be printed/written, ----
// not just "we never referenced apiKey here" by inspection.
const serializedResult = JSON.stringify(resultPayload, null, 2);
if (serializedResult.includes(apiKey)) {
  throw new Error("REFUSING TO PRINT: the serialized result unexpectedly contains the API key.");
}
console.log(serializedResult);

const feedSerialized = `${feed.map((event) => JSON.stringify(event)).join("\n")}\n`;
if (feedSerialized.includes(apiKey)) {
  throw new Error("REFUSING TO WRITE: the feed unexpectedly contains the API key.");
}
writeFileSync(fixturePath, feedSerialized, "utf8");
console.log(`\nFixture written: ${fixturePath}`);
console.log("\n>>> ACTION REQUIRED: revoke the live gateway key now. This script does not revoke it for you. <<<");
