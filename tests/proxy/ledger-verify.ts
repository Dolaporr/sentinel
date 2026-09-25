/**
 * Covers SENTINEL — the ledger: attribution (agent-label.ts), the per-call
 * store and its aggregates (call-ledger.ts), and the two new routes.
 *
 * The one check that matters most is at the end: a real request carrying a
 * distinctive prompt string, read back from the actual ledger file and the
 * actual /ledger.json response, asserting that string appears nowhere. That
 * is the ongoing, automated version of the audit this feature's design
 * required before it could be built at all -- see docs/PROXY.md's "What this
 * ledger stores".
 */
import { createServer, type Server } from "node:http";
import { unlinkSync } from "node:fs";
import { CHEAP_MODEL, prices, RESERVATION_SAFETY_MULTIPLIER } from "../../src/proxy/mission-constants.js";
import { extractBearerToken, normalizeAgentLabel, agentLabelFromHeader, UNNAMED_AGENT } from "../../src/proxy/agent-label.js";
import {
  CallLedger, summarizeToday, aggregateByAgent, aggregateByModel, listRefusals,
  mostExpensiveCall, spendSparkline, buildLedgerViewModel, type CallLedgerEntry
} from "../../src/proxy/call-ledger.js";

// UPSTREAM_URL in config.ts is a module-load-time constant read from this env
// var, so it must be set before server.js is imported -- setting it any later
// leaves the proxy pointed at the real gateway instead of the local stub below.
process.env.SENTINEL_PROXY_UPSTREAM ??= "http://127.0.0.1:9930/api/v1/chat/completions";
const { SentinelProxy } = await import("../../src/proxy/server.js");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

// --- 1. extractBearerToken -------------------------------------------------
console.log("1. extractBearerToken");
check("standard header", extractBearerToken("Bearer roberto-ranker") === "roberto-ranker");
check("case-insensitive scheme", extractBearerToken("bearer roberto-ranker") === "roberto-ranker");
check("extra whitespace", extractBearerToken("  Bearer   roberto-ranker  ") === "roberto-ranker");
check("missing header", extractBearerToken(undefined) === undefined);
check("empty header", extractBearerToken("") === undefined);
check("not a bearer scheme", extractBearerToken("Basic dXNlcjpwYXNz") === undefined);
check("bearer with nothing after it", extractBearerToken("Bearer") === undefined);
check("array header takes the first value", extractBearerToken(["Bearer roberto-ranker", "Bearer other"]) === "roberto-ranker");

// --- 2. normalizeAgentLabel -------------------------------------------------
console.log("\n2. normalizeAgentLabel");
check("the spec's own example: roberto-ranker passes through", normalizeAgentLabel("roberto-ranker") === "roberto-ranker");
check("the spec's own example: sentinel-local collapses to unnamed", normalizeAgentLabel("sentinel-local") === UNNAMED_AGENT);
check("placeholder check is case-insensitive", normalizeAgentLabel("SENTINEL-LOCAL") === UNNAMED_AGENT);
check("missing token", normalizeAgentLabel(undefined) === UNNAMED_AGENT);
check("empty string", normalizeAgentLabel("") === UNNAMED_AGENT);
check("uppercase is lowercased", normalizeAgentLabel("RobertoRanker") === "robertoranker");
check("spaces and punctuation stripped, not whole-rejected", normalizeAgentLabel("Roberto Ranker!!") === "robertoranker");
check("a <script> tag survives only its alnum characters", normalizeAgentLabel("<script>alert(1)</script>") === "scriptalert1script");
check("underscores are kept", normalizeAgentLabel("roberto_ranker") === "roberto_ranker");
check("all-invalid input falls back to unnamed", normalizeAgentLabel("!!!") === UNNAMED_AGENT);
check("emoji-only input falls back to unnamed", normalizeAgentLabel("\u{1F600}\u{1F600}") === UNNAMED_AGENT);
{
  const longLabel = "a".repeat(60);
  const result = normalizeAgentLabel(longLabel);
  check("labels are capped at 40 characters", result.length === 40, String(result.length));
  check("truncation keeps the valid prefix", result === "a".repeat(40));
}
check("a newline cannot break the JSONL the label is written into", !normalizeAgentLabel("roberto\nranker").includes("\n"));
check("agentLabelFromHeader composes both steps", agentLabelFromHeader("Bearer roberto-ranker") === "roberto-ranker");
check("agentLabelFromHeader on a missing header", agentLabelFromHeader(undefined) === UNNAMED_AGENT);

// --- 3. CallLedger storage --------------------------------------------------
console.log("\n3. CallLedger: append, read back, survive a corrupt line");
const ledgerPath = "/tmp/sentinel-ledger-verify.jsonl";
try { unlinkSync(ledgerPath); } catch { /* fresh run */ }
const ledger = new CallLedger(ledgerPath);

const baseEntry: Omit<CallLedgerEntry, "ts"> = {
  attempt_id: "a1", agent: "roberto-ranker", model: CHEAP_MODEL, admitted: true,
  cost_usd: 0.00002, cost_source: "exact", refusal_reason: null,
  worst_case_usd: 0.00005, budget_remaining_usd: 0.9998, streaming: false
};
ledger.record(baseEntry);
ledger.record({ ...baseEntry, attempt_id: "a2", agent: "tanks-keeper", model: "openai/gpt-4.1", cost_usd: 0.0003 });
ledger.record({ ...baseEntry, attempt_id: "a3", admitted: false, cost_usd: null, cost_source: null, refusal_reason: "MODEL_UNPRICED", worst_case_usd: null });

const readBack = ledger.readToday();
check("all three entries read back", readBack.length === 3, String(readBack.length));
check("fields round-trip exactly", readBack[0].agent === "roberto-ranker" && readBack[0].cost_usd === 0.00002);

// A corrupt line and a line from a different day should both be skipped, not
// crash the read or silently lose the rest of the day.
{
  const fs = await import("node:fs");
  fs.appendFileSync(ledgerPath, "not json at all\n");
  fs.appendFileSync(ledgerPath, `${JSON.stringify({ ...baseEntry, ts: "2020-01-01T00:00:00.000Z", attempt_id: "old" })}\n`);
  const afterCorruption = ledger.readToday();
  check("a corrupt line does not lose the rest of the day", afterCorruption.length === 3, String(afterCorruption.length));
  check("an entry from a different day is excluded", !afterCorruption.some((e) => e.attempt_id === "old"));
}
check("a missing ledger file reads as no history, not an error", new CallLedger("/tmp/sentinel-ledger-does-not-exist.jsonl").readToday().length === 0);

// --- 4. Aggregation ----------------------------------------------------------
console.log("\n4. aggregation: by agent, by model, refusals, most expensive, sparkline");
const entries = ledger.readToday();
const summary = summarizeToday(entries, 1);
check("calls made counts only settled, admitted calls", summary.callsMade === 2, String(summary.callsMade));
check("calls refused counts the refusal", summary.callsRefused === 1, String(summary.callsRefused));
check("spend is the sum of settled costs", Math.abs(summary.spentUsd - 0.00032) < 1e-9, String(summary.spentUsd));
check("all settled cost here was exact", summary.exactUsd === summary.spentUsd && summary.estimatedUsd === 0);

const byAgent = aggregateByAgent(entries);
check("two agents settled calls", byAgent.length === 2, String(byAgent.length));
check("sorted by spend descending", byAgent[0].key === "tanks-keeper", byAgent.map((r) => r.key).join(","));
check("shares sum to 1", Math.abs(byAgent.reduce((sum, r) => sum + r.shareOfToday, 0) - 1) < 1e-6);

const byModel = aggregateByModel(entries);
check("two models settled calls", byModel.length === 2, String(byModel.length));

const refusals = listRefusals(entries);
check("one refusal listed", refusals.length === 1);
check("refusal carries its reason and null worst case", refusals[0].reason === "MODEL_UNPRICED" && refusals[0].worstCaseUsd === null);

const expensive = mostExpensiveCall(entries);
check("most expensive call is tanks-keeper's", expensive?.agent === "tanks-keeper" && expensive.costUsd === 0.0003, JSON.stringify(expensive));

const sparkline = spendSparkline(entries);
check("sparkline has one point per settled call", sparkline.length === 2, String(sparkline.length));
check("sparkline is cumulative", sparkline[1].cumulativeUsd > sparkline[0].cumulativeUsd);

const viewModel = buildLedgerViewModel(entries, 1);
check("view model composes all of the above", viewModel.hasAnyTraffic && viewModel.byAgent.length === 2 && viewModel.refusals.length === 1);

// --- 5. Empty-state inputs ----------------------------------------------------
console.log("\n5. every aggregate handles zero entries without throwing");
const empty: CallLedgerEntry[] = [];
check("summarizeToday on empty", summarizeToday(empty, 1).callsMade === 0);
check("aggregateByAgent on empty", aggregateByAgent(empty).length === 0);
check("mostExpensiveCall on empty is null", mostExpensiveCall(empty) === null);
check("spendSparkline on empty", spendSparkline(empty).length === 0);
check("buildLedgerViewModel on empty reports hasAnyTraffic false", buildLedgerViewModel(empty, 1).hasAnyTraffic === false);

// --- 6. End-to-end: the routes, real attribution, and the privacy audit -----
console.log("\n6. end-to-end: GET /, GET /ledger.json, real attribution, and no content leak");

interface StubBody { model?: string; messages?: unknown; max_tokens?: number }
let lastStubBody: StubBody = {};
function startStub(): Server {
  const server = createServer((req, res) => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: CHEAP_MODEL, pricing: { prompt: "0.0000004", completion: "0.0000016" } }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      lastStubBody = JSON.parse(raw || "{}") as StubBody;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "x", object: "chat.completion", model: lastStubBody.model,
        choices: [{ index: 0, message: { role: "assistant", content: "a reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.00002 }
      }));
    });
  });
  server.listen(9930);
  return server;
}

const e2eLedgerPath = "/tmp/sentinel-ledger-verify-e2e.jsonl";
try { unlinkSync(e2eLedgerPath); } catch { /* fresh run */ }
const stub = startStub();
const proxy = new SentinelProxy({
  port: 9931, budgetUsd: 0.25,
  reservationTtlMs: 30_000, reservationSafetyMultiplier: RESERVATION_SAFETY_MULTIPLIER,
  maxStepBudgetFraction: 1, prices, defaultMaxTokens: 1_024,
  apiKey: "stub-key", ledgerPath: undefined,
  modelsUrl: "http://127.0.0.1:9930/api/v1/models",
  priceCachePath: "/tmp/sentinel-ledger-verify-price-cache.json",
  priceSource: "static", priceVerifiedAt: "test",
  dailyCapUsd: 3, spendPath: "/tmp/sentinel-ledger-verify-spend.json",
  callLedgerPath: e2eLedgerPath
});
const server = proxy.listen();
await new Promise((r) => setTimeout(r, 200));

const SECRET_MARKER = "xyzzy-do-not-leak-into-the-ledger-98421";
const post = (body: unknown, auth?: string) =>
  fetch("http://127.0.0.1:9931/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body)
  });

// A named agent, a call carrying a distinctive prompt string.
let res = await post({ model: CHEAP_MODEL, messages: [{ role: "user", content: `the secret is ${SECRET_MARKER}` }], max_tokens: 20 }, "Bearer roberto-ranker");
check("named-agent request admitted", res.status === 200, `got ${res.status}`);
// Sanity check, taken immediately: proves the marker really did leave the
// proxy on this request, so the later "does not leak" checks are proving
// something was withheld, not that nothing was ever sent. A later request
// overwrites lastStubBody, and a refusal never reaches the stub at all, so
// this has to be asserted right here.
check("(sanity) the marker reached the upstream gateway on this call", JSON.stringify(lastStubBody).includes(SECRET_MARKER));

// The default-client placeholder, collapsing to unnamed end-to-end.
res = await post({ model: CHEAP_MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 20 }, "Bearer sentinel-local");
check("sentinel-local collapses to unnamed end-to-end", res.status === 200);

// No Authorization header at all.
res = await post({ model: CHEAP_MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 20 });
check("a request with no auth header is still admitted", res.status === 200);

// A refusal, from the same named agent, also carrying prompt text.
res = await post({ model: "unpriced/model", messages: [{ role: "user", content: `a refused prompt with ${SECRET_MARKER}` }], max_tokens: 20 }, "Bearer roberto-ranker");
check("unpriced model refused", res.status === 402, `got ${res.status}`);

await new Promise((r) => setTimeout(r, 100));

const pageRes = await fetch("http://127.0.0.1:9931/");
const pageText = await pageRes.text();
check("GET / is 200 text/html", pageRes.status === 200 && (pageRes.headers.get("content-type") ?? "").includes("text/html"));
check("the page identifies itself", pageText.includes("Sentinel") && pageText.includes("ledger"));

const dataRes = await fetch("http://127.0.0.1:9931/ledger.json");
const data = await dataRes.json() as ReturnType<typeof buildLedgerViewModel>;
check("GET /ledger.json is 200", dataRes.status === 200);
check("both settled calls attributed to roberto-ranker, one to unnamed x2", (() => {
  const byAgent = new Map(data.byAgent.map((r) => [r.key, r.calls]));
  return byAgent.get("roberto-ranker") === 1 && byAgent.get("unnamed") === 2;
})(), JSON.stringify(data.byAgent));
check("the refusal is attributed to roberto-ranker", data.refusals.length === 1 && data.refusals[0].agent === "roberto-ranker");
check("today's summary matches: 3 settled, 1 refused", data.today.callsMade === 3 && data.today.callsRefused === 1);

// The check that matters most: the secret marker sent in two different
// prompts must not appear anywhere in the persisted ledger file or in the
// JSON this page serves. Read the file as raw text, not parsed -- a leak
// hiding in a field the type doesn't expect would still show up this way.
const rawLedgerFile = (await import("node:fs")).readFileSync(e2eLedgerPath, "utf8");
const rawDataResponse = JSON.stringify(data);
check("the prompt marker does not appear in the persisted ledger file", !rawLedgerFile.includes(SECRET_MARKER));
check("the prompt marker does not appear in the /ledger.json response", !rawDataResponse.includes(SECRET_MARKER));
check("the prompt marker does not appear in the rendered page", !pageText.includes(SECRET_MARKER));

server.close();
stub.close();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
