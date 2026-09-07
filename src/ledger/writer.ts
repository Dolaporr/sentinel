import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonObject } from "../orbio/types.js";

export const LIFECYCLE_EVENTS = [
  "BALANCE_READ", "KEY_CREATED", "INFERENCE_CALL", "KEY_STATUS_READ", "KEY_REVOKED", "RECONCILIATION_FAILED"
] as const;
export type LifecycleEventName = (typeof LIFECYCLE_EVENTS)[number];

export interface LedgerEventInput {
  event: LifecycleEventName;
  key_id: string | null;
  orbio_balance: number | null;
  orbio_spent: number | null;
  key_state: "active" | "revoked" | null;
  reason: string;
  threshold: number | null;
  raw: JsonObject;
}
export interface LedgerEvent extends LedgerEventInput { ts: string; seq: number; actor: "sentinel"; }

/** JSONL is append-only: this class never rewrites or truncates its target. */
export class LedgerWriter {
  private seq: number;
  constructor(private readonly filePath: string) { mkdirSync(dirname(filePath), { recursive: true }); this.seq = this.existingLineCount(); }
  append(input: LedgerEventInput): LedgerEvent {
    const event: LedgerEvent = { ts: new Date().toISOString(), seq: ++this.seq, actor: "sentinel", ...input };
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }
  private existingLineCount(): number { return existsSync(this.filePath) ? readFileSync(this.filePath, "utf8").split(/\r?\n/).filter(Boolean).length : 0; }
}
