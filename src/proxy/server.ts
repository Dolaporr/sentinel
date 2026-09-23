import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { BudgetGovernor } from "../governor/governor.js";
import { ReservationLedger } from "../governor/ledger.js";
import type { AdmissionRefusalReason, PriceEntry, Reservation } from "../governor/types.js";
import { BIND_HOST, UPSTREAM_URL, loadConfig, type ProxyConfig } from "./config.js";
import { priceDrift, resolvePriceTable } from "./prices.js";
import { DailySpendStore, resolveDailyBudget } from "./spend.js";
import { deriveInputTokens, estimateOutputTokens, type ChatCompletionRequest } from "./messages.js";

const ROUTE = "/v1/chat/completions";
const MODELS_ROUTE = "/v1/models";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const round = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

/**
 * Upstream error bodies are echoed into our logs, and a gateway that reflects
 * the submitted key in an error would otherwise write it to disk. The key is
 * never logged deliberately; this is the accidental path.
 */
function redact(text: string, secret: string | undefined): string {
  return secret && secret.length >= 8 ? text.split(secret).join("[redacted]") : text;
}
const usd = (value: number) => `$${value.toFixed(4)}`;
const usd6 = (value: number) => `$${value.toFixed(6)}`;
const perMillion = (value: number) => `$${value.toFixed(4)}/M`;

/**
 * Why admissions stopped. A quarantined proxy refuses everything until it is
 * restarted, so the refusal has to carry enough to act on: which call broke the
 * accounting, what the table promised, what was actually charged.
 */
export interface QuarantineCause {
  kind: "over_reservation" | "late_result";
  model: string;
  reservedUsd: number;
  billedUsd: number | null;
  outputPerMillionUsd: number;
  attemptId: string;
}

function quarantineMessage(cause: QuarantineCause | null): string {
  const resume = "Restart the proxy to refetch prices from the gateway and resume.";
  if (!cause) {
    return `Sentinel has halted admissions after a ledger integrity fault, and cannot bound any further call until it is reset. ${resume}`;
  }
  if (cause.kind === "late_result") {
    return `Sentinel has halted admissions: a result for ${cause.model} arrived after its reservation had already expired or been settled, so ${usd6(cause.reservedUsd)} of budget was accounted twice. Further calls cannot be bounded correctly. ${resume}`;
  }
  return `Sentinel has halted admissions: ${cause.model} was advertised at ${perMillion(cause.outputPerMillionUsd)} output, so the call reserved ${usd6(cause.reservedUsd)} — but it billed ${usd6(cause.billedUsd ?? 0)}, more than was reserved. The price table is wrong for this model, so no further call can be bounded correctly. ${resume}`;
}

/**
 * Mirrors BudgetGovernor.estimateWorstCase, which is private. The proxy needs the
 * number before it has a reservation, because a refusal must tell the caller what
 * it was refused for. Keep in sync with src/governor/governor.ts.
 */
function worstCaseUsd(price: PriceEntry, inputTokens: number, maxTokens: number, multiplier: number): number {
  return round(((inputTokens * price.inputPerMillionUsd + maxTokens * price.outputPerMillionUsd) / 1_000_000) * multiplier);
}

/**
 * §2 step 4: every governor refusal is an HTTP 402 with a body the calling tool
 * will surface to a human. Cursor and Codex print `error.message` verbatim, so
 * the message carries the numbers rather than a bare code.
 */
function refusalBody(reason: AdmissionRefusalReason, context: { worstCase: number; remaining: number; model: string; unboundable: boolean; quarantineCause: QuarantineCause | null }) {
  const shapes: Record<AdmissionRefusalReason, { type: string; code: string; message: string }> = {
    BUDGET_EXCEEDED: {
      type: "budget_exceeded",
      code: "sentinel_budget_exceeded",
      message: `Sentinel refused: worst case ${usd(context.worstCase)} exceeds remaining budget ${usd(context.remaining)}`
    },
    MODEL_UNPRICED: {
      type: "budget_exceeded",
      code: context.unboundable ? "sentinel_model_unboundable" : "sentinel_model_unpriced",
      message: context.unboundable
        ? `Sentinel refused ${context.model}: no per-token price - this model may bill per asset, so the budget can't bound it.`
        : `Sentinel refused: no verified price entry for ${context.model}, so its worst case is unknowable. Refusing rather than assuming a price.`
    },
    QUARANTINED: {
      type: "budget_exceeded",
      code: "sentinel_quarantined",
      message: quarantineMessage(context.quarantineCause)
    },
    DUPLICATE_ATTEMPT: {
      type: "budget_exceeded",
      code: "sentinel_duplicate_attempt",
      message: `Sentinel refused: duplicate attempt id.`
    },
    LOGICAL_CALL_IN_FLIGHT: {
      type: "budget_exceeded",
      code: "sentinel_call_in_flight",
      message: `Sentinel refused: an attempt for this logical call is already in flight.`
    }
  };
  return { error: { ...shapes[reason], param: null } };
}

/**
 * Synthesised from the price table already resident in memory at startup, not
 * proxied live to the gateway. Most OpenAI-compatible clients -- Cursor is
 * confirmed to -- GET this on connect to populate a model dropdown and confirm
 * the endpoint is real, before the user can even attempt a completion. Serving
 * it from the table we already loaded costs nothing per connect and lists
 * exactly the models this proxy can actually admit; proxying it live would add
 * a gateway round trip to every client's connection check for no more truth,
 * since admission is checked against this same table regardless.
 */
function modelsBody(prices: Readonly<Record<string, PriceEntry>>): { object: "list"; data: Array<{ id: string; object: "model"; created: number; owned_by: string }> } {
  const data = Object.entries(prices)
    .map(([id, price]) => {
      const created = Math.floor(Date.parse(price.verifiedAt) / 1000);
      const slash = id.indexOf("/");
      return {
        id,
        object: "model" as const,
        created: Number.isFinite(created) ? created : 0,
        owned_by: slash === -1 ? "orbio" : id.slice(0, slash)
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { object: "list", data };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body exceeds 8MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Accumulates a passed-through SSE stream so usage can be read from its tail. */
export class StreamAccumulator {
  private buffered = "";
  private text = "";
  usage: Record<string, unknown> | null = null;
  sawDone = false;

  ingest(chunk: string): void {
    this.buffered += chunk;
    const lines = this.buffered.split("\n");
    this.buffered = lines.pop() ?? "";
    for (const line of lines) this.ingestLine(line.trim());
  }

  private ingestLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") { this.sawDone = true; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    if (!parsed || typeof parsed !== "object") return;
    const record = parsed as Record<string, unknown>;
    // §3: usage arrives on the terminating chunk, which carries no choices.
    if (record.usage && typeof record.usage === "object") this.usage = record.usage as Record<string, unknown>;
    const choices = record.choices;
    if (!Array.isArray(choices)) return;
    for (const choice of choices) {
      const delta = (choice as { delta?: { content?: unknown } })?.delta;
      if (delta && typeof delta.content === "string") this.text += delta.content;
    }
  }

  outputTokens(): number {
    const reported = this.usage?.completion_tokens;
    if (typeof reported === "number" && Number.isFinite(reported)) return reported;
    return estimateOutputTokens(this.text);
  }

  cost(): number | null {
    const cost = this.usage?.cost;
    return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
  }
}

export class SentinelProxy {
  private readonly governor: BudgetGovernor;
  readonly ledger: ReservationLedger;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private readonly spend: DailySpendStore;
  /** Spend committed today before this process started. */
  private readonly seeded: number;
  /** Set the moment admissions halt, so the refusal can explain itself. */
  private quarantineCause: QuarantineCause | null = null;

  constructor(private readonly config: ProxyConfig) {
    this.ledger = new ReservationLedger(config.ledgerPath);
    this.spend = new DailySpendStore(config.spendPath);
    this.seeded = config.seededSpendUsd ?? 0;
    this.governor = new BudgetGovernor(
      {
        budgetUsd: config.budgetUsd,
        reservationTtlMs: config.reservationTtlMs,
        reservationSafetyMultiplier: config.reservationSafetyMultiplier,
        maxStepBudgetFraction: config.maxStepBudgetFraction,
        prices: config.prices
      },
      this.ledger
    );
  }

  snapshot() { return this.governor.snapshot(); }

  /** Today's total: what was already committed when we started, plus ours. */
  dailyCommittedUsd(): number {
    const state = this.governor.snapshot();
    return round(this.seeded + state.committedExact + state.committedEstimated);
  }

  /**
   * Written after every commit, exact or estimated. A crash therefore loses at
   * most the call in flight, rather than the whole session's spend.
   */
  private async commitExactAndPersist(reservation: Reservation, costUsd: number): Promise<void> {
    const accepted = await this.governor.commitExact(reservation.attemptId, costUsd);
    this.noteQuarantine(reservation, accepted, costUsd);
    this.spend.record(this.dailyCommittedUsd());
  }

  private async commitEstimatedAndPersist(reservation: Reservation, reason: string, outputTokens?: number): Promise<void> {
    const accepted = await this.governor.commitEstimated(reservation.attemptId, reason, outputTokens);
    this.noteQuarantine(reservation, accepted, null);
    this.spend.record(this.dailyCommittedUsd());
  }

  /**
   * The governor quarantines through two doors: a cost above its reservation,
   * and a result arriving after its slot was gone. Both stop the proxy dead, so
   * both record what happened rather than leaving the next caller to guess.
   */
  private noteQuarantine(reservation: Reservation, accepted: boolean, costUsd: number | null): void {
    if (!this.governor.snapshot().quarantined || this.quarantineCause) return;
    const kind = accepted ? "over_reservation" : "late_result";
    this.quarantineCause = {
      kind,
      model: reservation.model,
      reservedUsd: reservation.amountUsd,
      billedUsd: costUsd,
      outputPerMillionUsd: reservation.outputPerMillionUsd,
      attemptId: reservation.attemptId
    };
    console.error(`[QUARANTINED] ${quarantineMessage(this.quarantineCause)}`);
  }

  private remainingUsd(): number {
    const state = this.governor.snapshot();
    return round(state.budgetUsd - state.committedExact - state.committedEstimated - state.reservedTotal);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && url === MODELS_ROUTE) {
      // Fail loud rather than hand back an empty list: an empty array renders as
      // a dropdown with nothing in it and no explanation, which is worse than an
      // error a client actually surfaces. resolvePriceTable's own fallback chain
      // means this should be unreachable in practice, but the route promises it.
      const models = Object.keys(this.config.prices).length;
      if (models === 0) {
        sendJson(res, 500, { error: { message: "Sentinel proxy has no usable price table; refusing to report an empty model list.", type: "api_error", code: "sentinel_no_price_table", param: null } });
        return;
      }
      sendJson(res, 200, modelsBody(this.config.prices));
      return;
    }
    if (req.method === "GET" && url === "/healthz") {
      const state = this.governor.snapshot();
      sendJson(res, 200, {
        status: this.config.capExceeded ? "daily_cap_reached" : state.quarantined ? "quarantined" : "ok",
        budget_usd: state.budgetUsd,
        committed_exact: state.committedExact,
        committed_estimated: state.committedEstimated,
        reserved_total: state.reservedTotal,
        remaining_usd: this.remainingUsd(),
        upstream: UPSTREAM_URL,
        key_configured: Boolean(this.config.apiKey),
        daily_cap_usd: this.config.dailyCapUsd,
        daily_committed_usd: this.dailyCommittedUsd(),
        daily_remaining_usd: round(Math.max(0, this.config.dailyCapUsd - this.dailyCommittedUsd())),
        daily_cap_reached: Boolean(this.config.capExceeded),
        quarantine_reason: state.quarantined ? quarantineMessage(this.quarantineCause) : null,
        price_source: this.config.priceSource ?? "static",
        price_verified_at: this.config.priceVerifiedAt ?? "unknown",
        priced_models: Object.keys(this.config.prices).length
      });
      return;
    }
    if (url !== ROUTE) {
      sendJson(res, 404, { error: { message: `Sentinel proxy serves ${ROUTE} and ${MODELS_ROUTE} only.`, type: "invalid_request_error", code: "not_found", param: null } });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: { message: `${ROUTE} accepts POST.`, type: "invalid_request_error", code: "method_not_allowed", param: null } });
      return;
    }
    await this.handleCompletion(req, res);
  }

  private async handleCompletion(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: ChatCompletionRequest;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8")) as ChatCompletionRequest;
    } catch (error) {
      sendJson(res, 400, { error: { message: `Malformed request body: ${error instanceof Error ? error.message : "unparseable"}`, type: "invalid_request_error", code: "invalid_body", param: null } });
      return;
    }

    const model = typeof body.model === "string" ? body.model : "";
    if (!model) { sendJson(res, 400, { error: { message: "`model` is required.", type: "invalid_request_error", code: "invalid_body", param: "model" } }); return; }
    if (!Array.isArray(body.messages)) { sendJson(res, 400, { error: { message: "`messages` must be an array.", type: "invalid_request_error", code: "invalid_body", param: "messages" } }); return; }

    // Refuse before reserving when we could not dispatch anyway: a reservation we
    // cannot spend is budget held against nothing.
    if (!this.config.apiKey) {
      sendJson(res, 503, { error: { message: "Sentinel proxy has no upstream key configured. Set ORBIO_API_KEY.", type: "api_error", code: "sentinel_no_upstream_key", param: null } });
      return;
    }

    // The daily cap is checked before the governor, because the governor's budget
    // is only this process's slice of it and cannot speak to yesterday's spend.
    if (this.config.capExceeded) {
      const total = this.dailyCommittedUsd();
      sendJson(res, 402, {
        error: {
          type: "budget_exceeded",
          code: "sentinel_daily_cap_reached",
          message: `Sentinel refused: today's spend ${usd(total)} has reached the daily cap ${usd(this.config.dailyCapUsd)}. The cap resets at local midnight.`,
          param: null
        }
      }, { "x-sentinel-refusal": "DAILY_CAP_REACHED", "x-sentinel-daily-committed-usd": String(total) });
      return;
    }

    // §2 step 2: derived from the assembled messages, never declared.
    const inputTokens = deriveInputTokens(body);

    // §2 step 3: an absent ceiling is an unbounded worst case. Inject one, and
    // forward it, so the bound we reserve against binds the gateway too.
    const declaredMaxTokens = typeof body.max_tokens === "number" && body.max_tokens > 0 ? body.max_tokens : null;
    const maxTokens = declaredMaxTokens ?? this.config.defaultMaxTokens;
    const maxTokensInjected = declaredMaxTokens === null;

    const streaming = body.stream === true;
    const logicalCallId = `proxy:${crypto.randomUUID()}`;
    const attemptId = `${logicalCallId}:1`;

    const price = this.config.prices[model];
    const worstCase = price ? worstCaseUsd(price, inputTokens, maxTokens, this.config.reservationSafetyMultiplier) : Number.NaN;

    const admission = await this.governor.reserve({ attemptId, logicalCallId, model, inputTokens, maxTokens });
    if (!admission.admitted) {
      const remaining = this.remainingUsd();
      const worstCaseLabel = Number.isFinite(worstCase) ? usd(worstCase) : "unpriced";
      console.log(`[refused] ${admission.reason} model=${model} worst_case=${worstCaseLabel} remaining=${usd(remaining)}`);
      sendJson(res, 402, refusalBody(admission.reason, {
        worstCase, remaining, model,
        unboundable: this.config.unboundableModels?.has(model) ?? false,
        quarantineCause: this.quarantineCause
      }), {
        "x-sentinel-refusal": admission.reason,
        "x-sentinel-worst-case-usd": Number.isFinite(worstCase) ? String(worstCase) : "unpriced",
        "x-sentinel-remaining-usd": String(remaining)
      });
      return;
    }

    const { reservation } = admission;
    console.log(
      `[admitted] ${attemptId} model=${model} input_tokens=${inputTokens} max_tokens=${maxTokens}` +
      `${maxTokensInjected ? " (injected)" : ""} reserved=${usd(reservation.amountUsd)} streaming=${streaming}`
    );

    const upstreamBody: ChatCompletionRequest = { ...body, max_tokens: maxTokens };
    if (streaming) {
      // §3: ask for usage on the terminating chunk. We verify rather than assume —
      // if the gateway ignores it, the accumulator falls back to observed output.
      const existing = (body.stream_options ?? {}) as Record<string, unknown>;
      upstreamBody.stream_options = { ...existing, include_usage: true };
    }

    const controller = new AbortController();
    // Never let a dispatch outlive its reservation: a late result would land in the
    // governor's LATE_RESULT_REJECTED path and quarantine every later admission.
    const timer = setTimeout(() => controller.abort(), Math.max(1, reservation.expiresAtMs - Date.now() - 1));

    try {
      const upstream = await fetch(UPSTREAM_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          accept: streaming ? "text/event-stream" : "application/json"
        },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal
      });

      const passthrough: Record<string, string> = {
        "x-sentinel-attempt-id": attemptId,
        "x-sentinel-reserved-usd": String(reservation.amountUsd),
        "x-sentinel-input-tokens": String(inputTokens),
        "x-sentinel-max-tokens": String(maxTokens),
        "x-sentinel-max-tokens-injected": String(maxTokensInjected)
      };

      if (!upstream.ok) { await this.settleUpstreamError(upstream, res, reservation, passthrough); return; }
      if (streaming) await this.settleStream(upstream, res, reservation, passthrough);
      else await this.settleJson(upstream, res, reservation, passthrough);
    } catch (error) {
      const aborted = controller.signal.aborted;
      const reason = aborted ? "reservation_deadline_exceeded" : `dispatch_failed:${error instanceof Error ? error.name : "unknown"}`;
      // Nothing was streamed back, so no output was observed. Zero output tokens
      // still commits the input leg: never a silent release, never a silent zero.
      await this.commitEstimatedAndPersist(reservation, reason, 0);
      console.error(`[${reason}] ${attemptId}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        sendJson(res, aborted ? 504 : 502, { error: { message: `Sentinel proxy could not complete the upstream call: ${reason}`, type: "api_error", code: reason, param: null } });
      } else {
        res.end();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** An upstream rejection generated no output, but the request is still resolved, not released. */
  private async settleUpstreamError(upstream: Response, res: ServerResponse, reservation: Reservation, headers: Record<string, string>): Promise<void> {
    const text = await upstream.text();
    await this.commitEstimatedAndPersist(reservation, `upstream_status:${upstream.status}`, 0);
    console.error(`[upstream ${upstream.status}] ${reservation.attemptId}: ${redact(text.slice(0, 200), this.config.apiKey)}`);
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", ...headers });
    res.end(text);
  }

  /** §2 step 6: commit the exact usage.cost, pass the body through untouched. */
  private async settleJson(upstream: Response, res: ServerResponse, reservation: Reservation, headers: Record<string, string>): Promise<void> {
    const text = await upstream.text();
    let cost: number | null = null;
    let outputTokens: number | undefined;
    try {
      const parsed = JSON.parse(text) as { usage?: { cost?: unknown; completion_tokens?: unknown }; choices?: unknown };
      const rawCost = parsed.usage?.cost;
      if (typeof rawCost === "number" && Number.isFinite(rawCost)) cost = rawCost;
      const rawTokens = parsed.usage?.completion_tokens;
      if (typeof rawTokens === "number" && Number.isFinite(rawTokens)) outputTokens = rawTokens;
    } catch { /* fall through to the estimated path */ }

    if (cost !== null) {
      await this.commitExactAndPersist(reservation, cost);
      headers["x-sentinel-cost-source"] = "exact";
      headers["x-sentinel-cost-usd"] = String(cost);
      console.log(`[committed exact] ${reservation.attemptId} cost=${usd(cost)}`);
    } else {
      await this.commitEstimatedAndPersist(reservation, "missing_usage_cost", outputTokens);
      headers["x-sentinel-cost-source"] = "estimated";
      console.log(`[committed estimated] ${reservation.attemptId} reason=missing_usage_cost output_tokens=${outputTokens ?? "unknown"}`);
    }
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", ...headers });
    res.end(text);
  }

  /** §3: pass chunks through as they arrive, accumulate to read usage from the tail. */
  private async settleStream(upstream: Response, res: ServerResponse, reservation: Reservation, headers: Record<string, string>): Promise<void> {
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...headers
    });

    const accumulator = new StreamAccumulator();
    const decoder = new TextDecoder();
    const reader = upstream.body?.getReader();
    let cut: Error | null = null;

    if (!reader) {
      await this.commitEstimatedAndPersist(reservation, "stream_without_body", 0);
      res.end();
      return;
    }

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        accumulator.ingest(chunk);
        res.write(chunk);
      }
    } catch (error) {
      cut = error instanceof Error ? error : new Error(String(error));
    }

    const cost = accumulator.cost();
    if (cut === null && cost !== null) {
      await this.commitExactAndPersist(reservation, cost);
      console.log(`[committed exact] ${reservation.attemptId} cost=${usd(cost)} (stream)`);
    } else {
      // A cut stream still burned tokens, and a clean stream with no usage still
      // cost money. Estimate from what we actually saw; never a silent zero.
      const reason = cut ? "stream_cut" : accumulator.sawDone ? "stream_without_usage" : "stream_ended_without_done";
      await this.commitEstimatedAndPersist(reservation, reason, accumulator.outputTokens());
      console.log(`[committed estimated] ${reservation.attemptId} reason=${reason} output_tokens=${accumulator.outputTokens()}`);
    }
    res.end();
  }

  listen(): ReturnType<typeof createServer> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        console.error("[proxy] unhandled", error);
        if (!res.headersSent) sendJson(res, 500, { error: { message: "Sentinel proxy failed.", type: "api_error", code: "internal", param: null } });
        else res.end();
      });
    });
    // Reservations expire lazily inside the governor's own transitions; without
    // traffic an expired hold would keep occupying budget until the next request.
    this.sweeper = setInterval(() => { void this.governor.expire(); }, 5_000);
    this.sweeper.unref();
    server.listen(this.config.port, BIND_HOST, () => {
      console.log(`Sentinel proxy listening on http://${BIND_HOST}:${this.config.port}${ROUTE}`);
      console.log(`  upstream          ${UPSTREAM_URL}`);
      console.log(`  budget            ${usd(this.config.budgetUsd)} (safety x${this.config.reservationSafetyMultiplier})`);
      console.log(`  daily cap         ${usd(this.config.dailyCapUsd)}, ${usd(this.dailyCommittedUsd())} already committed today`);
      console.log(`  reservation TTL   ${this.config.reservationTtlMs}ms`);
      console.log(`  default max_tokens ${this.config.defaultMaxTokens} (injected when the client sends none)`);
      console.log(`  price table       ${Object.keys(this.config.prices).length} models from ${this.config.priceSource ?? "static"} (verified ${this.config.priceVerifiedAt ?? "unknown"})`);
      console.log(`  upstream key      ${this.config.apiKey ? "configured (held here, never forwarded to clients)" : "MISSING - requests will be refused with 503"}`);
      console.log(`  client auth       none - loopback trust only, any bearer the client sends is discarded`);
      // "Any bearer is discarded" is a security fact, not an instruction: a
      // stranger reading it still doesn't know what to type into an editor's
      // key field. Say it directly, with the exact example QUICKSTART.md uses.
      console.log(`  client key        put anything (e.g. sentinel-local) - it is discarded`);
      if (this.config.capExceeded) {
        console.warn("");
        console.warn(`  *** DAILY CAP REACHED: ${usd(this.dailyCommittedUsd())} of ${usd(this.config.dailyCapUsd)} committed today.`);
        console.warn(`  *** Every request is refused with HTTP 402 until local midnight.`);
        console.warn(`  *** Restarting does not grant a fresh budget; the total is stored in ${this.config.spendPath}.`);
      }
    });
    return server;
  }
}

/**
 * The governor is constructed with the price table, so the table has to resolve
 * before the server exists. A model missing from it is refused, so sourcing it
 * from the gateway rather than the hardcoded pair is what makes the proxy usable
 * by a real client.
 */
export async function main(): Promise<void> {
  const base = loadConfig();
  const table = await resolvePriceTable({ modelsUrl: base.modelsUrl, cachePath: base.priceCachePath });

  if (table.source === "gateway") {
    console.log(
      `[prices] ${table.modelCount} models priced from the gateway ` +
      `(${table.free} free, ${table.skipped} refused: no per-token price).`
    );
  } else {
    console.warn(`[prices] using the ${table.source} table (${table.modelCount} models): ${table.note}`);
  }

  for (const line of priceDrift(table.prices)) console.warn(`[prices] DRIFT ${line}`);

  // Seed from today's stored total before the governor exists: its budget is the
  // cap minus what today already spent, so a restart cannot hand back a fresh one.
  const daily = resolveDailyBudget({
    store: new DailySpendStore(base.spendPath),
    dailyCapUsd: base.dailyCapUsd,
    ceilingUsd: base.budgetUsd
  });
  console.log(`[spend] ${usd(daily.seededUsd)} committed on ${daily.date}; ${usd(Math.max(0, daily.capRemainingUsd))} of the ${usd(base.dailyCapUsd)} cap remains.`);

  new SentinelProxy({
    ...base,
    prices: table.prices,
    priceSource: table.source,
    priceVerifiedAt: table.verifiedAt,
    unboundableModels: table.unboundable,
    seededSpendUsd: daily.seededUsd,
    capExceeded: daily.capExceeded,
    budgetUsd: daily.budgetUsd
  }).listen();
}

// pathToFileURL, not a `file://` template: on Windows argv[1] is a backslashed
// drive path, so the naive form never matches import.meta.url and the proxy
// would exit 0 without ever listening.
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) await main();
