/**
 * Everything that happens to a request after the governor has admitted it:
 * the upstream call, and settling the reservation as exact or estimated.
 *
 * Shared by the local proxy (server.ts) and the hosted service (hosted/) so
 * the exact/estimated line is drawn in exactly one place. The callers differ
 * only in what "commit" means to them -- one governor and a daily file locally,
 * a per-token governor plus a shared pool when hosted -- which is the sink.
 */
import type { ServerResponse } from "node:http";
import type { Reservation } from "../governor/types.js";
import { estimateOutputTokens, type ChatCompletionRequest } from "./messages.js";
import type { Provider } from "./providers/types.js";

const usd = (value: number) => `$${value.toFixed(4)}`;

/**
 * Upstream error bodies are echoed into our logs, and a gateway that reflects
 * the submitted key in an error would otherwise write it to disk. The key is
 * never logged deliberately; this is the accidental path.
 */
export function redact(text: string, secret: string | undefined): string {
  return secret && secret.length >= 8 ? text.split(secret).join("[redacted]") : text;
}

/**
 * Redacts a secret from a stream whose chunk boundaries can fall anywhere,
 * including inside the secret. Holds back the last `secret.length - 1`
 * characters of each chunk until the next one arrives, so a split occurrence
 * is always seen whole before any of it is released.
 */
export class StreamRedactor {
  private pending = "";
  constructor(private readonly secret: string) {}

  push(chunk: string): string {
    const combined = redact(this.pending + chunk, this.secret);
    const keep = Math.min(combined.length, this.secret.length - 1);
    this.pending = combined.slice(combined.length - keep);
    return combined.slice(0, combined.length - keep);
  }

  flush(): string {
    const out = redact(this.pending, this.secret);
    this.pending = "";
    return out;
  }
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
  // No cost() method: reading a real cost out of `usage` is provider-specific
  // (see Provider.readExactCostUsd), and this class stays purely mechanical --
  // it accumulates whatever the stream sent, and does not know what any of the
  // fields mean.
}

/** What "commit" means to the caller. Exactly one of these runs per admitted request. */
export interface SettlementSink {
  exact(costUsd: number, streaming: boolean): Promise<void>;
  estimated(reason: string, streaming: boolean, outputTokens?: number): Promise<void>;
  /** The provider refused before running inference: $0, tagged not_billed. */
  notBilled(reason: string, streaming: boolean): Promise<void>;
}

/**
 * Upstream statuses that mean the provider refused the call before running
 * it: credentials rejected (401) or not funded (402). Nothing was generated,
 * so nothing was billed, and estimating a cost would be wrong rather than
 * conservative. Every other error status is still settled as an estimate,
 * because there Sentinel cannot see whether the gateway billed.
 */
export const NOT_BILLED_STATUSES: ReadonlySet<number> = new Set([401, 402]);

export interface DispatchOptions {
  upstreamUrl: string;
  provider: Provider;
  apiKey: string;
  /** The client's body with the reserved max_tokens already applied. */
  body: ChatCompletionRequest;
  streaming: boolean;
  reservation: Reservation;
  res: ServerResponse;
  /** x-sentinel-* headers to pass back to the client. */
  headers: Record<string, string>;
  sink: SettlementSink;
  /**
   * Hosted only: every byte bound for a client is scrubbed of this secret,
   * buffered or streamed. Locally the client is the key's owner, so the body
   * passes through untouched.
   */
  redactClientBodies?: boolean;
  /**
   * Hosted only: an upstream error body can quote the request back, and these
   * are other people's prompts. Log the status, not the body.
   */
  logUpstreamErrorBodies?: boolean;
  /**
   * Hosted only: some upstream errors are about the operator, not the caller
   * (a rejected or unfunded operator key). Returning a replacement here sends
   * that instead of the upstream body. Settlement is unchanged either way.
   */
  replaceUpstreamError?: (status: number) => { status: number; body: unknown } | null;
}

export async function dispatchAdmitted(o: DispatchOptions): Promise<void> {
  const { reservation, res, streaming } = o;
  const toClient = (text: string) => (o.redactClientBodies ? redact(text, o.apiKey) : text);

  const upstreamBody: ChatCompletionRequest = { ...o.body };
  if (streaming) {
    // §3: ask for usage on the terminating chunk. We verify rather than assume —
    // if the gateway ignores it, the accumulator falls back to observed output.
    const existing = (o.body.stream_options ?? {}) as Record<string, unknown>;
    upstreamBody.stream_options = { ...existing, include_usage: true };
  }

  const controller = new AbortController();
  // Never let a dispatch outlive its reservation: a late result would land in the
  // governor's LATE_RESULT_REJECTED path and quarantine every later admission.
  const timer = setTimeout(() => controller.abort(), Math.max(1, reservation.expiresAtMs - Date.now() - 1));

  try {
    const upstream = await fetch(o.upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...o.provider.authHeaders(o.apiKey),
        accept: streaming ? "text/event-stream" : "application/json"
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal
    });

    if (!upstream.ok) { await settleUpstreamError(o, upstream, toClient); return; }
    if (streaming) await settleStream(o, upstream);
    else await settleJson(o, upstream, toClient);
  } catch (error) {
    const aborted = controller.signal.aborted;
    const reason = aborted ? "reservation_deadline_exceeded" : `dispatch_failed:${error instanceof Error ? error.name : "unknown"}`;
    // Nothing was streamed back, so no output was observed. Zero output tokens
    // still commits the input leg: never a silent release, never a silent zero.
    await o.sink.estimated(reason, streaming, 0);
    console.error(`[${reason}] ${reservation.attemptId}: ${redact(error instanceof Error ? error.message : String(error), o.apiKey)}`);
    if (!res.headersSent) {
      const payload = JSON.stringify({ error: { message: `Sentinel proxy could not complete the upstream call: ${reason}`, type: "api_error", code: reason, param: null } });
      res.writeHead(aborted ? 504 : 502, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timer);
  }
}

/** An upstream rejection generated no output, but the request is still resolved, not released. */
async function settleUpstreamError(o: DispatchOptions, upstream: Response, toClient: (text: string) => string): Promise<void> {
  const text = await upstream.text();
  const reason = `upstream_status:${upstream.status}`;
  const notBilled = NOT_BILLED_STATUSES.has(upstream.status);
  if (notBilled) await o.sink.notBilled(reason, o.streaming);
  else await o.sink.estimated(reason, o.streaming, 0);
  const headers = notBilled ? { ...o.headers, "x-sentinel-cost-source": "not_billed", "x-sentinel-cost-usd": "0" } : o.headers;
  const detail = o.logUpstreamErrorBodies === false ? "(body not logged)" : redact(text.slice(0, 200), o.apiKey);
  console.error(`[upstream ${upstream.status}] ${o.reservation.attemptId}: ${detail}`);
  const replacement = o.replaceUpstreamError?.(upstream.status);
  if (replacement) {
    const payload = JSON.stringify(replacement.body);
    o.res.writeHead(replacement.status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers });
    o.res.end(payload);
    return;
  }
  o.res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", ...headers });
  o.res.end(toClient(text));
}

/** §2 step 6: commit the exact usage.cost, pass the body through untouched. */
async function settleJson(o: DispatchOptions, upstream: Response, toClient: (text: string) => string): Promise<void> {
  const text = await upstream.text();
  let cost: number | null = null;
  let outputTokens: number | undefined;
  try {
    const parsed = JSON.parse(text) as { usage?: Record<string, unknown>; choices?: unknown };
    cost = o.provider.readExactCostUsd(parsed.usage);
    const rawTokens = parsed.usage?.completion_tokens;
    if (typeof rawTokens === "number" && Number.isFinite(rawTokens)) outputTokens = rawTokens;
  } catch { /* fall through to the estimated path */ }

  const headers = { ...o.headers };
  if (cost !== null) {
    await o.sink.exact(cost, false);
    headers["x-sentinel-cost-source"] = "exact";
    headers["x-sentinel-cost-usd"] = String(cost);
    console.log(`[committed exact] ${o.reservation.attemptId} cost=${usd(cost)}`);
  } else {
    await o.sink.estimated("missing_usage_cost", false, outputTokens);
    headers["x-sentinel-cost-source"] = "estimated";
    console.log(`[committed estimated] ${o.reservation.attemptId} reason=missing_usage_cost output_tokens=${outputTokens ?? "unknown"}`);
  }
  o.res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", ...headers });
  o.res.end(toClient(text));
}

/** §3: pass chunks through as they arrive, accumulate to read usage from the tail. */
async function settleStream(o: DispatchOptions, upstream: Response): Promise<void> {
  const { res, reservation } = o;
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...o.headers
  });

  const accumulator = new StreamAccumulator();
  const redactor = o.redactClientBodies ? new StreamRedactor(o.apiKey) : null;
  const decoder = new TextDecoder();
  const reader = upstream.body?.getReader();
  let cut: Error | null = null;

  if (!reader) {
    await o.sink.estimated("stream_without_body", true, 0);
    res.end();
    return;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      accumulator.ingest(chunk);
      const out = redactor ? redactor.push(chunk) : chunk;
      if (out) res.write(out);
    }
  } catch (error) {
    cut = error instanceof Error ? error : new Error(String(error));
  }
  if (redactor) {
    const tail = redactor.flush();
    if (tail) res.write(tail);
  }

  const cost = o.provider.readExactCostUsd(accumulator.usage ?? undefined);
  if (cut === null && cost !== null) {
    await o.sink.exact(cost, true);
    console.log(`[committed exact] ${reservation.attemptId} cost=${usd(cost)} (stream)`);
  } else {
    // A cut stream still burned tokens, and a clean stream with no usage still
    // cost money. Estimate from what we actually saw; never a silent zero.
    const reason = cut ? "stream_cut" : accumulator.sawDone ? "stream_without_usage" : "stream_ended_without_done";
    await o.sink.estimated(reason, true, accumulator.outputTokens());
    console.log(`[committed estimated] ${reservation.attemptId} reason=${reason} output_tokens=${accumulator.outputTokens()}`);
  }
  res.end();
}
