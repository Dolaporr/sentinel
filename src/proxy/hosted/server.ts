/**
 * Sentinel hosted: governed inference with a key the caller never sees.
 *
 *   agent -> POST /v1/chat/completions, Authorization: Bearer snt_<token>
 *         -> kill switch, token, rate limit, body, allowlist
 *         -> shared pool (first), then this token's own governor
 *         -> upstream with the operator's key, which never leaves this process
 *         -> commit exact cost to both ceilings, write the ledger, pass through
 *
 * Unlike the local proxy, this binds publicly: the bearer token is real
 * authentication here, not a label, because every spend-capable request has
 * to present a token this server issued and has not revoked.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AdmissionRefusalReason, PriceEntry } from "../../governor/types.js";
import { buildLedgerViewModel, CallLedger, type CallLedgerEntry } from "../call-ledger.js";
import { dispatchAdmitted } from "../dispatch.js";
import { modelsBody, readBody, sendJson, worstCaseUsd } from "../http.js";
import { deriveInputTokens } from "../messages.js";
import type { Provider } from "../providers/types.js";
import { GlobalPool, TenantGovernors } from "./ceilings.js";
import { RateLimiter } from "./rate-limit.js";
import { sanitizeHostedBody } from "./sanitize.js";
import {
  adminTokenMatches, canonicalInviteCode, newHandle, newInviteCode, newUserToken, sha256, userTokenHashFromHeader
} from "./secrets.js";
import { HostedStateStore, utcDateKey, type HostedConfig } from "./state.js";

const LEDGER_PAGE_PATH = fileURLToPath(new URL("../ledger.html", import.meta.url));
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ADMIN_BODY_BYTES = 64 * 1024;
const MAX_INVITES_PER_CALL = 100;

const usd = (value: number) => `$${value.toFixed(4)}`;

export interface HostedServerConfig {
  port: number;
  host: string;
  provider: Provider;
  upstreamUrl: string;
  /** The operator's gateway key. Lives in this field and in the outgoing request header, nowhere else. */
  apiKey: string;
  adminToken: string;
  prices: Readonly<Record<string, PriceEntry>>;
  priceSource: string;
  priceVerifiedAt: string;
  unboundableModels?: ReadonlySet<string>;
  statePath: string;
  callLedgerPath: string;
  /** Used only the first time the state file is created; afterwards /admin/config owns the values. */
  seedConfig: HostedConfig;
  reservationTtlMs: number;
  reservationSafetyMultiplier: number;
  defaultMaxTokens: number;
  clock?: () => Date;
}

type ErrorBody = { error: { message: string; type: string; code: string; param: string | null } };
const err = (code: string, message: string, type = "invalid_request_error", param: string | null = null): ErrorBody =>
  ({ error: { message, type, code, param } });

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function untilLabel(now: Date, then: Date): string {
  const minutes = Math.max(1, Math.ceil((then.getTime() - now.getTime()) / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export class HostedGateway {
  readonly store: HostedStateStore;
  readonly pool: GlobalPool;
  readonly tenants: TenantGovernors;
  readonly callLedger: CallLedger;
  private readonly limiter: RateLimiter;
  private readonly clock: () => Date;
  private readonly ledgerPageHtml: string;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  /**
   * Set when spend could not be written to disk. Every later request is
   * refused: serving on would spend money this process could not account
   * for after a restart, which is the one thing the cap exists to prevent.
   */
  private storageFault: string | null = null;
  private attemptSeq = 0;

  constructor(private readonly config: HostedServerConfig) {
    this.clock = config.clock ?? (() => new Date());
    this.store = new HostedStateStore(config.statePath, config.seedConfig, this.clock);
    this.pool = new GlobalPool(this.store);
    this.tenants = new TenantGovernors(this.store, {
      reservationTtlMs: config.reservationTtlMs,
      reservationSafetyMultiplier: config.reservationSafetyMultiplier,
      prices: () => config.prices
    });
    this.callLedger = new CallLedger(config.callLedgerPath);
    this.limiter = new RateLimiter(() => this.clock().getTime());
    try {
      this.ledgerPageHtml = readFileSync(LEDGER_PAGE_PATH, "utf8");
    } catch {
      this.ledgerPageHtml = `<!doctype html><meta charset="utf-8"><p>Ledger page missing from this build. Data: <a href="/ledger.json">/ledger.json</a>.</p>`;
    }
  }

  /** Allowlisted models this deployment can actually price. */
  servedModels(): string[] {
    return this.store.config.modelAllowlist.filter((id) => this.config.prices[id]).sort();
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? "").split("?")[0];
    const method = req.method ?? "GET";

    if (url.startsWith("/admin/") || url === "/admin") { await this.handleAdmin(req, res, url, method); return; }
    if (method === "GET" && url === "/") { this.servePage(res); return; }
    if (method === "GET" && url === "/ledger.json") { sendJson(res, 200, this.ledgerView()); return; }
    if (method === "GET" && url === "/healthz") { sendJson(res, 200, this.health()); return; }
    if (method === "GET" && url === "/v1/models") {
      const served = Object.fromEntries(this.servedModels().map((id) => [id, this.config.prices[id]]));
      sendJson(res, 200, modelsBody(served, this.config.provider.name));
      return;
    }
    if (method === "POST" && url === "/v1/redeem") { await this.handleRedeem(req, res); return; }
    if (method === "POST" && url === "/v1/chat/completions") { await this.handleCompletion(req, res); return; }
    sendJson(res, 404, err("not_found", "Sentinel hosted serves POST /v1/chat/completions, GET /v1/models, POST /v1/redeem, GET / (ledger) and GET /healthz."));
  }

  // ---------------------------------------------------------------- user path

  private async handleCompletion(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = this.clock();
    const config = this.store.config;

    // Kill switch and storage fault come before authentication: when either is
    // on, nothing is served to anyone, and saying so leaks nothing.
    if (config.paused) {
      sendJson(res, 503, err("sentinel_paused", "Sentinel's free tier is paused by its operator. Nothing was sent upstream and nothing was charged.", "service_unavailable"));
      return;
    }
    if (this.storageFault) {
      sendJson(res, 503, err("sentinel_storage_fault", "Sentinel cannot record spend right now, so it is refusing every request rather than spend money it could not account for.", "service_unavailable"));
      return;
    }

    const tokenHash = userTokenHashFromHeader(req.headers.authorization);
    const token = tokenHash ? this.store.findToken(tokenHash) : undefined;
    if (!token) {
      sendJson(res, 401, err("sentinel_invalid_token", "Sentinel hosted needs a token issued from an invite code: Authorization: Bearer snt_... . Redeem a code with POST /v1/redeem.", "authentication_error"));
      return;
    }
    if (token.revokedAt) {
      sendJson(res, 401, err("sentinel_token_revoked", "This Sentinel token has been revoked by the operator.", "authentication_error"));
      return;
    }
    const handle = token.handle;

    const rate = this.limiter.check(handle, config.requestsPerMinute);
    if (!rate.ok) {
      // Not written to the ledger: a client hammering the limit would
      // otherwise fill the public page and the disk with its own refusals.
      sendJson(res, 429, err("sentinel_rate_limited", `Rate limit: ${config.requestsPerMinute} requests per minute per token. Retry in ${rate.retryAfterSeconds}s.`, "rate_limit_error"), { "retry-after": String(rate.retryAfterSeconds) });
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString("utf8"));
    } catch (error) {
      sendJson(res, 400, err("invalid_body", `Malformed request body: ${error instanceof Error && error.message.startsWith("request body exceeds") ? error.message : "not valid JSON"}.`));
      return;
    }
    const clean = sanitizeHostedBody(raw);
    if (!clean.ok) { sendJson(res, 400, err(clean.code, clean.message, "invalid_request_error", clean.param)); return; }

    const { model, body } = clean;
    const streaming = body.stream === true;
    const attemptId = `hosted:${handle}:${now.getTime()}:${++this.attemptSeq}`;
    const price = this.config.prices[model];
    // Only a model id this server already knows reaches the public ledger --
    // anything else is free text a caller chose, on a page anyone can read.
    const ledgerModel = price ? model : "unlisted-model";

    if (!config.modelAllowlist.includes(model)) {
      this.recordRefusal(attemptId, handle, ledgerModel, "MODEL_NOT_ALLOWED", null, this.tokenRemaining(handle), streaming);
      sendJson(res, 403, err("sentinel_model_not_allowed", `Sentinel's free tier serves only: ${this.servedModels().join(", ") || "(none configured)"}. \`${model}\` is not on the list.`, "permission_error", "model"));
      return;
    }
    if (!price) {
      const unboundable = this.config.unboundableModels?.has(model) ?? false;
      this.recordRefusal(attemptId, handle, ledgerModel, "MODEL_UNPRICED", null, this.tokenRemaining(handle), streaming);
      sendJson(res, 402, err(unboundable ? "sentinel_model_unboundable" : "sentinel_model_unpriced",
        `Sentinel refused ${model}: no verified per-token price, so its worst case is unknowable.`, "budget_exceeded", "model"));
      return;
    }

    const inputTokens = deriveInputTokens(body);
    const maxTokens = clean.declaredMaxTokens ?? this.config.defaultMaxTokens;
    const worstCase = worstCaseUsd(price, inputTokens, maxTokens, this.config.reservationSafetyMultiplier);
    const resetsAt = nextUtcMidnight(now);
    const resetLabel = `00:00 UTC, in ${untilLabel(now, resetsAt)}`;

    // Ceiling 1: the shared pool, before anything about this token.
    const held = this.pool.tryReserve(attemptId, worstCase);
    if (!held.ok) {
      const reason = held.exhausted ? "POOL_EXHAUSTED" : "POOL_INSUFFICIENT";
      this.recordRefusal(attemptId, handle, model, reason, worstCase, held.remainingUsd, streaming);
      const message = held.exhausted
        ? `Sentinel's shared free pool is used up for today (${usd(held.committedUsd)} of ${usd(held.capUsd)}). It resets at ${resetLabel}. Nothing was sent or charged.`
        : `This request's worst case ${usd(worstCase)} is more than today's shared free pool has left (${usd(held.remainingUsd)}). Lower max_tokens, or wait for the reset at ${resetLabel}.`;
      sendJson(res, 402, err(held.exhausted ? "sentinel_pool_exhausted" : "sentinel_pool_insufficient", message, "budget_exceeded"), {
        "x-sentinel-refusal": reason, "x-sentinel-worst-case-usd": String(worstCase), "x-sentinel-pool-remaining-usd": String(held.remainingUsd)
      });
      return;
    }

    let poolSettled = false;
    try {
      // Ceiling 2: this token's own daily cap, in its own governor.
      if (this.tenants.capReached(handle)) {
        this.recordRefusal(attemptId, handle, model, "TOKEN_DAILY_CAP_REACHED", worstCase, 0, streaming);
        sendJson(res, 402, err("sentinel_token_daily_cap_reached",
          `This token has used its ${usd(this.tenants.capUsd())} for today. It resets at ${resetLabel}.`, "budget_exceeded"),
          { "x-sentinel-refusal": "TOKEN_DAILY_CAP_REACHED" });
        return;
      }
      const governor = this.tenants.governorFor(handle);
      const admission = await governor.reserve({ attemptId, logicalCallId: attemptId, model, inputTokens, maxTokens });
      if (!admission.admitted) {
        const remaining = this.tokenRemaining(handle);
        this.recordRefusal(attemptId, handle, model, admission.reason, worstCase, remaining, streaming);
        console.log(`[refused] ${handle} ${admission.reason} model=${model} worst_case=${usd(worstCase)} remaining=${usd(remaining)}`);
        sendJson(res, 402, err(...this.tokenRefusal(admission.reason, worstCase, remaining, resetLabel), "budget_exceeded"), {
          "x-sentinel-refusal": admission.reason, "x-sentinel-worst-case-usd": String(worstCase), "x-sentinel-remaining-usd": String(remaining)
        });
        return;
      }

      const { reservation } = admission;
      console.log(`[admitted] ${handle} ${attemptId} model=${model} input_tokens=${inputTokens} max_tokens=${maxTokens} reserved=${usd(reservation.amountUsd)} streaming=${streaming}`);

      const settle = (costUsd: number, costSource: "exact" | "estimated", isStream: boolean) => {
        this.pool.settle(attemptId);
        poolSettled = true;
        try {
          this.store.recordSpend(handle, costUsd);
        } catch (error) {
          this.storageFault = error instanceof Error ? error.message : String(error);
          console.error(`[storage] FAILED to persist spend; refusing all further requests: ${this.storageFault}`);
        }
        this.callLedger.record({
          attempt_id: attemptId, agent: handle, model, admitted: true, cost_usd: costUsd, cost_source: costSource,
          refusal_reason: null, worst_case_usd: reservation.amountUsd, budget_remaining_usd: this.tokenRemaining(handle), streaming: isStream
        });
      };

      await dispatchAdmitted({
        upstreamUrl: this.config.upstreamUrl,
        provider: this.config.provider,
        apiKey: this.config.apiKey,
        body: { ...body, max_tokens: maxTokens },
        streaming,
        reservation,
        res,
        headers: {
          "x-sentinel-reserved-usd": String(reservation.amountUsd),
          "x-sentinel-max-tokens": String(maxTokens),
          "x-sentinel-max-tokens-injected": String(clean.declaredMaxTokens === null)
        },
        redactClientBodies: true,
        logUpstreamErrorBodies: false,
        // 401/402 from upstream mean the operator's key was rejected or is out
        // of credit. Orbio's own body for this talks about client-side
        // encryption setup -- true for the key's owner, actively misleading
        // for a caller who has never seen that key.
        replaceUpstreamError: (status) => {
          if (status !== 401 && status !== 402) return null;
          console.error(`[OPERATOR] upstream returned ${status} for the operator's key -- every request will fail until it is fixed or funded`);
          return {
            status: 503,
            body: err("sentinel_upstream_credentials", "Sentinel's upstream provider rejected the operator's credentials or balance. This is on Sentinel's side, not yours; nothing was generated.", "service_unavailable")
          };
        },
        sink: {
          exact: async (costUsd, isStream) => {
            await governor.commitExact(attemptId, costUsd);
            // Recorded whether or not the governor accepted it as on time:
            // the gateway billed it either way, and the pool must know.
            settle(costUsd, "exact", isStream);
          },
          estimated: async (reason, isStream, outputTokens) => {
            const before = governor.snapshot().committedEstimated;
            const accepted = await governor.commitEstimated(attemptId, reason, outputTokens);
            const amount = accepted ? Math.max(0, governor.snapshot().committedEstimated - before) : reservation.amountUsd;
            settle(Math.round(amount * 1e9) / 1e9, "estimated", isStream);
          }
        }
      });
    } finally {
      // Every path out releases the pool hold exactly once: refused, settled,
      // or something threw in between.
      if (!poolSettled) this.pool.release(attemptId);
    }
  }

  private tokenRefusal(reason: AdmissionRefusalReason, worstCase: number, remaining: number, resetLabel: string): [string, string] {
    switch (reason) {
      case "BUDGET_EXCEEDED":
        return ["sentinel_budget_exceeded", `This request's worst case ${usd(worstCase)} exceeds what this token has left today (${usd(remaining)}). Lower max_tokens, or wait for the reset at ${resetLabel}.`];
      case "QUARANTINED":
        return ["sentinel_quarantined", "This token's accounting was halted after a call cost more than Sentinel reserved for it. It stays halted until the operator restarts the service. Other tokens are unaffected."];
      case "MODEL_UNPRICED":
        return ["sentinel_model_unpriced", "No verified per-token price for this model, so its worst case is unknowable."];
      default:
        return [`sentinel_${reason.toLowerCase()}`, `Sentinel refused: ${reason.replace(/_/g, " ").toLowerCase()}.`];
    }
  }

  private tokenRemaining(handle: string): number {
    return Math.max(0, Math.round((this.tenants.capUsd() - this.tenants.spentTodayUsd(handle)) * 1e9) / 1e9);
  }

  private recordRefusal(attemptId: string, handle: string, model: string, reason: string, worstCase: number | null, remaining: number, streaming: boolean): void {
    this.callLedger.record({
      attempt_id: attemptId, agent: handle, model, admitted: false, cost_usd: null, cost_source: null,
      refusal_reason: reason, worst_case_usd: worstCase, budget_remaining_usd: remaining, streaming
    });
  }

  private async handleRedeem(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let code = "";
    try {
      const parsed = JSON.parse((await readBody(req, 4096)).toString("utf8")) as { code?: unknown };
      code = typeof parsed.code === "string" ? canonicalInviteCode(parsed.code) : "";
    } catch { /* falls through to the invalid-code answer */ }
    // One answer for unknown, malformed, used and voided codes: the response
    // must not tell a guesser which codes exist.
    const invalid = () => sendJson(res, 400, err("sentinel_invite_invalid", "That invite code is not valid, or has already been used."));
    if (!code) { invalid(); return; }

    const token = newUserToken();
    const handle = newHandle(new Set(this.store.tokens().map((t) => t.handle)));
    const outcome = this.store.redeem(sha256(code), sha256(token), handle);
    if (outcome !== "ok") { invalid(); return; }
    console.log(`[redeem] invite redeemed -> ${handle}`);
    sendJson(res, 201, {
      token,
      handle,
      note: "Shown once. Sentinel stores only a hash of this token; if you lose it, ask for a new invite.",
      usage: "Use as an OpenAI-compatible API key: base URL <this host>/v1, Authorization: Bearer <token>.",
      daily_cap_usd: this.tenants.capUsd(),
      models: this.servedModels()
    });
  }

  // --------------------------------------------------------------- admin path

  private async handleAdmin(req: IncomingMessage, res: ServerResponse, url: string, method: string): Promise<void> {
    // Same answer for a missing, wrong, or user token: an snt_ bearer never
    // reaches the comparison at all.
    if (!adminTokenMatches(req.headers.authorization, this.config.adminToken)) {
      sendJson(res, 401, err("sentinel_admin_unauthorized", "Admin authentication required.", "authentication_error"));
      return;
    }
    let body: Record<string, unknown> = {};
    if (method === "POST" || method === "PATCH") {
      try {
        const raw = (await readBody(req, MAX_ADMIN_BODY_BYTES)).toString("utf8");
        body = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
      } catch {
        sendJson(res, 400, err("invalid_body", "Admin request body must be JSON."));
        return;
      }
    }

    if (method === "POST" && url === "/admin/invites") {
      const count = Math.min(MAX_INVITES_PER_CALL, Math.max(1, Math.floor(Number(body.count ?? 1)) || 1));
      const codes = Array.from({ length: count }, () => newInviteCode());
      this.store.addInvites(codes.map((c) => sha256(c)));
      console.log(`[admin] issued ${count} invite code(s)`);
      sendJson(res, 201, { codes, note: "Shown once. Sentinel stores only hashes of these codes." });
      return;
    }
    if (method === "GET" && url === "/admin/tokens") {
      const today = this.store.today();
      sendJson(res, 200, {
        date: today.date,
        tokens: this.store.tokens().map((t) => ({
          handle: t.handle, created_at: t.createdAt, revoked_at: t.revokedAt,
          spent_today_usd: today.byHandle[t.handle] ?? 0, quarantined: this.tenants.quarantined(t.handle)
        })),
        invites: { issued: this.store.invites().length, redeemed: this.store.invites().filter((i) => i.redeemedAt).length }
      });
      return;
    }
    const revokeOne = /^\/admin\/tokens\/([a-z0-9_-]{1,40})\/revoke$/.exec(url);
    if (method === "POST" && revokeOne) {
      const handle = revokeOne[1];
      if (!this.store.revoke(handle)) { sendJson(res, 404, err("not_found", `No token with handle ${handle}.`)); return; }
      this.tenants.forget(handle);
      console.log(`[admin] revoked ${handle}`);
      sendJson(res, 200, { revoked: handle });
      return;
    }
    if (method === "POST" && url === "/admin/revoke-all") {
      const count = this.store.revokeAll();
      for (const t of this.store.tokens()) this.tenants.forget(t.handle);
      console.log(`[admin] revoked all tokens (${count}) and voided unredeemed invites`);
      sendJson(res, 200, { revoked: count, unredeemed_invites_voided: true });
      return;
    }
    if (method === "POST" && (url === "/admin/pause" || url === "/admin/resume")) {
      const paused = url === "/admin/pause";
      this.store.updateConfig({ paused });
      console.log(`[admin] ${paused ? "PAUSED - all user requests refused" : "resumed"}`);
      sendJson(res, 200, { paused });
      return;
    }
    if (url === "/admin/config" && (method === "GET" || method === "PATCH")) {
      if (method === "PATCH") {
        const allowed: Array<keyof HostedConfig> = ["poolDailyCapUsd", "tokenDailyCapUsd", "modelAllowlist", "requestsPerMinute", "paused"];
        const unknown = Object.keys(body).filter((k) => !allowed.includes(k as keyof HostedConfig));
        if (unknown.length) { sendJson(res, 400, err("invalid_config", `Unknown config field(s): ${unknown.join(", ")}.`)); return; }
        const result = this.store.updateConfig(body as Partial<HostedConfig>);
        if (!result.ok) { sendJson(res, 400, err("invalid_config", result.error)); return; }
        console.log(`[admin] config updated: ${Object.keys(body).join(", ")}`);
      }
      const unpriced = this.store.config.modelAllowlist.filter((id) => !this.config.prices[id]);
      sendJson(res, 200, { config: this.store.config, allowlisted_but_unpriced: unpriced });
      return;
    }
    sendJson(res, 404, err("not_found", "Unknown admin route."));
  }

  // ----------------------------------------------------------- public reads

  private servePage(res: ServerResponse): void {
    const payload = Buffer.from(this.ledgerPageHtml, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": payload.length });
    res.end(payload);
  }

  ledgerView() {
    const now = this.clock();
    const entries: CallLedgerEntry[] = this.callLedger.readToday(now, utcDateKey);
    const config = this.store.config;
    return {
      ...buildLedgerViewModel(entries, config.poolDailyCapUsd, now, utcDateKey),
      hosted: {
        poolCapUsd: config.poolDailyCapUsd,
        poolCommittedUsd: this.pool.committedUsd(),
        poolRemainingUsd: Math.max(0, Math.round((config.poolDailyCapUsd - this.pool.committedUsd()) * 1e9) / 1e9),
        tokenDailyCapUsd: config.tokenDailyCapUsd,
        models: this.servedModels(),
        resetsAt: nextUtcMidnight(now).toISOString(),
        paused: config.paused
      }
    };
  }

  private health() {
    const config = this.store.config;
    return {
      status: this.storageFault ? "storage_fault" : config.paused ? "paused" : this.pool.exhausted() ? "pool_exhausted" : "ok",
      provider: this.config.provider.name,
      cost_reporting: this.config.provider.costReporting,
      key_configured: true,
      pool: { cap_usd: config.poolDailyCapUsd, committed_usd: this.pool.committedUsd(), reserved_usd: this.pool.reservedUsd(), remaining_usd: this.pool.remainingUsd() },
      token_daily_cap_usd: config.tokenDailyCapUsd,
      requests_per_minute: config.requestsPerMinute,
      models: this.servedModels(),
      price_source: this.config.priceSource,
      price_verified_at: this.config.priceVerifiedAt,
      date_utc: this.store.today().date
    };
  }

  listen(): ReturnType<typeof createServer> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        // Never the error's own text: it could carry anything, including what
        // a request contained. The log gets the name, the client gets nothing.
        console.error(`[hosted] unhandled ${error instanceof Error ? error.name : "error"}`);
        if (!res.headersSent) sendJson(res, 500, err("internal", "Sentinel hosted failed on this request.", "api_error"));
        else res.end();
      });
    });
    this.sweeper = setInterval(() => { void this.tenants.expireAll(); this.limiter.sweep(); }, 5_000);
    this.sweeper.unref();
    server.listen(this.config.port, this.config.host, () => {
      const config = this.store.config;
      console.log(`Sentinel hosted listening on http://${this.config.host}:${this.config.port}`);
      console.log(`  provider          ${this.config.provider.name} (${this.config.provider.costReporting === "exact" ? "reports exact cost per call" : "cost is Sentinel's estimate"})`);
      console.log(`  upstream key      held in this process only (${this.config.provider.apiKeyEnvVar})`);
      console.log(`  shared pool       ${usd(config.poolDailyCapUsd)} per UTC day, ${usd(this.pool.committedUsd())} committed`);
      console.log(`  per-token cap     ${usd(config.tokenDailyCapUsd)} per UTC day`);
      console.log(`  rate limit        ${config.requestsPerMinute} requests/minute/token`);
      console.log(`  models            ${this.servedModels().join(", ") || "(none - every request will be refused)"}`);
      console.log(`  tokens            ${this.store.tokens().filter((t) => !t.revokedAt).length} active, ${this.store.tokens().filter((t) => t.revokedAt).length} revoked`);
      console.log(`  paused            ${config.paused}`);
      console.log(`  ledger            public at /, metadata only - never prompt or completion content`);
    });
    return server;
  }
}
