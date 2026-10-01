/**
 * Everything the hosted service must remember across a restart or a redeploy,
 * in one JSON file: runtime config, invite codes, tokens, revocations, and
 * today's spend per token and for the shared pool.
 *
 * One file, rewritten atomically (temp + rename) on every change, so a crash
 * mid-write leaves the previous version intact rather than a truncated one.
 * Durability matters here for the same reason it does locally (spend.ts):
 * a redeploy that forgot today's spend would hand every token a fresh budget,
 * and one that forgot a revocation would bring a killed token back.
 *
 * A corrupt file fails startup instead of being replaced with defaults --
 * starting clean would silently un-revoke every token and zero every cap.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const utcDateKey = (now: Date) => now.toISOString().slice(0, 10);

const round = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

/** Adjustable at runtime through /admin/config; never needs a redeploy. */
export interface HostedConfig {
  /** Shared ceiling across every token. Checked first. */
  poolDailyCapUsd: number;
  /** Each token's own ceiling. */
  tokenDailyCapUsd: number;
  /** The anti-resale control: only these models are served. */
  modelAllowlist: string[];
  /** Per token, independent of spend. */
  requestsPerMinute: number;
  /** When true, every user request is refused. Reversible, unlike revoking. */
  paused: boolean;
}

export interface InviteRecord {
  codeHash: string;
  createdAt: string;
  redeemedAt: string | null;
  /** The handle of the token this code produced, once redeemed. */
  handle: string | null;
  /** Set by revoke-all on codes nobody had redeemed yet. */
  voidedAt?: string | null;
}

export interface TokenRecord {
  tokenHash: string;
  handle: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface SpendDay {
  date: string;
  poolCommittedUsd: number;
  byHandle: Record<string, number>;
}

export interface HostedState {
  version: 1;
  config: HostedConfig;
  invites: InviteRecord[];
  tokens: TokenRecord[];
  spend: SpendDay;
}

export class HostedStateError extends Error {}

export function validateConfig(config: HostedConfig): string | null {
  const positive = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (!positive(config.poolDailyCapUsd)) return "poolDailyCapUsd must be a positive number";
  if (!positive(config.tokenDailyCapUsd)) return "tokenDailyCapUsd must be a positive number";
  if (!positive(config.requestsPerMinute) || !Number.isInteger(config.requestsPerMinute)) return "requestsPerMinute must be a positive integer";
  if (!Array.isArray(config.modelAllowlist) || config.modelAllowlist.some((m) => typeof m !== "string" || !m)) return "modelAllowlist must be a list of model ids";
  if (typeof config.paused !== "boolean") return "paused must be true or false";
  return null;
}

export class HostedStateStore {
  private state: HostedState;

  constructor(private readonly filePath: string, seedConfig: HostedConfig, private readonly clock: () => Date = () => new Date()) {
    if (existsSync(filePath)) {
      let parsed: HostedState;
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf8")) as HostedState;
      } catch (error) {
        throw new HostedStateError(`State file ${filePath} exists but is not valid JSON (${error instanceof Error ? error.message : String(error)}). Refusing to start: replacing it would un-revoke every token and reset every cap. Fix or move it aside deliberately.`);
      }
      const problem = parsed?.version !== 1 ? "unknown version" : validateConfig(parsed.config);
      if (problem) throw new HostedStateError(`State file ${filePath} is not usable: ${problem}. Refusing to start.`);
      this.state = parsed;
    } else {
      const problem = validateConfig(seedConfig);
      if (problem) throw new HostedStateError(`Seed config invalid: ${problem}.`);
      this.state = { version: 1, config: { ...seedConfig }, invites: [], tokens: [], spend: { date: utcDateKey(this.clock()), poolCommittedUsd: 0, byHandle: {} } };
      this.save();
    }
  }

  get config(): Readonly<HostedConfig> { return this.state.config; }

  updateConfig(patch: Partial<HostedConfig>): { ok: true; config: HostedConfig } | { ok: false; error: string } {
    const next = { ...this.state.config, ...patch };
    const problem = validateConfig(next);
    if (problem) return { ok: false, error: problem };
    this.state.config = next;
    this.save();
    return { ok: true, config: next };
  }

  /** Today's spend, rolled to a fresh day at 00:00 UTC. */
  today(): Readonly<SpendDay> {
    const date = utcDateKey(this.clock());
    if (this.state.spend.date !== date) {
      this.state.spend = { date, poolCommittedUsd: 0, byHandle: {} };
      this.save();
    }
    return this.state.spend;
  }

  /** One commit lands in both the pool total and the token's own total, in one write. */
  recordSpend(handle: string, costUsd: number): void {
    const day = this.today() as SpendDay;
    day.poolCommittedUsd = round(day.poolCommittedUsd + costUsd);
    day.byHandle[handle] = round((day.byHandle[handle] ?? 0) + costUsd);
    this.save();
  }

  tokens(): readonly TokenRecord[] { return this.state.tokens; }
  invites(): readonly InviteRecord[] { return this.state.invites; }

  findToken(tokenHash: string): TokenRecord | undefined {
    return this.state.tokens.find((t) => t.tokenHash === tokenHash);
  }

  findTokenByHandle(handle: string): TokenRecord | undefined {
    return this.state.tokens.find((t) => t.handle === handle);
  }

  addInvites(codeHashes: string[]): void {
    const createdAt = this.clock().toISOString();
    for (const codeHash of codeHashes) this.state.invites.push({ codeHash, createdAt, redeemedAt: null, handle: null });
    this.save();
  }

  /**
   * Redeem once. Synchronous from lookup to save, so two concurrent requests
   * with the same code cannot both pass the "not yet redeemed" check -- Node
   * runs this to completion before the second request's handler resumes.
   */
  redeem(codeHash: string, tokenHash: string, handle: string): "ok" | "unknown" | "already_redeemed" | "voided" {
    const invite = this.state.invites.find((i) => i.codeHash === codeHash);
    if (!invite) return "unknown";
    if (invite.redeemedAt) return "already_redeemed";
    if (invite.voidedAt) return "voided";
    const now = this.clock().toISOString();
    invite.redeemedAt = now;
    invite.handle = handle;
    this.state.tokens.push({ tokenHash, handle, createdAt: now, revokedAt: null });
    this.save();
    return "ok";
  }

  revoke(handle: string): boolean {
    const token = this.findTokenByHandle(handle);
    if (!token) return false;
    token.revokedAt ??= this.clock().toISOString();
    this.save();
    return true;
  }

  revokeAll(): number {
    const now = this.clock().toISOString();
    let count = 0;
    for (const token of this.state.tokens) {
      if (!token.revokedAt) { token.revokedAt = now; count++; }
    }
    // Unredeemed invites would mint fresh, unrevoked tokens the moment after a
    // revoke-all; killing every token has to kill every way to get one too.
    for (const invite of this.state.invites) {
      if (!invite.redeemedAt) invite.voidedAt ??= now;
    }
    this.save();
    return count;
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    renameSync(tmp, this.filePath);
  }
}
