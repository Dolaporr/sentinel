import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GovernorEvent, GovernorEventName } from "./types.js";

export type GovernorEventInput = Omit<GovernorEvent, "ts" | "seq">;

/** Append-only event journal for all governor state transitions. */
export class ReservationLedger {
  private seq: number;
  private readonly events: GovernorEvent[] = [];

  constructor(private readonly filePath?: string) {
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
    if (this.filePath) appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  all(): readonly GovernorEvent[] { return this.events; }
  count(name: GovernorEventName): number { return this.events.filter((event) => event.event === name).length; }
}
