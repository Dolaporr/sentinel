/**
 * The two ceilings. Both fail closed.
 *
 * The global pool is checked first and is a reservation, not a reading of
 * committed spend: checking "committed < cap" alone would let fifty tokens
 * each be admitted against the same last few cents in the same instant. Each
 * request holds its worst case against the pool until it settles, exactly as
 * the governor does per token.
 *
 * The per-token ceiling is the frozen BudgetGovernor, one instance per token,
 * never shared. Finding 13: a shared governor turns one user's refusal or
 * accounting fault into everyone's quarantine.
 */
import { BudgetGovernor } from "../../governor/governor.js";
import { ReservationLedger } from "../../governor/ledger.js";
import type { PriceEntry } from "../../governor/types.js";
import type { HostedStateStore } from "./state.js";

const round = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

export type PoolReservation =
  | { ok: true }
  | { ok: false; exhausted: boolean; capUsd: number; committedUsd: number; reservedUsd: number; remainingUsd: number };

export class GlobalPool {
  private readonly held = new Map<string, number>();
  private heldTotal = 0;

  constructor(private readonly store: HostedStateStore) {}

  capUsd(): number { return this.store.config.poolDailyCapUsd; }
  committedUsd(): number { return this.store.today().poolCommittedUsd; }
  reservedUsd(): number { return this.heldTotal; }
  remainingUsd(): number { return round(Math.max(0, this.capUsd() - this.committedUsd() - this.heldTotal)); }
  exhausted(): boolean { return this.committedUsd() >= this.capUsd(); }

  /** Synchronous on purpose: no other request can run between the check and the hold. */
  tryReserve(attemptId: string, worstCaseUsd: number): PoolReservation {
    const capUsd = this.capUsd();
    const committedUsd = this.committedUsd();
    if (committedUsd >= capUsd || committedUsd + this.heldTotal + worstCaseUsd > capUsd) {
      return { ok: false, exhausted: committedUsd >= capUsd, capUsd, committedUsd, reservedUsd: this.heldTotal, remainingUsd: this.remainingUsd() };
    }
    this.held.set(attemptId, worstCaseUsd);
    this.heldTotal = round(this.heldTotal + worstCaseUsd);
    return { ok: true };
  }

  /** Release the hold without spending: the per-token check refused after the pool admitted. */
  release(attemptId: string): void {
    const amount = this.held.get(attemptId);
    if (amount === undefined) return;
    this.held.delete(attemptId);
    this.heldTotal = round(Math.max(0, this.heldTotal - amount));
  }

  /** The real cost replaces the hold. Committed spend itself is persisted by the caller, once, for both ceilings. */
  settle(attemptId: string): void { this.release(attemptId); }
}

interface TenantEntry {
  governor: BudgetGovernor;
  date: string;
  capUsd: number;
  /** What the token had already spent today when this instance was built. */
  seededUsd: number;
}

/**
 * Past this many reservations an idle tenant's governor is rebuilt. The frozen
 * governor never forgets a reservation (its map and its in-memory event list
 * only grow, and each reserve scans every reservation it has ever made), which
 * is harmless in a mission run and a slow leak in a service that runs for
 * weeks. Rebuilding when idle is state-equivalent: today's committed spend is
 * carried in the budget, and an idle governor holds nothing else.
 */
const REBUILD_AFTER_RESERVATIONS = 200;

export interface TenantSettings {
  reservationTtlMs: number;
  reservationSafetyMultiplier: number;
  prices: () => Readonly<Record<string, PriceEntry>>;
}

export class TenantGovernors {
  private readonly entries = new Map<string, TenantEntry>();

  constructor(private readonly store: HostedStateStore, private readonly settings: TenantSettings) {}

  /** Today's spend for this token, from the durable store. */
  spentTodayUsd(handle: string): number { return this.store.today().byHandle[handle] ?? 0; }

  capUsd(): number { return this.store.config.tokenDailyCapUsd; }

  capReached(handle: string): boolean { return this.spentTodayUsd(handle) >= this.capUsd(); }

  /**
   * The governor this request should reserve against. Rebuilt only while
   * idle, so an in-flight reservation is never orphaned on an instance nobody
   * consults any more; a quarantined instance is never rebuilt automatically.
   */
  governorFor(handle: string): BudgetGovernor {
    const date = this.store.today().date;
    const capUsd = this.capUsd();
    const existing = this.entries.get(handle);
    if (existing) {
      const snap = existing.governor.snapshot();
      const idle = ![...snap.reservations.values()].some((r) => r.state === "active");
      const stale = existing.date !== date || existing.capUsd !== capUsd || snap.reservations.size >= REBUILD_AFTER_RESERVATIONS;
      if (!stale || !idle || snap.quarantined) return existing.governor;
    }
    const seededUsd = this.spentTodayUsd(handle);
    const remaining = round(capUsd - seededUsd);
    const governor = new BudgetGovernor(
      {
        // Never non-positive: the governor rejects that, and a spent-out token
        // is refused by capReached() before it gets here anyway.
        budgetUsd: remaining > 0 ? remaining : 1e-9,
        reservationTtlMs: this.settings.reservationTtlMs,
        reservationSafetyMultiplier: this.settings.reservationSafetyMultiplier,
        maxStepBudgetFraction: 1,
        prices: this.settings.prices()
      },
      new ReservationLedger()
    );
    this.entries.set(handle, { governor, date, capUsd, seededUsd });
    return governor;
  }

  quarantined(handle: string): boolean {
    return this.entries.get(handle)?.governor.snapshot().quarantined ?? false;
  }

  /** Revocation drops the instance too, so nothing about a dead token lingers in memory. */
  forget(handle: string): void { this.entries.delete(handle); }

  async expireAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.governor.expire()));
  }
}
