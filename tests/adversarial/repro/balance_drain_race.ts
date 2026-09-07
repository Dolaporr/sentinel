// Adversarial repro for tests/adversarial/findings/02-balance-drain-path-and-breaker-placement.md
//
// Question: given (a) no native per-key/per-period cap at the Orbio gateway
// (stated project context — the gateway spends the live account balance
// directly, per docs/MCP_SURFACE.md's "Product model discovered live"), and
// (b) round-trip latency on every MCP tool call (observed as real and
// sometimes large — docs/DAY1_FAILURE_MODES.md's tool_latency_30s mode,
// and docs/DAY1_RESULT.md's live call that didn't return inside the safety
// window) — can a *post-hoc, poll-then-revoke* breaker ever contain a
// concurrent drain? And does a *pre-request, in-process admission check*
// fare differently?
//
// This is a self-contained timing/concurrency model, not a call into
// src/orbio/client.ts: MockOrbioClient's fixed $0.00002/call cost and
// sequential single-flight harness (scripts/d1-lifecycle.ts) can't itself
// exhibit a concurrent drain, which is exactly finding 2's point — nothing
// in this codebase today stops concurrent calls, because nothing here
// tracks cumulative spend at all. Latency figures are explicit assumptions,
// called out below, grounded in the round-trip orders of magnitude this
// repo already documents.
//
// Run: npx tsx tests/adversarial/repro/balance_drain_race.ts

const STARTING_BALANCE_USD = 100.076010; // observed live balance, docs/MCP_SURFACE.md
const COST_PER_CALL_USD = 5;             // one moderately-large-context paid call; gateway enforces no per-call price ceiling (undocumented/absent)
const NETWORK_RTT_MS = 150;              // one MCP round trip; conservative vs. observed real-world stalls in this repo's own docs
const ATTACKER_CONCURRENCY = 20;         // requests the attacker keeps in flight at once
const WATCHDOG_POLL_INTERVAL_MS = 1000;  // a naive "read balance, then revoke if over threshold" loop, polled every 1s

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// --- Scenario A: post-hoc watchdog (poll balance, then revoke) -------------
async function scenarioPostHocWatchdog(): Promise<void> {
  let balance = STARTING_BALANCE_USD;
  let spendInFlight = 0;
  let stopped = false;
  const t0 = Date.now();
  const log: string[] = [];

  async function attackerCall(n: number): Promise<void> {
    if (stopped) return;
    spendInFlight++;
    await sleep(NETWORK_RTT_MS); // request in transit; gateway enforces no cap, so this always lands
    balance = Math.max(0, balance - COST_PER_CALL_USD);
    spendInFlight--;
    log.push(`t+${Date.now() - t0}ms call#${n} landed, balance=$${balance.toFixed(2)}`);
    if (!stopped && balance > 0) void attackerCall(n + ATTACKER_CONCURRENCY);
  }

  const attackers = Array.from({ length: ATTACKER_CONCURRENCY }, (_, i) => attackerCall(i));

  async function watchdog(): Promise<void> {
    while (!stopped) {
      await sleep(WATCHDOG_POLL_INTERVAL_MS); // watchdog's own read cadence
      await sleep(NETWORK_RTT_MS);            // the getBalance() round trip itself
      log.push(`t+${Date.now() - t0}ms watchdog observes balance=$${balance.toFixed(2)}`);
      if (balance < STARTING_BALANCE_USD) {
        log.push(`t+${Date.now() - t0}ms watchdog decides to revoke (spend detected)`);
        await sleep(NETWORK_RTT_MS); // the revokeKey() round trip itself
        stopped = true;
        log.push(`t+${Date.now() - t0}ms watchdog's revoke lands. balance at revoke=$${balance.toFixed(2)}`);
        return;
      }
    }
  }

  await Promise.race([Promise.all(attackers), watchdog()]);
  await sleep(NETWORK_RTT_MS * 2); // let any last in-flight calls resolve
  console.log("=== Scenario A: post-hoc poll-then-revoke watchdog ===");
  for (const line of log) console.log("  " + line);
  console.log(`  RESULT: balance drained from $${STARTING_BALANCE_USD.toFixed(2)} to $${balance.toFixed(2)} before/around containment.\n`);
}

// --- Scenario B: pre-request in-process admission control -------------------
async function scenarioPreRequestBreaker(): Promise<void> {
  let balance = STARTING_BALANCE_USD;
  let committed = 0; // optimistically reserved at dispatch time, not at confirmation
  const CEILING_USD = 10; // Sentinel's own local cap, enforced without any round trip
  let blocked = 0;
  const t0 = Date.now();
  const log: string[] = [];

  async function attackerCall(n: number): Promise<void> {
    if (committed + COST_PER_CALL_USD > CEILING_USD) {
      blocked++;
      log.push(`t+${Date.now() - t0}ms call#${n} BLOCKED pre-dispatch (committed=$${committed} + cost=$${COST_PER_CALL_USD} > ceiling=$${CEILING_USD})`);
      return;
    }
    committed += COST_PER_CALL_USD; // reserved synchronously, before the network call is even made
    await sleep(NETWORK_RTT_MS);
    balance = Math.max(0, balance - COST_PER_CALL_USD);
    log.push(`t+${Date.now() - t0}ms call#${n} landed, balance=$${balance.toFixed(2)}, committed=$${committed}`);
  }

  const attackers = Array.from({ length: ATTACKER_CONCURRENCY }, (_, i) => attackerCall(i));
  await Promise.all(attackers);
  console.log("=== Scenario B: pre-request local admission control ===");
  for (const line of log) console.log("  " + line);
  console.log(`  RESULT: balance stopped at $${balance.toFixed(2)} (spent $${(STARTING_BALANCE_USD - balance).toFixed(2)}), ${blocked} calls blocked before dispatch, ceiling=$${CEILING_USD}.\n`);
}

async function main(): Promise<void> {
  await scenarioPostHocWatchdog();
  await scenarioPreRequestBreaker();
}

main();
