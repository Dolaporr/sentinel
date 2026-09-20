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
      if (!streaming) {
        const body = JSON.stringify({
          id: "stub-1", object: "chat.completion", model: CHEAP_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "hello from the stub" }, finish_reason: "stop" }],
          usage: options.omitUsage ? { prompt_tokens: 12, completion_tokens: 5 } : { prompt_tokens: 12, completion_tokens: 5, cost: 0.000123 }
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

function makeProxy(port: number, budgetUsd = 0.25) {
  return new SentinelProxy({
    port, budgetUsd,
    reservationTtlMs: 30_000,
    reservationSafetyMultiplier: RESERVATION_SAFETY_MULTIPLIER,
    maxStepBudgetFraction: 1,
    prices,
    defaultMaxTokens: 1_024,
    apiKey: "stub-key",
    ledgerPath: undefined
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

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await run();
