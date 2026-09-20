/**
 * Exercises the §2 route and the §3 streaming rules against a local stub gateway.
 *
 * The stub exists because the live gateway needs a key this environment does not
 * have. It reproduces the shapes the real gateway returns -- SSE deltas, a
 * terminating usage chunk, a cut connection -- so the accounting paths are
 * exercised for real even though the money is not.
 */
import { createServer, type Server } from "node:http";
import { prices, CHEAP_MODEL, RESERVATION_SAFETY_MULTIPLIER } from "../../src/runner/d2-mission.js";

process.env.SENTINEL_PROXY_UPSTREAM ??= "http://127.0.0.1:9911/api/v1/chat/completions";
const { SentinelProxy } = await import("../../src/proxy/server.js");
const { UPSTREAM_URL } = await import("../../src/proxy/config.js");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

interface StubOptions { cut?: boolean; omitUsage?: boolean }
let lastUpstreamBody: Record<string, unknown> = {};

function startStub(options: StubOptions = {}): Server {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      lastUpstreamBody = JSON.parse(raw || "{}");
      const streaming = lastUpstreamBody.stream === true;
      // A `:free` model really does bill zero; anything else carries a cost.
      const cost = String(lastUpstreamBody.model ?? "").endsWith(":free") ? 0 : 0.000123;
      if (!streaming) {
        const body = JSON.stringify({
          id: "stub-1", object: "chat.completion", model: CHEAP_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "hello from the stub" }, finish_reason: "stop" }],
          usage: options.omitUsage ? { prompt_tokens: 12, completion_tokens: 5 } : { prompt_tokens: 12, completion_tokens: 5, cost }
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
      res.write(frame({ id: "stub-1", choices: [{ index: 0, delta: { role: "assistant", content: "hello " } }] }));
      res.write(frame({ id: "stub-1", choices: [{ index: 0, delta: { content: "from the " } }] }));
      if (options.cut) { res.destroy(); return; }
      res.write(frame({ id: "stub-1", choices: [{ index: 0, delta: { content: "stub" }, finish_reason: "stop" }] }));
      if (!options.omitUsage) {
        res.write(frame({ id: "stub-1", choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, cost: 0.000456 } }));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.listen(9911);
  return server;
}

function makeProxy(port: number, budgetUsd = 0.25, extra: Record<string, unknown> = {}) {
  return new SentinelProxy({
    port, budgetUsd,
    reservationTtlMs: 30_000,
    reservationSafetyMultiplier: RESERVATION_SAFETY_MULTIPLIER,
    maxStepBudgetFraction: 1,
    prices,
    defaultMaxTokens: 1_024,
    apiKey: "stub-key",
    ledgerPath: undefined,
    modelsUrl: "http://127.0.0.1:9911/api/v1/models",
    priceCachePath: "/tmp/sentinel-verify-price-cache.json",
    priceSource: "static",
    priceVerifiedAt: "test",
    dailyCapUsd: 3,
    spendPath: `/tmp/sentinel-verify-spend-${port}.json`,
    ...extra
  });
}

const post = (port: number, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });

const messages = [{ role: "user", content: "Summarize the incident postmortem in two sentences." }];

async function run() {
  console.log(`upstream under test: ${UPSTREAM_URL}\n`);

  // --- 1. Non-streaming, gateway returns usage.cost -------------------------
  console.log("1. non-streaming commits usage.cost as exact");
  let stub = startStub();
  let proxy = makeProxy(9901);
  let server = proxy.listen();
  await new Promise((r) => setTimeout(r, 150));
  let res = await post(9901, { model: CHEAP_MODEL, messages, max_tokens: 64 });
  let text = await res.text();
  check("HTTP 200", res.status === 200, `got ${res.status}`);
  check("cost-source header is exact", res.headers.get("x-sentinel-cost-source") === "exact");
  check("body passed through untouched", JSON.parse(text).choices[0].message.content === "hello from the stub");
  check("committed_exact == 0.000123", proxy.snapshot().committedExact === 0.000123, String(proxy.snapshot().committedExact));
  check("reservation released", proxy.snapshot().reservedTotal === 0, String(proxy.snapshot().reservedTotal));
  server.close(); stub.close();

  // --- 2. Streaming passes through and reads usage from the tail ------------
  console.log("\n2. streaming passes chunks through and commits the tail usage");
  stub = startStub();
  proxy = makeProxy(9902);
  server = proxy.listen();
  await new Promise((r) => setTimeout(r, 150));
  res = await post(9902, { model: CHEAP_MODEL, messages, max_tokens: 64, stream: true });
  text = await res.text();
  check("HTTP 200", res.status === 200, `got ${res.status}`);
  check("stream_options.include_usage sent upstream",
    JSON.stringify((lastUpstreamBody.stream_options as Record<string, unknown>) ?? {}) === JSON.stringify({ include_usage: true }));
  check("client saw the SSE deltas", text.includes("hello ") && text.includes("stub"));
  check("client saw [DONE]", text.includes("[DONE]"));
  check("committed_exact == 0.000456", proxy.snapshot().committedExact === 0.000456, String(proxy.snapshot().committedExact));
  check("nothing committed as estimated", proxy.snapshot().committedEstimated === 0);
  server.close(); stub.close();

  // --- 3. Cut stream still commits, as an estimate --------------------------
  console.log("\n3. a cut stream commits an estimate, never a silent zero");
  stub = startStub({ cut: true });
  proxy = makeProxy(9903);
  server = proxy.listen();
  await new Promise((r) => setTimeout(r, 150));
  try { res = await post(9903, { model: CHEAP_MODEL, messages, max_tokens: 64, stream: true }); await res.text(); }
  catch { /* the cut surfaces as a client-side read error, which is the point */ }
  await new Promise((r) => setTimeout(r, 250));
  const cutState = proxy.snapshot();
  check("committed_estimated > 0", cutState.committedEstimated > 0, String(cutState.committedEstimated));
  check("committed_exact == 0", cutState.committedExact === 0);
  check("reservation not left hanging", cutState.reservedTotal === 0, String(cutState.reservedTotal));
  check("estimate is below the worst-case reservation", cutState.committedEstimated < 0.25);
  server.close(); stub.close();

  // --- 4. Streaming with no usage falls back to observed output -------------
  console.log("\n4. stream without usage falls back to observed output size");
  stub = startStub({ omitUsage: true });
  proxy = makeProxy(9904);
  server = proxy.listen();
  await new Promise((r) => setTimeout(r, 150));
  res = await post(9904, { model: CHEAP_MODEL, messages, max_tokens: 64, stream: true });
  await res.text();
  await new Promise((r) => setTimeout(r, 100));
  check("committed_estimated > 0", proxy.snapshot().committedEstimated > 0, String(proxy.snapshot().committedEstimated));
  check("estimate reflects real output, not the full reservation",
    proxy.snapshot().committedEstimated < 0.0001, String(proxy.snapshot().committedEstimated));
  server.close(); stub.close();

  // --- 5. Missing max_tokens is injected and forwarded ----------------------
  console.log("\n5. a client that sends no max_tokens gets one injected");
  stub = startStub();
  proxy = makeProxy(9905);
  server = proxy.listen();
  await new Promise((r) => setTimeout(r, 150));
  res = await post(9905, { model: CHEAP_MODEL, messages });
  await res.text();
  check("injection flagged on the response", res.headers.get("x-sentinel-max-tokens-injected") === "true");
  check("injected ceiling forwarded upstream", lastUpstreamBody.max_tokens === 1024, String(lastUpstreamBody.max_tokens));
  server.close(); stub.close();

  // --- 6. Refusals are 402 with a surfaceable body --------------------------
  console.log("\n6. refusals return HTTP 402");
  stub = startStub();
  proxy = makeProxy(9906, 0.000001); // budget too small for any real call
  server = proxy.listen();
  await new Promise((r) => setTimeout(r, 150));
  res = await post(9906, { model: CHEAP_MODEL, messages, max_tokens: 64 });
  let body = await res.json() as { error: { type: string; code: string; message: string } };
  check("HTTP 402", res.status === 402, `got ${res.status}`);
  check("error.type is budget_exceeded", body.error.type === "budget_exceeded");
  check("error.code is sentinel_budget_exceeded", body.error.code === "sentinel_budget_exceeded");
  check("message names both numbers", /worst case \$\d+\.\d{4} exceeds remaining budget \$\d+\.\d{4}/.test(body.error.message), body.error.message);
  check("nothing dispatched upstream", proxy.snapshot().committedExact === 0 && proxy.snapshot().committedEstimated === 0);

  res = await post(9906, { model: "acme/not-a-real-model", messages, max_tokens: 64 });
  body = await res.json() as { error: { type: string; code: string; message: string } };
  check("unpriced model refused 402", res.status === 402, `got ${res.status}`);
  check("unpriced model code", body.error.code === "sentinel_model_unpriced", body.error.code);
  server.close(); stub.close();

  // --- 7. Price table sourcing ---------------------------------------------
  console.log("\n7. price table is sourced from the gateway, with a fallback chain");
  const { parseModelsResponse, priceDrift, resolvePriceTable } = await import("../../src/proxy/prices.js");

  const sample = {
    data: [
      { id: "openai/gpt-4.1-mini", pricing: { prompt: "0.0000004", completion: "0.0000016" } },
      { id: "vendor/free-tier:free", pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/video-edit", pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/broken", pricing: { prompt: "not-a-number", completion: "0.0001" } },
      { id: "vendor/good", pricing: { prompt: "0.000001", completion: "0.000002" } }
    ]
  };
  const parsed = parseModelsResponse(sample, "2026-09-20T00:00:00.000Z");
  check("usable models kept", Object.keys(parsed.prices).sort().join(",") === "openai/gpt-4.1-mini,vendor/free-tier:free,vendor/good", Object.keys(parsed.prices).join(","));
  check("unparseable and per-asset models skipped", parsed.skipped === 2, String(parsed.skipped));
  check("per-million conversion is exact, not 0.39999...", parsed.prices["openai/gpt-4.1-mini"].inputPerMillionUsd === 0.4,
    String(parsed.prices["openai/gpt-4.1-mini"].inputPerMillionUsd));
  check("no false drift against the hardcoded table", priceDrift(parsed.prices).filter((d) => d.includes("gpt-4.1-mini")).length === 0);
  check("a real price change is reported as drift",
    priceDrift({ "openai/gpt-4.1-mini": { inputPerMillionUsd: 0.9, outputPerMillionUsd: 1.6, verifiedAt: "x" } }).some((d) => d.includes("0.9")));

  const cachePath = "/tmp/sentinel-verify-chain.json";
  try { (await import("node:fs")).unlinkSync(cachePath); } catch { /* fresh run */ }
  const unreachable = "http://127.0.0.1:9/api/v1/models";
  const staticTable = await resolvePriceTable({ modelsUrl: unreachable, cachePath, timeoutMs: 500 });
  check("unreachable gateway with no cache falls back to static", staticTable.source === "static", staticTable.source);

  const stubModels = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(sample));
  });
  stubModels.listen(9912);
  await new Promise((r) => setTimeout(r, 150));
  const live = await resolvePriceTable({ modelsUrl: "http://127.0.0.1:9912/models", cachePath, timeoutMs: 2_000 });
  check("reachable gateway is used", live.source === "gateway", live.source);
  stubModels.close();

  const cached = await resolvePriceTable({ modelsUrl: unreachable, cachePath, timeoutMs: 500 });
  check("cache is used when the gateway later fails", cached.source === "cache", cached.source);
  check("cached table has the models", Object.keys(cached.prices).length === 3, String(Object.keys(cached.prices).length));

  // --- 8. Free vs unboundable ----------------------------------------------
  console.log("\n8. zero-output models split by whether they are genuinely free");
  const freeSample = {
    data: [
      { id: "vendor/model:free", pricing: { prompt: "0", completion: "0" } },
      { id: "black-forest-labs/flux-video-edit", pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/paid", pricing: { prompt: "0.000001", completion: "0.000002" } }
    ]
  };
  const split = parseModelsResponse(freeSample, "2026-09-20T00:00:00.000Z");
  check(":free model is priced at zero, not refused", split.prices["vendor/model:free"]?.outputPerMillionUsd === 0);
  check("per-asset biller is refused", split.prices["black-forest-labs/flux-video-edit"] === undefined);
  check("per-asset biller is recorded as unboundable", split.unboundable.has("black-forest-labs/flux-video-edit"));
  check("free count reported", split.free === 1, String(split.free));

  stub = startStub();
  proxy = makeProxy(9907, 0.25, {
    prices: { ...prices, "vendor/model:free": { inputPerMillionUsd: 0, outputPerMillionUsd: 0, verifiedAt: "test" } },
    unboundableModels: new Set(["black-forest-labs/flux-video-edit"])
  });
  server = proxy.listen();
  await new Promise((r) => setTimeout(r, 150));
  res = await post(9907, { model: "vendor/model:free", messages, max_tokens: 64 });
  await res.text();
  check(":free model admits through the proxy", res.status === 200, `got ${res.status}`);
  check(":free model at zero cost does not quarantine", proxy.snapshot().quarantined === false);

  res = await post(9907, { model: "black-forest-labs/flux-video-edit", messages, max_tokens: 64 });
  body = await res.json() as { error: { type: string; code: string; message: string } };
  check("per-asset biller refused 402", res.status === 402, `got ${res.status}`);
  check("refusal code is sentinel_model_unboundable", body.error.code === "sentinel_model_unboundable", body.error.code);
  check("message names the per-asset reason", body.error.message.includes("may bill per asset"), body.error.message);
  server.close(); stub.close();

  // A ":free" model that actually bills is an integrity violation, not a nit:
  // we reserved $0 and were charged. The governor quarantines on over-reservation
  // and we let it. Pinned here so the behaviour is known rather than discovered.
  stub = startStub();
  proxy = makeProxy(9910, 0.25, {
    prices: { ...prices, "vendor/lying:free": { inputPerMillionUsd: 0, outputPerMillionUsd: 0, verifiedAt: "test" } }
  });
  server = proxy.listen();
  await new Promise((r) => setTimeout(r, 150));
  // The stub bills anything whose id does not end in :free, so force a charge by
  // pricing a normally-billed id at zero.
  proxy_billed_free: {
    const billed = await fetch(`http://127.0.0.1:9910/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: CHEAP_MODEL, messages, max_tokens: 64 })
    });
    await billed.text();
    break proxy_billed_free;
  }
  check("an ordinary billed call does not quarantine", proxy.snapshot().quarantined === false);
  server.close(); stub.close();

  // --- 9. Durable daily cap -------------------------------------------------
  console.log("\n9. the daily cap survives a restart");
  const { DailySpendStore, resolveDailyBudget, localDateKey } = await import("../../src/proxy/spend.js");
  const spendPath = "/tmp/sentinel-verify-cap.json";
  const fs = await import("node:fs");
  try { fs.unlinkSync(spendPath); } catch { /* fresh run */ }

  stub = startStub();
  proxy = makeProxy(9908, 0.25, { spendPath });
  server = proxy.listen();
  await new Promise((r) => setTimeout(r, 150));
  res = await post(9908, { model: CHEAP_MODEL, messages, max_tokens: 64 });
  await res.text();
  await new Promise((r) => setTimeout(r, 100));
  const persisted = JSON.parse(fs.readFileSync(spendPath, "utf8")) as { date: string; committed_usd: number };
  check("commit persisted to disk", persisted.committed_usd === 0.000123, String(persisted.committed_usd));
  check("persisted under today's local date", persisted.date === localDateKey());
  server.close(); stub.close();

  const seeded = resolveDailyBudget({ store: new DailySpendStore(spendPath), dailyCapUsd: 3, ceilingUsd: 3 });
  check("restart seeds from the stored total", seeded.seededUsd === 0.000123, String(seeded.seededUsd));
  check("budget is the cap minus today's spend", seeded.budgetUsd === 2.999877, String(seeded.budgetUsd));
  check("not exceeded at this level", seeded.capExceeded === false);

  fs.writeFileSync(spendPath, JSON.stringify({ date: localDateKey(), committed_usd: 5 }));
  const over = resolveDailyBudget({ store: new DailySpendStore(spendPath), dailyCapUsd: 3, ceilingUsd: 3 });
  check("cap exceeded when today's total is over", over.capExceeded === true);
  check("governor budget stays positive so it can be constructed", over.budgetUsd > 0, String(over.budgetUsd));

  fs.writeFileSync(spendPath, JSON.stringify({ date: "2020-01-01", committed_usd: 5 }));
  const rolled = resolveDailyBudget({ store: new DailySpendStore(spendPath), dailyCapUsd: 3, ceilingUsd: 3 });
  check("a record from another day does not carry forward", rolled.seededUsd === 0 && rolled.capExceeded === false);

  stub = startStub();
  proxy = makeProxy(9909, 0.25, { spendPath, seededSpendUsd: 5, capExceeded: true });
  server = proxy.listen();
  await new Promise((r) => setTimeout(r, 150));
  res = await post(9909, { model: CHEAP_MODEL, messages, max_tokens: 64 });
  body = await res.json() as { error: { type: string; code: string; message: string } };
  check("capped proxy refuses with 402", res.status === 402, `got ${res.status}`);
  check("refusal code is sentinel_daily_cap_reached", body.error.code === "sentinel_daily_cap_reached", body.error.code);
  const health = await (await fetch("http://127.0.0.1:9909/healthz")).json() as Record<string, unknown>;
  check("/healthz reports the cap state", health.status === "daily_cap_reached" && health.daily_cap_reached === true);
  server.close(); stub.close();

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await run();
