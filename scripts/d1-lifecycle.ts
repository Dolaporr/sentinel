import "dotenv/config";
import { resolve } from "node:path";
import { createOrbioClient } from "../src/orbio/client.js";
import { LedgerWriter, type LedgerEventInput } from "../src/ledger/writer.js";

const client = createOrbioClient();
const ledger = new LedgerWriter(resolve(process.cwd(), "evidence", "d1-lifecycle.jsonl"));
const money = (value: number) => `$${value.toFixed(6)}`;
const equalMoney = (left: number, right: number) => Math.abs(left - right) < 0.000001;

function record(input: LedgerEventInput): void { ledger.append(input); }
function print(label: string, detail: string): void { console.log(`${label}: ${detail}`); }

async function main(): Promise<void> {
  print("D1 MODE", client.backend);
  if (client.backend !== "mock") throw new Error("The local script is mock-only; live MCP calls require the authenticated Orbio bridge.");

  const before = await client.getBalance();
  print("1 BALANCE_BEFORE_SPEND", money(before.balance));
  record({ event: "BALANCE_READ", key_id: null, orbio_balance: before.balance, orbio_spent: before.spent, key_state: null, reason: "balance_before_spend", threshold: null, raw: before.raw });

  const key = await client.createKey({ label: "sentinel-d1" });
  print("2 KEY_CREATED", `key_id=${key.prefix}`);
  record({ event: "KEY_CREATED", key_id: key.prefix, orbio_balance: null, orbio_spent: null, key_state: "active", reason: "d1_gateway_lifecycle", threshold: null, raw: key.raw });

  const inference = await client.runInference({ keySecret: key.secret, model: "openai/gpt-4.1-mini", prompt: "Reply with exactly: sentinel lifecycle proof", maxCostUsd: 1 });
  print("3 INFERENCE_CALL", `model=${inference.model} cost=${money(inference.cost)} cap=$1.000000`);
  record({ event: "INFERENCE_CALL", key_id: key.prefix, orbio_balance: null, orbio_spent: null, key_state: "active", reason: "bounded_gateway_spend", threshold: 1, raw: inference.raw });

  const afterSpend = await client.getBalance();
  const spentDelta = before.balance - afterSpend.balance;
  print("4 BALANCE_AFTER_SPEND", `${money(afterSpend.balance)} delta=${money(spentDelta)}`);
  record({ event: "BALANCE_READ", key_id: key.prefix, orbio_balance: afterSpend.balance, orbio_spent: afterSpend.spent, key_state: "active", reason: "balance_after_spend", threshold: null, raw: afterSpend.raw });
  if (!(spentDelta > 0)) throw new Error("Spend proof failed: gateway balance did not decrease.");

  try {
    await client.revokeKey();
  } catch (error) {
    print("5 RECOVERING", "re-reading gateway status and balance; revoke outcome is not assumed.");
    const status = await client.getKeyStatus();
    const recoveredBalance = await client.getBalance();
    record({ event: "KEY_STATUS_READ", key_id: status.prefix, orbio_balance: recoveredBalance.balance, orbio_spent: recoveredBalance.spent, key_state: status.state, reason: "revoke_recovery", threshold: null, raw: { status: status.raw, balance: recoveredBalance.raw } });
    if (status.hasKey || !equalMoney(recoveredBalance.balance, afterSpend.balance)) {
      record({ event: "RECONCILIATION_FAILED", key_id: status.prefix, orbio_balance: recoveredBalance.balance, orbio_spent: recoveredBalance.spent, key_state: status.state, reason: "revoke_outcome_unresolved", threshold: null, raw: { error: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }

  const status = await client.getKeyStatus();
  const afterRevoke = await client.getBalance();
  print("5 KEY_REVOKED", `has_key=${status.hasKey}`);
  record({ event: "KEY_REVOKED", key_id: key.prefix, orbio_balance: afterRevoke.balance, orbio_spent: afterRevoke.spent, key_state: status.state, reason: "d1_gateway_lifecycle", threshold: null, raw: status.raw });
  print("6 BALANCE_AFTER_REVOKE", money(afterRevoke.balance));
  record({ event: "BALANCE_READ", key_id: key.prefix, orbio_balance: afterRevoke.balance, orbio_spent: afterRevoke.spent, key_state: status.state, reason: "balance_after_revoke", threshold: null, raw: afterRevoke.raw });

  if (status.hasKey || !equalMoney(afterSpend.balance, afterRevoke.balance)) {
    record({ event: "RECONCILIATION_FAILED", key_id: key.prefix, orbio_balance: afterRevoke.balance, orbio_spent: afterRevoke.spent, key_state: status.state, reason: "revoked_key_or_balance_not_reconciled", threshold: null, raw: { status: status.raw, balance: afterRevoke.raw } });
    throw new Error("Gateway revoke proof failed: key remained active or balance changed after revoke.");
  }

  console.log("\n=== D1 GATEWAY LIFECYCLE SUMMARY ===");
  console.log(`balance_before_spend: ${money(before.balance)}`);
  console.log(`spent: ${money(spentDelta)}`);
  console.log(`balance_after_spend: ${money(afterSpend.balance)}`);
  console.log(`key_revoked: ${!status.hasKey}`);
  console.log(`balance_after_revoke: ${money(afterRevoke.balance)}`);
  console.log(`balance_intact_after_revoke: ${equalMoney(afterSpend.balance, afterRevoke.balance)}`);
}

main().catch((error: unknown) => { console.error("D1 FAILED:", error instanceof Error ? error.message : error); process.exitCode = 1; });
