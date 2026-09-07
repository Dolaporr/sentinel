// Adversarial repro for tests/adversarial/findings/01-revoke-recovery-single-read-trust.md
//
// scripts/d1-lifecycle.ts:36-47 recovers from a failed revokeKey() by doing exactly
// one re-read of getKeyStatus() + getBalance(), with NEITHER wrapped in its own
// try/catch. This mirrors that block against a client whose revoke fails AND whose
// recovery read also fails (a second, independent transport fault during recovery,
// which is exactly the kind of thing a slow/flaky MCP bridge does under load).
//
// Expected/observed result: the process dies with an uncaught exception and the
// ledger never receives a RECONCILIATION_FAILED record for this run — i.e. the
// evidence stream (documented as "append-only" and "a failed or irreconcilable
// revoke emits RECONCILIATION_FAILED" in docs/DAY1_FAILURE_MODES.md) silently loses
// exactly the event class it exists to capture.
//
// Run: npx tsx tests/adversarial/repro/revoke_recovery_double_fault.ts

import { resolve } from "node:path";
import { LedgerWriter, type LedgerEventInput } from "../../../src/ledger/writer.js";
import type { BalanceResult, GatewayKeyResult, GatewayKeyStatus, OrbioClient, SpendResult } from "../../../src/orbio/types.js";

class DoubleFaultOrbioClient implements OrbioClient {
  readonly backend = "mock" as const;
  async getBalance(): Promise<BalanceResult> {
    return { balance: 49.99998, spent: 0.00002, raw: { environment: "adversarial", note: "reflects post-spend balance" } };
  }
  async createKey(): Promise<GatewayKeyResult> {
    return { prefix: "adv-gateway-0001", secret: "adv-secret", raw: { environment: "adversarial" } };
  }
  async getKeyStatus(): Promise<GatewayKeyStatus> {
    throw new Error("adversarial: key-status endpoint reset mid-recovery");
  }
  async runInference(): Promise<SpendResult> {
    return { model: "openai/gpt-4.1-mini", cost: 0.00002, raw: { environment: "adversarial" } };
  }
  async revokeKey(): Promise<{ raw: Record<string, string | boolean> }> {
    throw new Error("adversarial: revoke transport reset");
  }
}

const ledgerPath = resolve(process.cwd(), "evidence", "adversarial-revoke-recovery-double-fault.jsonl");
const ledger = new LedgerWriter(ledgerPath);
function record(input: LedgerEventInput): void { ledger.append(input); }

// Mirrors scripts/d1-lifecycle.ts:36-47 verbatim in control flow and shape.
async function recoveryBlock(client: OrbioClient, afterSpendBalance: number, keyPrefix: string): Promise<void> {
  try {
    await client.revokeKey();
  } catch (error) {
    console.log("5 RECOVERING: re-reading gateway status and balance; revoke outcome is not assumed.");
    // NOTE: neither read below is wrapped in try/catch, exactly as in the target file.
    const status = await client.getKeyStatus();
    const recoveredBalance = await client.getBalance();
    record({
      event: "KEY_STATUS_READ", key_id: status.prefix, orbio_balance: recoveredBalance.balance, orbio_spent: recoveredBalance.spent,
      key_state: status.state, reason: "revoke_recovery", threshold: null, raw: { status: status.raw, balance: recoveredBalance.raw }
    });
    if (status.hasKey || Math.abs(recoveredBalance.balance - afterSpendBalance) >= 0.000001) {
      record({
        event: "RECONCILIATION_FAILED", key_id: status.prefix, orbio_balance: recoveredBalance.balance, orbio_spent: recoveredBalance.spent,
        key_state: status.state, reason: "revoke_outcome_unresolved", threshold: null,
        raw: { error: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const client = new DoubleFaultOrbioClient();
  const before = await client.getBalance();
  record({ event: "BALANCE_READ", key_id: null, orbio_balance: before.balance, orbio_spent: before.spent, key_state: null, reason: "balance_before_spend", threshold: null, raw: before.raw });

  const key = await client.createKey();
  record({ event: "KEY_CREATED", key_id: key.prefix, orbio_balance: null, orbio_spent: null, key_state: "active", reason: "d1_gateway_lifecycle", threshold: null, raw: key.raw });

  console.log(`Ledger entries before recovery attempt: ${countLines(ledgerPath)}`);
  await recoveryBlock(client, before.balance, key.prefix);
  console.log("Recovery completed without raising — this should not print.");
}

function countLines(path: string): number {
  try {
    return require("node:fs").readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).length;
  } catch { return 0; }
}

main()
  .then(() => { console.log("REPRO RESULT: recovery block returned normally (bug NOT reproduced)."); })
  .catch((error: unknown) => {
    console.error("REPRO RESULT: uncaught exception escaped the recovery block, exactly as scripts/d1-lifecycle.ts's would:");
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Ledger entries after crash: ${countLines(ledgerPath)} (no RECONCILIATION_FAILED was written for this fault)`);
    process.exitCode = 1;
  });
