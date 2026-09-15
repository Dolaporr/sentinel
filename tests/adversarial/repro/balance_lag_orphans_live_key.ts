// Adversarial repro for tests/adversarial/findings/01-revoke-recovery-single-read-trust.md, sections 4-6.
//
// scripts/d1-lifecycle.ts mints a live gateway key at line 22 and makes its first
// revoke attempt at line 37. Lines 26, 30 and 34 can each throw in between, and
// none of them sits inside a try/finally that revokes. main() then exits with the
// key still live, and a gateway key has no spend limit of its own
// (docs/MCP_SURFACE.md). Line 34 throws whenever the post-spend balance read has
// not moved, which is exactly what any balance-read lag produces.
//
// Part A drives the real MockOrbioClient in stale_balance mode (lag = infinity).
// Part B sweeps a finite lag against a stand-in whose getBalance() reflects only
// spend older than LAG_MS, the shape of an eventually consistent balance endpoint.
// MockOrbioClient cannot express this: its only lag (src/orbio/client.ts:44) is on
// key-status telemetry, never on getBalance().
// Part C bills the inference and then throws, the way a timed-out or cut request
// does. MockOrbioClient only charges on success (client.ts:55-60), so it has no
// mode for this.
//
// Run: npx tsx tests/adversarial/repro/balance_lag_orphans_live_key.ts
// In-memory only: no network, no key, no files written.

import { MockOrbioClient } from "../../../src/orbio/client.js";
import type { BalanceResult, GatewayKeyResult, GatewayKeyStatus, OrbioClient, SpendResult } from "../../../src/orbio/types.js";

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const COST = 0.00002;

/** Balance reads reflect only spend that landed at least lagMs ago. */
class LaggingBalanceGateway implements OrbioClient {
  readonly backend = "mock" as const;
  protected readonly spends: Array<{ at: number; cost: number }> = [];
  protected key: { prefix: string; secret: string; active: boolean } | null = null;
  constructor(private readonly startBalance: number, private readonly lagMs: number) {}

  trueBalance(): number { return round(this.startBalance - this.spends.reduce((sum, s) => sum + s.cost, 0)); }

  async getBalance(): Promise<BalanceResult> {
    const cutoff = Date.now() - this.lagMs;
    const spent = round(this.spends.filter((s) => s.at <= cutoff).reduce((sum, s) => sum + s.cost, 0));
    return { balance: round(this.startBalance - spent), spent, raw: { environment: "adversarial", lag_ms: this.lagMs } };
  }
  async createKey(): Promise<GatewayKeyResult> {
    this.key = { prefix: "adv-lag-0001", secret: "adv-lag-secret", active: true };
    return { prefix: this.key.prefix, secret: this.key.secret, raw: { environment: "adversarial" } };
  }
  async getKeyStatus(): Promise<GatewayKeyStatus> {
    const hasKey = this.key?.active ?? false;
    return { hasKey, prefix: hasKey ? this.key!.prefix : null, state: hasKey ? "active" : "revoked", raw: { environment: "adversarial", has_key: hasKey } };
  }
  async runInference(input: { keySecret: string; model: string }): Promise<SpendResult> {
    if (!this.key?.active || input.keySecret !== this.key.secret) throw new Error("gateway key is revoked or invalid");
    this.spends.push({ at: Date.now(), cost: COST });
    return { model: input.model, cost: COST, raw: { environment: "adversarial" } };
  }
  async revokeKey(): Promise<{ raw: Record<string, string | boolean> }> {
    if (!this.key?.active) throw new Error("already revoked");
    this.key.active = false;
    return { raw: { environment: "adversarial", revoked: true } };
  }
}

/** Upstream bills the request, then the connection dies before the response arrives. One transient fault; later calls are healthy. */
class BilledThenThrowsGateway extends LaggingBalanceGateway {
  private faulted = false;
  override async runInference(input: { keySecret: string; model: string }): Promise<SpendResult> {
    const result = await super.runInference(input);
    if (this.faulted) return result;
    this.faulted = true;
    throw new Error("socket hang up (request was billed upstream)");
  }
}

/** Mirrors scripts/d1-lifecycle.ts:18-37: stops where main() would throw, revokes only where main() would. */
async function d1Flow(client: OrbioClient): Promise<{ diedAt: string | null; secret: string }> {
  const before = await client.getBalance();                                    // line 18
  const key = await client.createKey({ label: "sentinel-d1" });                // line 22: key is live from here
  try {
    await client.runInference({ keySecret: key.secret, model: "openai/gpt-4.1-mini", prompt: "x", maxCostUsd: 1 }); // line 26
  } catch (error) {
    return { diedAt: `line 26: ${(error as Error).message}`, secret: key.secret };
  }
  const afterSpend = await client.getBalance();                                // line 30
  if (!(before.balance - afterSpend.balance > 0)) {                            // line 34
    return { diedAt: "line 34: Spend proof failed: gateway balance did not decrease.", secret: key.secret };
  }
  await client.revokeKey();                                                    // line 37: first revoke attempt
  return { diedAt: null, secret: key.secret };
}

async function inspect(label: string, client: OrbioClient, trueBalance: () => number): Promise<boolean> {
  const { diedAt, secret } = await d1Flow(client);
  const status = await client.getKeyStatus();
  let orphanSpend = "not attempted (key revoked)";
  if (status.hasKey) {
    try { await client.runInference({ keySecret: secret, model: "openai/gpt-4.1-mini", prompt: "x", maxCostUsd: 1 }); orphanSpend = "SUCCEEDED"; }
    catch (error) { orphanSpend = `refused: ${(error as Error).message}`; }
  }
  const reported = (await client.getBalance()).balance;
  console.log(`${label.padEnd(34)} | died: ${(diedAt ?? "no (revoked at line 37)").padEnd(62)} | key live after exit: ${String(status.hasKey).padEnd(5)} | orphan can spend: ${orphanSpend.padEnd(9)} | true $${trueBalance().toFixed(6)} vs read $${reported.toFixed(6)}`);
  return status.hasKey;
}

async function main(): Promise<void> {
  let orphaned = 0;
  console.log("=== Part A: real MockOrbioClient, stale_balance (lag = infinity) ===");
  const previous = process.env.MOCK_FAILURE_MODE;
  process.env.MOCK_FAILURE_MODE = "stale_balance"; // read once, at construction (client.ts:22)
  const mock = new MockOrbioClient();
  if (previous === undefined) delete process.env.MOCK_FAILURE_MODE; else process.env.MOCK_FAILURE_MODE = previous;
  if (await inspect("MockOrbioClient stale_balance", mock, () => (mock as unknown as { balance: number }).balance)) orphaned++;

  console.log("\n=== Part B: balance read lags spend by LAG_MS ===");
  for (const lagMs of [0, 1, 50, 1_000, 30_000]) {
    const gateway = new LaggingBalanceGateway(50, lagMs);
    if (await inspect(`lag ${lagMs}ms`, gateway, () => gateway.trueBalance())) orphaned++;
  }

  console.log("\n=== Part C: inference billed upstream, then the call throws (lag 0) ===");
  const billed = new BilledThenThrowsGateway(50, 0);
  if (await inspect("billed-then-throws", billed, () => billed.trueBalance())) orphaned++;

  console.log(`\nREPRO RESULT: ${orphaned} of 7 runs exited with a live, spendable gateway key. Only lag 0 with a clean inference reached the revoke.`);
  if (orphaned > 0) process.exitCode = 1;
}

main();
