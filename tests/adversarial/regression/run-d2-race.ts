// Shared helper for the finding-12 and finding-13 regression tests. Not a test
// itself. Spawns the ACTUAL shipped deliverable command (scripts/d2-race.ts,
// via tsx, offline transport only, no live spend) as a real child process and
// returns its parsed JSON output. Testing through the real command, rather
// than re-implementing its config inline, means these regression tests can't
// go green just because someone tweaks an isolated unit while leaving the
// actual driver script broken — which is exactly how findings 12 and 13 were
// found in the first place (see tests/adversarial/findings/12-*.md, 13-*.md).
//
// The JSON is extracted defensively (first "{" to last "}") so this survives
// npm's own banner lines and any reshaping of the script's top-level output
// object, and events/results are recovered by walking the parsed structure
// recursively rather than assuming a fixed shape — the driver script's JSON
// layout is not a frozen contract the way contracts/feed.schema.json's event
// fields are.

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface LedgerEventLike {
  event: string;
  amount_usd: number | null;
  cost_source: string | null;
  budget_usd?: number;
  raw?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkerResultLike {
  completed: boolean;
  outputs: unknown[];
  refusal?: string;
  [key: string]: unknown;
}

export function runD2Race(): unknown {
  // execSync (not execFileSync) so the command runs through a shell without Node's
  // "args not escaped" deprecation warning — there is no untrusted input here, the
  // command is a fixed literal string.
  const stdout = execSync("npx tsx scripts/d2-race.ts", {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, D2_BUDGET_USD: "3" }
  });
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`d2-race.ts produced no parseable JSON. Raw output:\n${stdout}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

/** Recursively collects every object in the parsed output that looks like a governor ledger event. */
export function collectLedgerEvents(node: unknown, out: LedgerEventLike[] = []): LedgerEventLike[] {
  if (Array.isArray(node)) { for (const item of node) collectLedgerEvents(item, out); return out; }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.event === "string" && "amount_usd" in obj) out.push(obj as unknown as LedgerEventLike);
    for (const value of Object.values(obj)) collectLedgerEvents(value, out);
  }
  return out;
}

/** Recursively collects every object in the parsed output that looks like a SharedWorker run result. */
export function collectWorkerResults(node: unknown, out: WorkerResultLike[] = []): WorkerResultLike[] {
  if (Array.isArray(node)) { for (const item of node) collectWorkerResults(item, out); return out; }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.completed === "boolean" && Array.isArray(obj.outputs)) out.push(obj as unknown as WorkerResultLike);
    for (const value of Object.values(obj)) collectWorkerResults(value, out);
  }
  return out;
}
