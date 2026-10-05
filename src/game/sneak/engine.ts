/**
 * Sneak Past Sentinel, decided on the server.
 *
 * The rules are the ones the browser game shipped with: five tricks, a guard
 * that secretly knows two of them, two probes, three lives. What changed is
 * where the game lives. The secret (which tricks the guard knows) is chosen
 * here, never sent to the page, and sealed at the start with a published
 * SHA-256 that the end of the run reveals. Every probe and wave is simulated
 * here; the page only animates what comes back. A run can only end through
 * its moves, in order, so a score cannot be claimed without playing it.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";

export const BUDGET_USD = 1;
export const START_LIVES = 3;
export const START_PROBES = 2;
export const GUARD_HEAD_START = 2;

export interface Trick {
  id: string;
  name: string;
  pitch: string;
  /** Calls in one wave. */
  n: number;
  /** What each call is quoted at, and what it really bills. */
  quote: number;
  actual: number;
  /** All calls hit the gate at once. */
  burst?: boolean;
  /** A guard that knows this trick refuses it before anything is sent. */
  door?: boolean;
  rule: string;
  real: string;
}

export const TRICKS: readonly Trick[] = [
  { id: "swarm", name: "Swarm", pitch: "Fire 20 calls at the exact same moment.", burst: true, n: 20, quote: 0.08, actual: 0.08,
    rule: "Hold each call's worst case the moment it's admitted, so calls still in flight count too.",
    real: "In Sentinel's own reproduction, 20 parallel calls drained a $100 budget in 313ms. Sentinel reserves before dispatch, so in-flight calls are always counted." },
  { id: "lowball", name: "Lowball", pitch: "Declare a tiny output cap, slip a huge one into a second field.", n: 6, quote: 0.01, actual: 0.30,
    rule: "Read both output-cap fields. The call goes out with one cap, and that is the cap it's priced at.",
    real: "A real bug: max_tokens and max_completion_tokens. One was reserved, the other went upstream. Sentinel now collapses them to one cap and prices that." },
  { id: "clones", name: "Clones", pitch: "Ask for 5 answers, pay the quote for 1.", n: 6, quote: 0.06, actual: 0.30, door: true,
    rule: "One answer per call. Asking for more is refused at the door.",
    real: "A real bug: n: 5 was admitted on a one-answer quote. Sentinel now refuses any n other than 1." },
  { id: "switch", name: "Bait & switch", pitch: "Ask for a cheap model with an expensive fallback.", n: 6, quote: 0.02, actual: 0.40, door: true,
    rule: "The model is locked. Fallback model lists are refused.",
    real: "Found building the hosted tier: a fallback list let the gateway pick a model outside the allowlist. Sentinel refuses it by name." },
  { id: "addons", name: "Add-ons", pitch: "Bolt paid extras like web search onto every call.", n: 6, quote: 0.03, actual: 0.28, door: true,
    rule: "Extras that bill on top of tokens are refused.",
    real: "Also from the hosted build: plugins bill per request on top of tokens, and no token quote covers that. Sentinel refuses them." }
];
const byId = new Map(TRICKS.map((t) => [t.id, t]));

export interface Packet { quote: number; actual: number; pass: boolean; reason: string }
export interface WaveResult { packets: Packet[]; spent: number; breach: boolean; passed: number }

/** One wave against the gate. Deterministic: only the guard's knowledge matters. */
export function simulateWave(t: Trick, guardKnows: boolean): WaveResult {
  const packets: Packet[] = [];
  let spent = 0, reserved = 0;
  for (let i = 0; i < t.n; i++) {
    let quote = t.quote, pass: boolean, reason = "";
    const actual = t.actual;
    if (guardKnows && t.door) { pass = false; reason = "refused at the door"; }
    else if (t.burst) {
      if (guardKnows) { pass = reserved + quote <= BUDGET_USD + 1e-9; if (pass) reserved += quote; else reason = "no room left to hold it"; }
      else { pass = quote <= BUDGET_USD; } // every call checked against $0 spent, all at once
    } else {
      if (guardKnows) quote = actual; // priced honestly
      pass = spent <= BUDGET_USD + 1e-9 && spent + quote <= BUDGET_USD + 1e-9;
      if (!pass) reason = "would go over budget";
    }
    if (pass) spent += actual;
    packets.push({ quote, actual, pass, reason });
  }
  return { packets, spent: Math.round(spent * 100) / 100, breach: spent > BUDGET_USD + 1e-9, passed: packets.filter((p) => p.pass).length };
}

export type MoveKind = "probe" | "wave";
export type Ending = "lives" | "all";
export type Outcome = "flawless" | "one_life_lost" | "other";

export interface RunSnapshot {
  lives: number;
  fooled: number;
  probes: number;
  /** trick id -> what the wave on it showed. */
  revealed: Record<string, "learned" | "knew">;
  /** trick id -> what the probe on it showed. */
  probed: Record<string, "alert" | "blind">;
  over: boolean;
}

export interface RunEnd {
  why: Ending;
  fooled: number;
  lives: number;
  outcome: Outcome;
  /** The sealed secret, revealed: sha256(`${salt}:${knows.join(",")}`) equals the commitment. */
  reveal: { salt: string; knows: string[] };
}

export type MoveResult =
  | { ok: true; kind: "probe"; trick: string; alert: boolean; state: RunSnapshot; end: null }
  | { ok: true; kind: "wave"; trick: string; outcome: "learned" | "knew"; wave: WaveResult; state: RunSnapshot; end: RunEnd | null }
  | { ok: false; code: "run_over" | "unknown_trick" | "trick_spent" | "no_probes_left" | "already_probed" | "bad_kind" };

export function commitmentFor(salt: string, knows: readonly string[]): string {
  return createHash("sha256").update(`${salt}:${[...knows].sort().join(",")}`).digest("hex");
}

/** The default draw: two distinct tricks, uniformly, from a cryptographic source. */
export function drawSecret(): string[] {
  const ids = TRICKS.map((t) => t.id);
  const out: string[] = [];
  while (out.length < GUARD_HEAD_START) {
    const pick = ids[randomInt(ids.length)];
    if (!out.includes(pick)) out.push(pick);
  }
  return out;
}

export class SneakRun {
  private readonly knows: Set<string>;
  private readonly secret: readonly string[];
  private readonly salt: string;
  readonly commitment: string;
  private readonly revealed = new Map<string, "learned" | "knew">();
  private readonly probed = new Map<string, "alert" | "blind">();
  private lives = START_LIVES;
  private fooled = 0;
  private probes = START_PROBES;
  private end: RunEnd | null = null;

  constructor(secret: readonly string[] = drawSecret()) {
    if (secret.length !== GUARD_HEAD_START || new Set(secret).size !== GUARD_HEAD_START || secret.some((id) => !byId.has(id))) throw new Error("SNEAK_BAD_SECRET");
    this.secret = [...secret].sort();
    this.knows = new Set(secret);
    this.salt = randomBytes(16).toString("hex");
    this.commitment = commitmentFor(this.salt, this.secret);
  }

  get over(): boolean { return this.end !== null; }
  get ending(): RunEnd | null { return this.end; }

  snapshot(): RunSnapshot {
    return { lives: this.lives, fooled: this.fooled, probes: this.probes, revealed: Object.fromEntries(this.revealed), probed: Object.fromEntries(this.probed), over: this.over };
  }

  move(kind: unknown, trickId: unknown): MoveResult {
    if (this.end) return { ok: false, code: "run_over" };
    if (kind !== "probe" && kind !== "wave") return { ok: false, code: "bad_kind" };
    const t = typeof trickId === "string" ? byId.get(trickId) : undefined;
    if (!t) return { ok: false, code: "unknown_trick" };
    if (this.revealed.has(t.id)) return { ok: false, code: "trick_spent" };

    if (kind === "probe") {
      if (this.probes === 0) return { ok: false, code: "no_probes_left" };
      if (this.probed.has(t.id)) return { ok: false, code: "already_probed" };
      this.probes--;
      const alert = this.knows.has(t.id);
      this.probed.set(t.id, alert ? "alert" : "blind");
      return { ok: true, kind, trick: t.id, alert, state: this.snapshot(), end: null };
    }

    const knew = this.knows.has(t.id);
    const wave = simulateWave(t, knew);
    if (wave.breach) { this.fooled++; this.knows.add(t.id); this.revealed.set(t.id, "learned"); }
    else { this.lives--; this.revealed.set(t.id, "knew"); }
    if (this.lives <= 0) this.finish("lives");
    else if (this.knows.size >= TRICKS.length) this.finish("all");
    return { ok: true, kind, trick: t.id, outcome: wave.breach ? "learned" : "knew", wave, state: this.snapshot(), end: this.end };
  }

  private finish(why: Ending): void {
    const best = TRICKS.length - GUARD_HEAD_START;
    const outcome: Outcome = this.fooled === best && this.lives === START_LIVES ? "flawless"
      : this.fooled === best && this.lives === START_LIVES - 1 ? "one_life_lost" : "other";
    this.end = { why, fooled: this.fooled, lives: this.lives, outcome, reveal: { salt: this.salt, knows: [...this.secret] } };
  }
}

/** What the page needs to draw the deck. Public: no part of any run's secret. */
export function publicTricks() {
  return TRICKS.map(({ id, name, pitch, n, quote, actual, burst, door, rule, real }) => ({ id, name, pitch, n, quote, actual, burst: !!burst, door: !!door, rule, real }));
}
