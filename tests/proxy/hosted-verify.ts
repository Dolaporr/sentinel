/**
 * Hosted governor, end to end against a hostile local stub upstream.
 *
 * The stub echoes the Authorization header it receives -- in a JSON body, an
 * error body, and a stream with the key split across two writes -- so "the
 * operator's key never reaches a client, a log line or a file" is tested
 * against the worst upstream we can imagine, not a polite one. Every leak
 * check has a positive control proving the thing it looks for really was in
 * play, so none of them can pass vacuously.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prices } from "../../src/proxy/mission-constants.js";
import { orbioProvider } from "../../src/proxy/providers/orbio.js";
import { HostedGateway, type HostedServerConfig } from "../../src/proxy/hosted/server.js";
import { HostedStateError } from "../../src/proxy/hosted/state.js";
import { StreamRedactor } from "../../src/proxy/dispatch.js";
import { sanitizeHostedBody } from "../../src/proxy/hosted/sanitize.js";
import { adminTokenMatches, canonicalInviteCode, newInviteCode } from "../../src/proxy/hosted/secrets.js";

// ------------------------------------------------------------------ harness

const UPSTREAM_KEY = "sk-orbio-HOSTED-TEST-KEY-must-never-leak-0123456789abcdef";
const ADMIN = "admin-secret-for-hosted-verify-0123456789abcdef";
const PROMPT_MARKER = "xyzzy-hosted-prompt-marker-77231";
const MINI = "openai/gpt-4.1-mini";
const BIG = "openai/gpt-4.1";
const STUB_PORT = 9940;
const PORT = 9941;
const DATA = `/tmp/sentinel-hosted-verify-${process.pid}`;
// What the stub bills: its reported usage at the mini price, so a normal call
// always fits its reservation and only "overbill" exceeds one.
const STUB_COST = round((12 * 0.4 + 5 * 1.6) / 1_000_000);
const STREAM_COST = 0.0000456;

function round(v: number) { return Math.round(v * 1e9) / 1e9; }

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

// Everything the process prints, so log lines can be scanned for leaks.
const consoleLog: string[] = [];
for (const level of ["log", "error", "warn"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { consoleLog.push(args.map(String).join(" ")); original(...args); };
}

// Every byte any client received: status, headers, body.
const clientTranscript: string[] = [];

interface Reply { status: number; headers: Headers; text: string; json: any }
async function call(path: string, opts: { method?: string; auth?: string; body?: unknown } = {}): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}) },
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)
  });
  const text = await res.text();
  clientTranscript.push(`${res.status} ${JSON.stringify([...res.headers])}\n${text}`);
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* streams and html */ }
  return { status: res.status, headers: res.headers, text, json };
}
const admin = (path: string, body?: unknown, method?: string) => call(path, { auth: ADMIN, body, method });
const chat = (auth: string, extra: Record<string, unknown> = {}) =>
  call("/v1/chat/completions", { auth, body: { model: MINI, max_tokens: 64, messages: [{ role: "user", content: `say ok ${PROMPT_MARKER}` }], ...extra } });

// ------------------------------------------------------------------ stub upstream

let stubHits = 0;
let lastUpstreamBody: Record<string, unknown> = {};
let keySeenUpstream = false;
let markerSeenUpstream = false;

function startStub(): Server {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      stubHits++;
      const auth = String(req.headers.authorization ?? "");
      keySeenUpstream ||= auth.includes(UPSTREAM_KEY);
      markerSeenUpstream ||= raw.includes(PROMPT_MARKER);
      lastUpstreamBody = JSON.parse(raw || "{}");
      const mode = String(lastUpstreamBody.user ?? "");
      if (mode === "operator-auth") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "invalid_api_key", message: "Encrypt locally with the Incognito adapter" } }));
        return;
      }
      if (mode === "error") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `upstream rejected key ${auth}` } }));
        return;
      }
      if (lastUpstreamBody.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const half = Math.floor(auth.length / 2);
        // The key, split across two writes: a per-chunk redactor would miss it.
        res.write(`data: {"choices":[{"index":0,"delta":{"content":"echo ${auth.slice(0, half)}`);
        setTimeout(() => {
          res.write(`${auth.slice(half)}"}}]}\n\n`);
          res.write(`data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"cost":${STREAM_COST}}}\n\n`);
          res.end("data: [DONE]\n\n");
        }, 20);
        return;
      }
      const cost = mode === "overbill" ? 0.001 : STUB_COST;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "stub", object: "chat.completion", model: lastUpstreamBody.model,
        choices: [{ index: 0, message: { role: "assistant", content: `echo ${auth}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 5, cost }
      }));
    });
  });
  server.listen(STUB_PORT);
  return server;
}

// A clock the test can move across a UTC midnight.
let dayOffsetMs = 0;
const clock = () => new Date(Date.now() + dayOffsetMs);

function gatewayConfig(overrides: Partial<HostedServerConfig> = {}): HostedServerConfig {
  return {
    port: PORT, host: "127.0.0.1",
    provider: orbioProvider,
    upstreamUrl: `http://127.0.0.1:${STUB_PORT}/api/v1/chat/completions`,
    apiKey: UPSTREAM_KEY, adminToken: ADMIN,
    prices, priceSource: "static", priceVerifiedAt: "test",
    statePath: join(DATA, "hosted-state.json"), callLedgerPath: join(DATA, "calls.jsonl"),
    seedConfig: { poolDailyCapUsd: 1, tokenDailyCapUsd: 0.01, modelAllowlist: [MINI], requestsPerMinute: 1000, paused: false, operatorFaultPauseAfter: 3 },
    reservationTtlMs: 30_000, reservationSafetyMultiplier: 1.25, defaultMaxTokens: 1024,
    clock, ...overrides
  };
}

const listenOn = (gw: HostedGateway) => new Promise<Server>((resolve) => { const s = gw.listen(); s.once("listening", () => resolve(s)); });
// closeAllConnections drops keep-alive sockets; the pause lets the client's
// connection pool notice before the next request, instead of reusing a dead one.
const close = (s: Server) => new Promise<void>((resolve) => { s.close(() => setTimeout(resolve, 100)); s.closeAllConnections(); });

// ------------------------------------------------------------------ 1. units

async function units() {
  console.log("1. unit checks: redactor, sanitizer, secrets");
  const r = new StreamRedactor("SECRETKEY123");
  const out = r.push("abc SECRE") + r.push("TKEY123 def") + r.flush();
  check("stream redactor catches a secret split across chunks", out === "abc [redacted] def", out);
  const r2 = new StreamRedactor("SECRETKEY123");
  const plain = r2.push("hello ") + r2.push("world") + r2.flush();
  check("stream redactor passes clean text through intact", plain === "hello world", plain);

  const base = { model: MINI, messages: [] };
  const refused = (b: Record<string, unknown>) => { const s = sanitizeHostedBody({ ...base, ...b }); return s.ok ? null : s.param; };
  check("`models` fallback routing refused", refused({ models: [BIG] }) === "models");
  check("`plugins` refused", refused({ plugins: [{ id: "web" }] }) === "plugins");
  check("`provider` routing refused", refused({ provider: { order: ["x"] } }) === "provider");
  check("`n` > 1 refused", refused({ n: 3 }) === "n");
  check("unknown field refused by name", refused({ frobnicate: true }) === "frobnicate");
  const folded = sanitizeHostedBody({ ...base, max_tokens: 500, max_completion_tokens: 50 });
  check("max_completion_tokens folds into the single ceiling (lower wins)", folded.ok && folded.declaredMaxTokens === 50);
  check("max_completion_tokens is not forwarded upstream", folded.ok && !("max_completion_tokens" in folded.body) && !("max_tokens" in folded.body));
  const n1 = sanitizeHostedBody({ ...base, n: 1 });
  check("n: 1 accepted and stripped", n1.ok && !("n" in n1.body));

  const code = newInviteCode();
  check("invite code canonicalises from lower case without dashes", canonicalInviteCode(code.toLowerCase().replace(/-/g, "")) === code);
  check("admin check rejects a user-shaped bearer outright", !adminTokenMatches("Bearer snt_whatever", "snt_whatever"));
  check("admin check accepts the admin secret", adminTokenMatches(`Bearer ${ADMIN}`, ADMIN));
}

// ------------------------------------------------------------------ 2. end to end

async function endToEnd() {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  const stub = startStub();
  const gw = new HostedGateway(gatewayConfig());
  const server = await listenOn(gw);

  console.log("\n2. admin routes need their own secret");
  check("no auth -> 401", (await call("/admin/tokens")).status === 401);
  check("wrong secret -> 401", (await call("/admin/tokens", { auth: "nope-nope-nope-nope-nope-nope-nope-nope" })).status === 401);
  const inv = await admin("/admin/invites", { count: 4 });
  check("admin issues invite codes", inv.status === 201 && inv.json.codes.length === 4, `got ${inv.status}`);
  const [codeA, codeB, codeC, codeSpare] = inv.json.codes as string[];
  check("state file stores no plaintext invite code", !readFileSync(join(DATA, "hosted-state.json"), "utf8").includes(codeA));

  console.log("\n3. redemption: one code, one token, once");
  const redA = await call("/v1/redeem", { body: { code: codeA } });
  check("redeem returns a snt_ token and a handle", redA.status === 201 && redA.json.token.startsWith("snt_") && /^t-[0-9a-f]{6}$/.test(redA.json.handle), `handle ${redA.json.handle}`);
  const tokA: string = redA.json.token; const handleA: string = redA.json.handle;
  const again = await call("/v1/redeem", { body: { code: codeA } });
  const bogus = await call("/v1/redeem", { body: { code: "SNT-0000-0000-0000-0000" } });
  check("a used code is refused", again.status === 400);
  check("used and unknown codes get the identical answer", again.text === bogus.text);
  const redB = await call("/v1/redeem", { body: { code: codeB.toLowerCase() } });
  check("a hand-typed lowercase code still redeems", redB.status === 201);
  const tokB: string = redB.json.token; const handleB: string = redB.json.handle;
  check("state file stores no plaintext user token", !readFileSync(join(DATA, "hosted-state.json"), "utf8").includes(tokA));
  check("user token cannot open admin routes", (await call("/admin/tokens", { auth: tokA })).status === 401);

  console.log("\n4. authentication on the inference route");
  const ledgerBefore = gw.callLedger.readToday(clock()).length;
  check("no token -> 401", (await call("/v1/chat/completions", { body: { model: MINI, messages: [] } })).status === 401);
  check("forged snt_ token -> 401", (await chat("snt_forged")).status === 401);
  check("unauthenticated attempts never reach the public ledger", gw.callLedger.readToday(clock()).length === ledgerBefore);

  console.log("\n5. a real admitted call, exact cost, both ceilings move");
  const hitsBefore = stubHits;
  const ok = await chat(tokA);
  check("admitted -> 200", ok.status === 200, `got ${ok.status} ${ok.text.slice(0, 120)}`);
  check("cost source is exact", ok.headers.get("x-sentinel-cost-source") === "exact");
  check("upstream was actually called", stubHits === hitsBefore + 1);
  check("token spend recorded", gw.tenants.spentTodayUsd(handleA) === STUB_COST, String(gw.tenants.spentTodayUsd(handleA)));
  check("pool spend recorded", gw.pool.committedUsd() === STUB_COST);
  check("pool hold released after settle", gw.pool.reservedUsd() === 0);
  const view = (await call("/ledger.json")).json;
  check("public ledger shows the call under the handle", view.byAgent.some((r: any) => r.key === handleA && r.calls === 1));
  check("public ledger carries the pool", view.hosted.poolCapUsd === 1 && view.hosted.poolCommittedUsd === STUB_COST);

  const stream = await chat(tokA, { stream: true });
  check("streamed call -> 200", stream.status === 200);
  check("streamed call committed exact", gw.tenants.spentTodayUsd(handleA) === round(STUB_COST + STREAM_COST), String(gw.tenants.spentTodayUsd(handleA)));

  console.log("\n6. allowlist and body controls, before dispatch");
  const h0 = stubHits;
  const notAllowed = await chat(tokA, { model: BIG });
  check("non-allowlisted model -> 403 with the served list", notAllowed.status === 403 && notAllowed.json.error.message.includes(MINI));
  const junkModel = await chat(tokA, { model: `my-private-notes ${PROMPT_MARKER}` });
  check("a free-text model name is refused", junkModel.status === 403);
  const routed = await chat(tokA, { models: [BIG] });
  check("`models` fallback -> 400 naming the field", routed.status === 400 && routed.json.error.param === "models");
  check("none of these reached upstream", stubHits === h0);
  const refusalsNow = (await call("/ledger.json")).json.refusals as any[];
  check("allowlist refusal is in the public ledger", refusalsNow.some((r) => r.reason === "MODEL_NOT_ALLOWED" && r.model === BIG));
  check("a caller-chosen model string is not published verbatim", refusalsNow.some((r) => r.model === "unlisted-model"));
  await chat(tokA, { max_completion_tokens: 7 });
  check("only max_tokens goes upstream, at the folded ceiling", lastUpstreamBody.max_tokens === 7 && !("max_completion_tokens" in lastUpstreamBody));

  console.log("\n7. per-token ceiling");
  const h1 = stubHits;
  const tooBig = await chat(tokA, { max_tokens: 100_000 });
  check("worst case over the token's remaining -> 402", tooBig.status === 402 && tooBig.json.error.code === "sentinel_budget_exceeded", tooBig.text.slice(0, 160));
  check("refusal says what was left", /left today/.test(tooBig.json.error.message));
  check("refused before dispatch", stubHits === h1);
  check("pool hold released when the token refuses", gw.pool.reservedUsd() === 0);
  const spentA = gw.tenants.spentTodayUsd(handleA);
  await admin("/admin/config", { tokenDailyCapUsd: spentA }, "PATCH");
  const capped = await chat(tokA);
  check("cap lowered at runtime to today's spend -> token cap reached", capped.status === 402 && capped.json.error.code === "sentinel_token_daily_cap_reached", capped.text.slice(0, 160));
  check("cap message says when it resets", /00:00 UTC, in \d+h \d+m|00:00 UTC, in \d+m/.test(capped.json.error.message));
  await admin("/admin/config", { tokenDailyCapUsd: 0.01 }, "PATCH");
  check("cap raised again at runtime -> served, no redeploy", (await chat(tokA)).status === 200);

  console.log("\n8. global pool is checked first");
  const committed = gw.pool.committedUsd();
  await admin("/admin/config", { poolDailyCapUsd: round(committed + 0.00005) }, "PATCH");
  const insufficient = await chat(tokB);
  check("worst case over the pool's remainder -> pool refusal", insufficient.status === 402 && insufficient.json.error.code === "sentinel_pool_insufficient", insufficient.text.slice(0, 160));
  await admin("/admin/config", { poolDailyCapUsd: committed }, "PATCH");
  const exhausted = await chat(tokB);
  check("pool used up -> 402 pool exhausted", exhausted.status === 402 && exhausted.json.error.code === "sentinel_pool_exhausted");
  check("exhausted message is one legible line with the reset", /shared free pool is used up for today .* resets at 00:00 UTC/.test(exhausted.json.error.message), exhausted.json.error.message);
  const tokACapped = await admin("/admin/config", { tokenDailyCapUsd: gw.tenants.spentTodayUsd(handleA) }, "PATCH");
  const both = await chat(tokA);
  check("with both ceilings hit, the pool answers first", tokACapped.status === 200 && both.json.error.code === "sentinel_pool_exhausted");
  await admin("/admin/config", { poolDailyCapUsd: 1, tokenDailyCapUsd: 0.01 }, "PATCH");

  console.log("\n9. isolation: one token's fault never quarantines another (finding 13)");
  const over = await chat(tokB, { user: "overbill" });
  check("overbilled call completes", over.status === 200);
  check("token B is quarantined", gw.tenants.quarantined(handleB));
  const bAfter = await chat(tokB);
  check("token B refused with a legible quarantine reason", bAfter.status === 402 && bAfter.json.error.code === "sentinel_quarantined" && /Other tokens are unaffected/.test(bAfter.json.error.message));
  check("token A still served", (await chat(tokA)).status === 200);
  check("the overbill still counted in the pool", gw.pool.committedUsd() >= 0.001);

  console.log("\n10. rate limit, separate from spend");
  const redC = await call("/v1/redeem", { body: { code: codeC } });
  const tokC: string = redC.json.token; const handleC: string = redC.json.handle;
  await admin("/admin/config", { requestsPerMinute: 2 }, "PATCH");
  const r1 = await chat(tokC); const r2 = await chat(tokC); const r3 = await chat(tokC);
  check("first two inside the limit", r1.status === 200 && r2.status === 200);
  check("third -> 429 with Retry-After", r3.status === 429 && Number(r3.headers.get("retry-after")) >= 1);
  await admin("/admin/config", { requestsPerMinute: 1000 }, "PATCH");

  console.log("\n11. revocation and the kill switch, no deploy");
  check("revoke one token", (await admin(`/admin/tokens/${handleC}/revoke`, {})).status === 200);
  const revoked = await chat(tokC);
  check("revoked token -> 401 revoked", revoked.status === 401 && revoked.json.error.code === "sentinel_token_revoked");
  check("other tokens unaffected", (await chat(tokA)).status === 200);
  const h2 = stubHits;
  await admin("/admin/pause", {});
  const paused = await chat(tokA);
  check("kill switch -> 503 for a valid token", paused.status === 503 && paused.json.error.code === "sentinel_paused");
  check("nothing reached upstream while paused", stubHits === h2);
  check("public ledger shows the pause", (await call("/ledger.json")).json.hosted.paused === true);
  await admin("/admin/resume", {});
  check("resume -> served again", (await chat(tokA)).status === 200);

  console.log("\n12. the operator's key never reaches a client");
  const echoed = await chat(tokA);
  const errored = await chat(tokA, { user: "error" });
  const streamed = await chat(tokA, { stream: true });
  check("(control) the upstream really received the key", keySeenUpstream);
  check("(control) the stub really echoed it -- redaction fired on JSON", echoed.text.includes("[redacted]"));
  check("(control) redaction fired on the error body", errored.status === 400 && errored.text.includes("[redacted]"));
  check("(control) redaction fired on the split stream", streamed.text.includes("[redacted]"));
  const operator = await chat(tokA, { user: "operator-auth" });
  check("upstream 401 on the operator's key -> 503 that says it is Sentinel's side", operator.status === 503 && operator.json?.error?.code === "sentinel_upstream_credentials" && /not yours/.test(operator.json.error.message));
  check("the upstream's own 401 body is not passed to the caller", !operator.text.includes("Incognito"));
  check("a caller-side upstream error (400) still passes through", errored.status === 400);

  console.log("\n12b. operator-key failures: $0 not_billed, then an automatic pause");
  const view12 = (await call("/ledger.json")).json;
  const lastRow = gw.callLedger.readToday(clock()).at(-1)!;
  check("the 401 is recorded at $0 tagged not_billed", lastRow.cost_source === "not_billed" && lastRow.cost_usd === 0 && lastRow.admitted === true);
  check("the public ledger counts it apart from calls made", view12.today.callsNotBilled >= 1);
  check("the 401 left no pool hold", gw.pool.reservedUsd() === 0);
  const spentBefore = gw.tenants.spentTodayUsd(handleA);
  const poolBefore = gw.pool.committedUsd();
  check("a success resets the streak", (await chat(tokA)).status === 200);
  const spentAfterSuccess = gw.tenants.spentTodayUsd(handleA);
  await chat(tokA, { user: "operator-auth" });
  const second = await chat(tokA, { user: "operator-auth" });
  check("two faults in a row do not pause", !gw.store.config.paused && second.status === 503 && !/paused itself/.test(second.json.error.message));
  check("operator faults charge neither the token nor the pool", gw.tenants.spentTodayUsd(handleA) === spentAfterSuccess && gw.pool.committedUsd() === round(poolBefore + (spentAfterSuccess - spentBefore)));
  const third = await chat(tokA, { user: "operator-auth" });
  await chat(tokA, { user: "operator-auth" });
  await chat(tokA, { user: "operator-auth" });
  check("one caller alone cannot pause the service, however many in a row", gw.store.config.paused === false && !/paused itself/.test(third.json.error.message));
  const codeD = (await admin("/admin/invites", { count: 1 })).json.codes[0];
  const tokD: string = (await call("/v1/redeem", { body: { code: codeD } })).json.token;
  const tripping = await chat(tokD, { user: "operator-auth" });
  check("a second token joining the streak pauses the service", gw.store.config.paused === true);
  check("the response that tripped it says so", /paused itself/.test(tripping.json.error.message), tripping.json?.error?.message);
  const h3 = stubHits;
  const autoPaused = await chat(tokA);
  check("while auto-paused: 503 that says why, and that it is not the caller's fault", autoPaused.status === 503 && autoPaused.json.error.code === "sentinel_paused" && /paused itself: the upstream provider rejected the operator's key 6 times in a row, across 2 different tokens \(last: HTTP 401\)/.test(autoPaused.json.error.message) && /not yours/.test(autoPaused.json.error.message), autoPaused.json?.error?.message);
  check("nothing reached upstream while auto-paused", stubHits === h3);
  check("healthz carries the reason", /across 2 different tokens/.test((await call("/healthz")).json.paused_reason ?? ""));
  check("the public ledger carries the reason", /across 2 different tokens/.test((await call("/ledger.json")).json.hosted.pauseReason ?? ""));
  await admin("/admin/resume", {});
  check("resume clears the pause and its reason", !gw.store.config.paused && gw.store.pausedReason === null);
  // Straight after resume, two different tokens, no success in between: a
  // streak that survived the resume would already be past the threshold.
  await chat(tokA, { user: "operator-auth" });
  await chat(tokD, { user: "operator-auth" });
  check("the streak restarted from zero on resume", !gw.store.config.paused);
  check("served again after resume", (await chat(tokA)).status === 200);
  check("operatorFaultPauseAfter is adjustable at runtime", (await admin("/admin/config", { operatorFaultPauseAfter: 5 }, "PATCH")).json.config.operatorFaultPauseAfter === 5);

  console.log("\n13. state, restart, and revoke-all");
  const health = await call("/healthz");
  check("healthz reports the pool and no secret", health.json.pool.cap_usd === 1 && health.json.key_configured === true);
  const page = await call("/");
  check("public ledger page is served", page.status === 200 && page.text.includes("Sentinel"));
  await close(server);

  const gw2 = new HostedGateway(gatewayConfig());
  const server2 = await listenOn(gw2);
  check("spend survives a restart", gw2.tenants.spentTodayUsd(handleA) === gw.tenants.spentTodayUsd(handleA));
  check("revocation survives a restart", (await chat(tokC)).status === 401);
  check("tokens survive a restart", (await chat(tokA)).status === 200);

  dayOffsetMs = 24 * 60 * 60 * 1000;
  check("next UTC day: pool total starts at zero", gw2.pool.committedUsd() === 0);
  check("next UTC day: token served again", (await chat(tokA)).status === 200 && gw2.tenants.spentTodayUsd(handleA) === STUB_COST);

  const all = await admin("/admin/revoke-all", {});
  check("revoke-all", all.status === 200 && all.json.revoked >= 2);
  check("every token now refused", (await chat(tokA)).status === 401);
  check("an unredeemed invite cannot mint a fresh token after revoke-all", (await call("/v1/redeem", { body: { code: codeSpare } })).status === 400);
  await close(server2);
  stub.close();

  writeFileSync(join(DATA, "hosted-state.json"), "{ not json");
  let threw = false;
  try { new HostedGateway(gatewayConfig()); } catch (error) { threw = error instanceof HostedStateError; }
  check("a corrupt state file stops startup instead of resetting every cap", threw);

  console.log("\n14. leak scans across everything clients, logs and disk saw");
  const files = ["calls.jsonl", "hosted-state.json"].map((f) => join(DATA, f)).filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
  const everything = { "client responses": clientTranscript.join("\n"), "log lines": consoleLog.join("\n"), "files on disk": files };
  check("(control) the prompt marker really reached upstream", markerSeenUpstream);
  for (const [where, text] of Object.entries(everything)) {
    check(`upstream key absent from ${where}`, !text.includes(UPSTREAM_KEY));
  }
  check("prompt marker absent from log lines", !everything["log lines"].includes(PROMPT_MARKER));
  check("prompt marker absent from files on disk", !files.includes(PROMPT_MARKER));
  check("no user token in log lines or on disk", !consoleLog.join("\n").includes(tokA) && !files.includes(tokA));
  for (const [where, text] of Object.entries(everything)) {
    check(`admin secret absent from ${where}`, !text.includes(ADMIN));
  }
}


await units();
await endToEnd();
rmSync(DATA, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
