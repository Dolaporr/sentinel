import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GovernorEvent, GovernorEventName } from "./types.js";

export type GovernorEventInput = Omit<GovernorEvent, "ts" | "seq">;

export interface ReservationLedgerOptions {
  /**
   * How many events to keep in memory for all(). Unbounded by default: a
   * mission run's feed is built from all(), so a mission keeps every event.
   * A long-running service (the proxy, the hosted gateway) must set this, or
   * the journal grows for as long as the process lives. count() stays exact
   * either way, and a filePath still receives every event.
   */
  maxInMemoryEvents?: number;
}

/** Append-only event journal for all governor state transitions. */
export class ReservationLedger {
  private seq: number;
  private events: GovernorEvent[] = [];
  private readonly counts = new Map<GovernorEventName, number>();
  private readonly maxInMemory: number;

  constructor(private readonly filePath?: string, options: ReservationLedgerOptions = {}) {
    this.maxInMemory = options.maxInMemoryEvents ?? Number.POSITIVE_INFINITY;
    if (!(this.maxInMemory > 0)) throw new Error("maxInMemoryEvents must be positive.");
    if (filePath) {
      mkdirSync(dirname(filePath), { recursive: true });
      this.seq = existsSync(filePath) ? readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
    } else {
      this.seq = 0;
    }
  }

  append(input: GovernorEventInput): GovernorEvent {
    const event: GovernorEvent = { ts: new Date().toISOString(), seq: ++this.seq, ...input };
    this.events.push(event);
    this.counts.set(event.event, (this.counts.get(event.event) ?? 0) + 1);
    // Trimmed in batches, not per append, so trimming stays amortised O(1).
    if (this.events.length > this.maxInMemory * 2) this.events = this.events.slice(-this.maxInMemory);
    if (this.filePath) appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  /** Every event, or the most recent maxInMemoryEvents when bounded. */
  all(): readonly GovernorEvent[] {
    return this.events.length > this.maxInMemory ? this.events.slice(-this.maxInMemory) : this.events;
  }

  /** Exact over the ledger's whole life, regardless of what all() still holds. */
  count(name: GovernorEventName): number { return this.counts.get(name) ?? 0; }
}
