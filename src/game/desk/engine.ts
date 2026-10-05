/**
 * The desk: a server-run table round refereed by Sentinel's real governor.
 *
 * Four seats buy in, all run the same three-step job, and each seat locks a
 * policy per step without seeing the others. Every seat has its own
 * BudgetGovernor whose budget is its stack: the worst case of each call is
 * reserved before it "runs", a reservation that does not fit is a public 402
 * that knocks the seat out, and the unspent part of a reservation returns to
 * the stack once the bill is committed. The last seats standing with a
 * finished job compete on what they have left; the winner takes everything
 * left on the table.
 *
 * Play credit only. Bills are simulated from the listed price table; no model
 * is called and no credit moves. All randomness comes from a per-round seed
 * whose SHA-256 is published when the round opens and which is revealed when
 * it closes. Nothing secret (the seed, the step's real output length, another
 * seat's locked policy, a result whose ledger line is not out yet) leaves the
 * server before its time.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BudgetGovernor } from "../../governor/governor.js";
import { ReservationLedger } from "../../governor/ledger.js";
import type { PriceEntry } from "../../governor/types.js";

export type Route = "cheap" | "strong";
export const MAX_TOKEN_CHOICES = [512, 1024, 2048] as const;
export type MaxTokens = (typeof MAX_TOKEN_CHOICES)[number];
export interface Policy { route: Route; maxTokens: MaxTokens; burst: boolean }

/** Same figures as the OpenRouter provider table (verified 2026-09-30). */
export const DESK_MODELS: Readonly<Record<Route, string>> = { cheap: "openai/gpt-4.1-mini", strong: "openai/gpt-4.1" };
export const DESK_PRICES: Readonly<Record<string, PriceEntry>> = {
  "openai/gpt-4.1-mini": { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6, verifiedAt: "2026-09-30T00:00:00.000Z" },
  "openai/gpt-4.1": { inputPerMillionUsd: 2, outputPerMillionUsd: 8, verifiedAt: "2026-09-30T00:00:00.000Z" }
};
export const BUY_IN_USD = 0.1;
export const SAFETY_MULTIPLIER = 1.25;
export const BURST_CALLS = 3;
/** The desk's own fallback when a sitting player lets the lock window run out. */
export const DEFAULT_POLICY: Policy = { route: "cheap", maxTokens: 1024, burst: false };

export interface StepSpec {
  title: string;
  brief: string;
  inputTokens: number;
  /** Output tokens a complete answer needs, drawn per round inside this range. */
  need: readonly [number, number];
  /** 0 easy to 1 hard. A cheap route fails hard steps far more often. */
  difficulty: number;
}

export const JOB: { title: string; steps: readonly StepSpec[] } = {
  title: "Brief a client on a 10-K",
  steps: [
    { title: "Read the filing", brief: "Summarize an 18,000-token excerpt of the annual report.", inputTokens: 18_000, need: [500, 900], difficulty: 0.2 },
    { title: "Price the risk", brief: "Turn the summary and the debt tables into a risk score with the figures behind it.", inputTokens: 6_000, need: [250, 500], difficulty: 0.7 },
    { title: "Write the note", brief: "Write the client note: plain language, every figure sourced.", inputTokens: 3_000, need: [800, 1_600], difficulty: 0.35 }
  ]
};

export function passChance(route: Route, difficulty: number): number {
  return route === "strong" ? 0.97 - 0.15 * difficulty : 0.92 - 0.75 * difficulty;
}

const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

/** The governor's own worst-case arithmetic, for showing a quote before a lock. */
export function worstCaseFor(policy: Policy, step: StepSpec): number {
  const price = DESK_PRICES[DESK_MODELS[policy.route]];
  const one = ((step.inputTokens * price.inputPerMillionUsd) + (policy.maxTokens * price.outputPerMillionUsd)) / 1_000_000 * SAFETY_MULTIPLIER;
  return round9(one * (policy.burst ? BURST_CALLS : 1));
}

export function parsePolicy(value: unknown): Policy | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (r.route !== "cheap" && r.route !== "strong") return null;
  if (!MAX_TOKEN_CHOICES.includes(r.maxTokens as MaxTokens)) return null;
  if (typeof r.burst !== "boolean") return null;
  return { route: r.route, maxTokens: r.maxTokens as MaxTokens, burst: r.burst };
}

/** mulberry32 over the seed: small, fast and fully determined by the seed. */
function rngFrom(seed: string): () => number {
  let a = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Persona = "frugal" | "heavy" | "balanced" | "gambler";
const PERSONAS: readonly Persona[] = ["frugal", "heavy", "balanced", "gambler"];
const HOUSE_NAMES = ["Penny", "Atlas", "Hedge", "Blitz", "Juno", "Quill", "Rook", "Vega"];

export type SeatStatus = "in" | "out" | "failed" | "finished";
export type LineKind = "info" | "lock" | "hold" | "refuse" | "bill" | "pass" | "fail" | "pot";

export interface Line { at: number; seat: string | null; kind: LineKind; text: string }

interface SeatState {
  id: string;
  name: string;
  house: boolean;
  persona: Persona | null;
  secret: string | null;
  governor: BudgetGovernor;
  locks: Array<Policy | null>;
  lockedAt: Array<number | null>;
  defaulted: boolean[];
  /** Stack and status as the table sees them, in time order. */
  history: Array<{ at: number; stackUsd: number; status: SeatStatus }>;
}

export interface Timing { introMs: number; lockMs: number; runMs: number }
export const WATCH_TIMING: Timing = { introMs: 12_000, lockMs: 9_000, runMs: 9_000 };
export const SIT_TIMING: Timing = { introMs: 4_000, lockMs: 25_000, runMs: 9_000 };

type Phase = { kind: "intro" } | { kind: "lock"; step: number } | { kind: "run"; step: number } | { kind: "done" };

export interface SeatView {
  id: string; name: string; house: boolean; you: boolean;
  stackUsd: number; status: SeatStatus;
  locked: boolean;
  policies: Array<Policy | null>;
}

export interface RoundView {
  id: string;
  mode: "watch" | "sit";
  serverNow: number;
  phase: "intro" | "lock" | "run" | "done";
  step: number | null;
  /** When the current phase is due to end (lock windows can end early). */
  deadline: number | null;
  job: { title: string; steps: Array<{ title: string; brief: string; inputTokens: number; needHint: string; needTokens: number | null }> };
  buyInUsd: number;
  seats: SeatView[];
  lines: Line[];
  potUsd: number | null;
  winner: string | null;
  seedHash: string;
  seed: string | null;
  picks: Record<string, number> | null;
  pickOpen: boolean;
  yourPick?: string;
  prices: { cheap: { model: string; inputPerMillionUsd: number; outputPerMillionUsd: number }; strong: { model: string; inputPerMillionUsd: number; outputPerMillionUsd: number }; safetyMultiplier: number; burstCalls: number };
}

const MAX_PICKS = 5_000;

export class DeskRound {
  readonly id: string;
  readonly createdAt: number;
  private readonly seed: string;
  readonly seedHash: string;
  private readonly rng: () => number;
  private readonly seats: SeatState[] = [];
  private readonly lines: Line[] = [];
  private readonly needs: number[];
  private readonly picks = new Map<string, string>();
  private readonly revealTimes: Array<number | null> = JOB.steps.map(() => null);
  private phase: Phase = { kind: "intro" };
  private phaseEnds: number;
  private runEnds = 0;
  private resolvedSteps = 0;
  doneAt: number | null = null;
  private potUsd: number | null = null;
  private winner: string | null = null;
  /** Serializes advance() so overlapping requests cannot resolve a step twice. */
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly mode: "watch" | "sit", private readonly timing: Timing, now: number, options: { seed?: string; playerName?: string } = {}) {
    this.id = randomBytes(9).toString("base64url");
    this.createdAt = now;
    this.seed = options.seed ?? randomBytes(16).toString("hex");
    this.seedHash = createHash("sha256").update(this.seed).digest("hex");
    this.rng = rngFrom(this.seed);
    this.needs = JOB.steps.map((s) => Math.round(s.need[0] + this.rng() * (s.need[1] - s.need[0])));

    const personas = this.shuffle(PERSONAS.slice());
    const names = this.shuffle(HOUSE_NAMES.slice());
    const houseCount = mode === "watch" ? 4 : 3;
    if (mode === "sit") this.addSeat("s1", options.playerName ?? "You", null);
    for (let i = 0; i < houseCount; i++) this.addSeat(`s${this.seats.length + 1}`, names[i], personas[i]);
    this.phaseEnds = now + timing.introMs;
    this.line(now, null, "info", `Table open. ${this.seats.length} seats, ${usd(BUY_IN_USD)} each. Pot so far ${usd(BUY_IN_USD * this.seats.length)}.`);
  }

  private shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  private addSeat(id: string, name: string, persona: Persona | null): void {
    const governor = new BudgetGovernor({
      budgetUsd: BUY_IN_USD,
      reservationTtlMs: 600_000,
      reservationSafetyMultiplier: SAFETY_MULTIPLIER,
      maxStepBudgetFraction: 1,
      prices: DESK_PRICES
    }, new ReservationLedger(undefined, { maxInMemoryEvents: 200 }));
    this.seats.push({
      id, name, house: persona !== null, persona,
      secret: persona === null ? randomBytes(24).toString("base64url") : null,
      governor,
      locks: JOB.steps.map(() => null), lockedAt: JOB.steps.map(() => null), defaulted: JOB.steps.map(() => false),
      history: [{ at: this.createdAt, stackUsd: BUY_IN_USD, status: "in" }]
    });
  }

  /** The secret a sitting player uses to lock their own seat. Shown once. */
  playerSecret(): string | null { return this.seats.find((s) => !s.house)?.secret ?? null; }

  seatForSecret(secret: string | undefined): string | null {
    if (!secret) return null;
    const a = Buffer.from(secret);
    for (const s of this.seats) {
      if (!s.secret) continue;
      const b = Buffer.from(s.secret);
      if (a.length === b.length && timingSafeEqual(a, b)) return s.id;
    }
    return null;
  }

  private line(at: number, seat: string | null, kind: LineKind, text: string): void { this.lines.push({ at, seat, kind, text }); }

  private latest(seat: SeatState, now = Number.POSITIVE_INFINITY) {
    let h = seat.history[0];
    for (const e of seat.history) if (e.at <= now) h = e;
    return h;
  }

  private stackOf(seat: SeatState): number {
    const s = seat.governor.snapshot();
    return round9(s.budgetUsd - s.committedExact - s.committedEstimated - s.reservedTotal);
  }

  /** Lock a sitting player's policy for the open step. */
  async lock(seatId: string, step: number, policy: Policy, now: number): Promise<{ ok: true } | { ok: false; code: string }> {
    let result: { ok: true } | { ok: false; code: string } = { ok: false, code: "not_locked" };
    await this.serial(async () => {
      await this.advanceUnlocked(now);
      const seat = this.seats.find((s) => s.id === seatId);
      if (!seat || seat.house) { result = { ok: false, code: "unknown_seat" }; return; }
      if (this.phase.kind !== "lock" || this.phase.step !== step) { result = { ok: false, code: "lock_window_closed" }; return; }
      if (this.latest(seat).status !== "in") { result = { ok: false, code: "seat_out" }; return; }
      if (seat.locks[step]) { result = { ok: false, code: "already_locked" }; return; }
      seat.locks[step] = policy; seat.lockedAt[step] = now;
      this.line(now, seat.id, "lock", `${seat.name} locks a policy.`);
      result = { ok: true };
      await this.advanceUnlocked(now);
    });
    return result;
  }

  /** A spectator's pick. Records a choice; moves no credit. One per viewer. */
  async pick(viewer: string, seatId: string, now: number): Promise<{ ok: true } | { ok: false; code: string }> {
    let result: { ok: true } | { ok: false; code: string } = { ok: false, code: "not_picked" };
    await this.serial(async () => {
      await this.advanceUnlocked(now);
      if (this.mode !== "watch") { result = { ok: false, code: "picks_watch_only" }; return; }
      if (!this.pickOpen()) { result = { ok: false, code: "picks_closed" }; return; }
      if (!this.seats.some((s) => s.id === seatId)) { result = { ok: false, code: "unknown_seat" }; return; }
      if (this.picks.has(viewer)) { result = { ok: false, code: "already_picked" }; return; }
      if (this.picks.size >= MAX_PICKS) { result = { ok: false, code: "picks_full" }; return; }
      this.picks.set(viewer, seatId);
      result = { ok: true };
    });
    return result;
  }

  private pickOpen(): boolean { return this.phase.kind === "intro" || (this.phase.kind === "lock" && this.phase.step === 0); }

  async advance(now: number): Promise<void> { await this.serial(() => this.advanceUnlocked(now)); }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private live(): SeatState[] { return this.seats.filter((s) => this.latest(s).status === "in"); }

  private async advanceUnlocked(now: number): Promise<void> {
    for (let guard = 0; guard < 16; guard++) {
      const p = this.phase;
      if (p.kind === "done") return;
      if (p.kind === "intro") {
        if (now < this.phaseEnds) return;
        this.openLock(0, this.phaseEnds);
        continue;
      }
      if (p.kind === "lock") {
        const live = this.live();
        const lockTimes = live.map((s) => s.lockedAt[p.step]);
        const allLocked = lockTimes.every((t) => t !== null);
        const lastLock = allLocked ? Math.max(...(lockTimes as number[])) : Number.POSITIVE_INFINITY;
        // House seats lock at scripted moments inside the window; the window
        // ends early only once every live seat, the player included, has locked.
        const at = Math.min(this.phaseEnds, lastLock);
        if (now < at) return;
        await this.resolveStep(p.step, at);
        continue;
      }
      if (p.kind === "run") {
        if (now < this.runEnds) return;
        if (p.step + 1 < JOB.steps.length && this.live().length > 0) { this.openLock(p.step + 1, this.runEnds); continue; }
        this.settle(this.runEnds);
        return;
      }
    }
  }

  private openLock(step: number, at: number): void {
    this.phase = { kind: "lock", step };
    this.phaseEnds = at + this.timing.lockMs;
    const spec = JOB.steps[step];
    this.line(at, null, "info", `Step ${step + 1} of ${JOB.steps.length}: ${spec.title}. ${spec.brief} Lock a policy.`);
    for (const seat of this.live()) {
      if (!seat.house) continue;
      seat.locks[step] = this.housePolicy(seat, step);
      const when = at + Math.round(this.timing.lockMs * (0.15 + this.rng() * 0.6));
      seat.lockedAt[step] = when;
      this.line(when, seat.id, "lock", `${seat.name} locks a policy.`);
    }
  }

  /** House seats play a persona, read only public information, and sometimes deviate. */
  private housePolicy(seat: SeatState, step: number): Policy {
    const spec = JOB.steps[step];
    const stack = this.stackOf(seat);
    const fitsNeed = (n: number): MaxTokens => MAX_TOKEN_CHOICES.find((m) => m >= n) ?? 2048;
    const mid = (spec.need[0] + spec.need[1]) / 2;
    let policy: Policy;
    switch (seat.persona) {
      case "frugal": policy = { route: "cheap", maxTokens: fitsNeed(this.rng() < 0.35 ? spec.need[0] : mid), burst: false }; break;
      case "heavy": policy = { route: "strong", maxTokens: 2048, burst: false }; break;
      case "balanced": policy = { route: spec.difficulty >= 0.6 ? "strong" : "cheap", maxTokens: fitsNeed(spec.need[1]), burst: false }; break;
      default: policy = { route: this.rng() < 0.3 ? "strong" : "cheap", maxTokens: fitsNeed(mid), burst: spec.difficulty >= 0.6 || this.rng() < 0.3 };
    }
    if (this.rng() < 0.15) policy = { ...policy, route: policy.route === "cheap" ? "strong" : "cheap" };
    // Everyone but the gambler checks the quote against the stack first.
    if (seat.persona !== "gambler" && worstCaseFor(policy, spec) > stack) {
      policy = { route: "cheap", maxTokens: fitsNeed(mid), burst: false };
    }
    return policy;
  }

  private async resolveStep(step: number, at: number): Promise<void> {
    const spec = JOB.steps[step];
    const need = this.needs[step];
    this.phase = { kind: "run", step };
    this.resolvedSteps = step + 1;
    this.revealTimes[step] = at;
    const live = this.live();
    const gap = Math.max(400, Math.floor((this.timing.runMs - 1_500) / Math.max(1, live.length)));
    this.line(at, null, "info", `Step ${step + 1} runs. A complete answer needed ${need} output tokens.`);
    for (const [index, seat] of live.entries()) {
      const t0 = at + 600 + index * gap;
      let policy = seat.locks[step];
      if (!policy) {
        policy = DEFAULT_POLICY; seat.locks[step] = policy; seat.defaulted[step] = true;
        this.line(t0, seat.id, "info", `${seat.name} didn't lock in time. The desk locked cheap, 1024 tokens, one call.`);
      }
      await this.runSeat(seat, step, spec, need, policy, t0, gap);
    }
    this.runEnds = at + this.timing.runMs;
  }

  private async runSeat(seat: SeatState, step: number, spec: StepSpec, need: number, policy: Policy, t0: number, gap: number): Promise<void> {
    const model = DESK_MODELS[policy.route];
    const calls = policy.burst ? BURST_CALLS : 1;
    const before = this.stackOf(seat);
    const label = `${policy.route === "strong" ? "strong" : "cheap"} · ${policy.maxTokens} tokens · ${policy.burst ? `burst of ${calls}` : "one call"}`;
    const admitted: string[] = [];
    let held = 0;
    let refused = false;
    for (let k = 0; k < calls; k++) {
      const attemptId = `${this.id}:${seat.id}:${step}:${k}`;
      const admission = await seat.governor.reserve({ attemptId, logicalCallId: attemptId, model, inputTokens: spec.inputTokens, maxTokens: policy.maxTokens, nowMs: t0 });
      if (!admission.admitted) { refused = true; break; }
      admitted.push(attemptId); held = round9(held + admission.reservation.amountUsd);
    }
    const ask = worstCaseFor(policy, spec);
    if (refused) {
      // All or nothing: a policy is one decision, so a burst that does not
      // fully fit sends nothing. The admitted part of the hold is released.
      for (const id of admitted) await seat.governor.releaseUnbilled(id, "burst_not_fully_admitted", t0);
      this.line(t0, seat.id, "refuse", `402 · ${seat.name} locked ${label}. Sentinel needs to hold ${usd(ask)}; the stack has ${usd(before)}. Out.`);
      seat.history.push({ at: t0, stackUsd: this.stackOf(seat), status: "out" });
      return;
    }
    this.line(t0, seat.id, "hold", `${seat.name} · ${label}. Sentinel holds ${usd(held)} of ${usd(before)}.`);
    seat.history.push({ at: t0, stackUsd: round9(before - held), status: "in" });

    const price = DESK_PRICES[model];
    let billed = 0;
    let passed = false;
    let truncated = 0;
    for (const id of admitted) {
      const wanted = Math.round(need * (0.9 + this.rng() * 0.2));
      const out = Math.min(policy.maxTokens, wanted);
      if (wanted > policy.maxTokens) truncated++;
      const cost = round9((spec.inputTokens * price.inputPerMillionUsd + out * price.outputPerMillionUsd) / 1_000_000);
      await seat.governor.commitExact(id, cost, t0);
      billed = round9(billed + cost);
      const ok = wanted <= policy.maxTokens && this.rng() < passChance(policy.route, spec.difficulty);
      passed = passed || ok;
    }
    const after = this.stackOf(seat);
    const t1 = t0 + Math.round(gap * 0.45);
    this.line(t1, seat.id, "bill", `${seat.name} billed ${usd(billed)}. ${usd(round9(held - billed))} goes back. Stack ${usd(after)}.`);
    const t2 = t0 + Math.round(gap * 0.8);
    const last = step === JOB.steps.length - 1;
    if (passed) {
      this.line(t2, seat.id, "pass", last ? `${seat.name} passes the final check. Job finished with ${usd(after)} left.` : `${seat.name} passes the check.`);
      seat.history.push({ at: t1, stackUsd: after, status: "in" });
      if (last) seat.history.push({ at: t2, stackUsd: after, status: "finished" });
    } else {
      const why = truncated === admitted.length ? `the answer was cut off at ${policy.maxTokens} tokens` : "the answer missed the figures";
      this.line(t2, seat.id, "fail", `${seat.name} fails the check: ${why}. The job is unfinished; the stack stays on the table.`);
      seat.history.push({ at: t1, stackUsd: after, status: "in" });
      seat.history.push({ at: t2, stackUsd: after, status: "failed" });
    }
  }

  private settle(at: number): void {
    this.phase = { kind: "done" };
    this.doneAt = at;
    const pot = round9(this.seats.reduce((sum, s) => sum + this.stackOf(s), 0));
    this.potUsd = pot;
    const finished = this.seats.filter((s) => this.latest(s).status === "finished");
    const spent = round9(BUY_IN_USD * this.seats.length - pot);
    if (finished.length === 0) {
      this.line(at, null, "pot", `No seat finished the job. ${usd(spent)} paid for calls; ${usd(pot)} is left on the table with no winner.`);
      return;
    }
    // Most credit left wins; a tie goes to the seat that finished first.
    finished.sort((a, b) => this.stackOf(b) - this.stackOf(a) || this.latest(a).at - this.latest(b).at);
    const win = finished[0];
    this.winner = win.id;
    this.line(at, win.id, "pot", `${win.name} takes the pot: ${usd(pot)}. ${usd(spent)} of the ${usd(BUY_IN_USD * this.seats.length)} buy-in paid for calls.`);
  }

  view(now: number, viewerSeat: string | null, viewer: string | null): RoundView {
    const phase = this.phase;
    const visibleLines = this.lines.filter((l) => l.at <= now).sort((a, b) => a.at - b.at);
    const doneVisible = phase.kind === "done" && this.doneAt !== null && now >= this.doneAt;
    const shownPhase: RoundView["phase"] = phase.kind === "done" && !doneVisible ? "run" : phase.kind;
    const step = phase.kind === "lock" || phase.kind === "run" ? phase.step : phase.kind === "done" && !doneVisible ? this.resolvedSteps - 1 : null;
    const deadline = phase.kind === "intro" || phase.kind === "lock" ? this.phaseEnds : phase.kind === "run" || !doneVisible ? this.runEnds : null;
    const counts: Record<string, number> = {};
    if (this.mode === "watch") { for (const s of this.seats) counts[s.id] = 0; for (const v of this.picks.values()) counts[v] = (counts[v] ?? 0) + 1; }
    return {
      id: this.id,
      mode: this.mode,
      serverNow: now,
      phase: shownPhase,
      step,
      deadline,
      job: {
        title: JOB.title,
        steps: JOB.steps.map((s, i) => ({
          title: s.title, brief: s.brief, inputTokens: s.inputTokens, needHint: `${s.need[0]}–${s.need[1]}`,
          needTokens: this.revealAt(i) !== null && now >= (this.revealAt(i) as number) ? this.needs[i] : null
        }))
      },
      buyInUsd: BUY_IN_USD,
      seats: this.seats.map((s) => {
        const h = this.latest(s, now);
        const currentStep = phase.kind === "lock" ? phase.step : null;
        return {
          id: s.id, name: s.name, house: s.house, you: viewerSeat === s.id,
          stackUsd: h.stackUsd, status: h.status,
          locked: currentStep !== null && s.lockedAt[currentStep] !== null && (s.lockedAt[currentStep] as number) <= now,
          policies: s.locks.map((p, i) => {
            const reveal = this.revealAt(i);
            const mine = viewerSeat === s.id;
            return p && (mine || (reveal !== null && now >= reveal)) ? p : null;
          })
        };
      }),
      lines: visibleLines,
      potUsd: doneVisible ? this.potUsd : null,
      winner: doneVisible ? this.winner : null,
      seedHash: this.seedHash,
      seed: doneVisible ? this.seed : null,
      picks: this.mode === "watch" ? counts : null,
      pickOpen: this.mode === "watch" && this.pickOpen(),
      prices: {
        cheap: { model: DESK_MODELS.cheap, ...priceOf("cheap") },
        strong: { model: DESK_MODELS.strong, ...priceOf("strong") },
        safetyMultiplier: SAFETY_MULTIPLIER, burstCalls: BURST_CALLS
      },
      ...(viewer && this.picks.has(viewer) ? { yourPick: this.picks.get(viewer) } : {})
    };
  }

  /** When step i's results start to show. Policies and the real output length stay hidden until then. */
  private revealAt(step: number): number | null { return this.revealTimes[step]; }

  /** For tests and the operator: the table's books, which must always balance. */
  books(): { buyInsUsd: number; spentUsd: number; potUsd: number | null } {
    const spent = round9(this.seats.reduce((sum, s) => { const snap = s.governor.snapshot(); return sum + snap.committedExact + snap.committedEstimated; }, 0));
    return { buyInsUsd: round9(BUY_IN_USD * this.seats.length), spentUsd: spent, potUsd: this.potUsd };
  }
}

function priceOf(route: Route) { const p = DESK_PRICES[DESK_MODELS[route]]; return { inputPerMillionUsd: p.inputPerMillionUsd, outputPerMillionUsd: p.outputPerMillionUsd }; }

export function usd(n: number): string { return `$${n.toFixed(4)}`; }
