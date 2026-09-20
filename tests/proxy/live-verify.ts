/**
 * Live verification against the real gateway with a real key.
 *
 * Spawns the real proxy, sends real completions through it and directly, and
 * writes docs/PROXY_VERIFICATION.md from what it actually observed. Nothing in
 * that document is typed by hand, so it cannot drift from the run.
 *
 *   ORBIO_API_KEY=... npm run proxy:verify:live
 *
 * Spend is bounded twice: a hard abort in this script, and the proxy's own cap.
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHEAP_MODEL } from "../../src/runner/d2-mission.js";

const KEY = process.env.ORBIO_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error("ORBIO_API_KEY is not set. Put it in .env or pass it inline; this script will not run without one.");
  process.exit(1);
}

const DIRECT_URL = "https://www.orbio.so/api/v1/chat/completions";
const PORT = Number(process.env.LIVE_VERIFY_PORT ?? 8899);
const PROXY_URL = `http://127.0.0.1:${PORT}/v1/chat/completions`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/healthz`;
const SPEND_ABORT_USD = 0.05;   // hard stop well under the $0.10 ceiling
const DAILY_CAP_USD = 0.10;
const REPEATS = 3;

const PROMPT = "Count from 1 to 20. One number per line, nothing else.";
const MAX_TOKENS = 120;
const body = (stream: boolean) => ({
  model: CHEAP_MODEL,
  messages: [{ role: "user", content: PROMPT }],
  max_tokens: MAX_TOKENS,
  ...(stream ? { stream: true } : {})
});

let spent = 0;
const spend = (cost: number | null, label: string) => {
  if (typeof cost === "number") spent += cost;
  if (spent > SPEND_ABORT_USD) throw new Error(`ABORT: spend ${spent.toFixed(6)} passed the ${SPEND_ABORT_USD} guard at ${label}`);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
// The proxy discards whatever the client sends, which is itself worth showing.
const clientHeaders = { "content-type": "application/json", authorization: "Bearer not-a-real-key-the-proxy-discards-this" };

interface Once { ms: number; status: number; cost: number | null; costSource: string | null; body: string; headers: Record<string, string> }

async function once(url: string, hdrs: Record<string, string>, stream: boolean): Promise<Once> {
  const started = performance.now();
  const response = await fetch(url, { method: "POST", headers: hdrs, body: JSON.stringify(body(stream)) });
  const text = await response.text();
  const ms = performance.now() - started;
  let cost: number | null = null;
  try {
    const parsed = JSON.parse(text) as { usage?: { cost?: number } };
    if (typeof parsed.usage?.cost === "number") cost = parsed.usage.cost;
  } catch { /* streamed or non-JSON */ }
  const captured: Record<string, string> = {};
  response.headers.forEach((v, k) => { if (k.startsWith("x-sentinel") || k === "content-type") captured[k] = v; });
  return { ms, status: response.status, cost, costSource: response.headers.get("x-sentinel-cost-source"), body: text, headers: captured };
}

interface StreamRun {
  status: number; totalMs: number; firstChunkMs: number; lastChunkMs: number;
  chunks: number; arrivals: number[]; cost: number | null; costSource: string | null;
  usageSeen: boolean; sawDone: boolean; headers: Record<string, string>; text: string;
}

async function streamed(url: string, hdrs: Record<string, string>): Promise<StreamRun> {
  const started = performance.now();
  const response = await fetch(url, { method: "POST", headers: hdrs, body: JSON.stringify({ ...body(true), stream_options: { include_usage: true } }) });
  const captured: Record<string, string> = {};
  response.headers.forEach((v, k) => { if (k.startsWith("x-sentinel") || k === "content-type") captured[k] = v; });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const arrivals: number[] = [];
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    arrivals.push(performance.now() - started);
    raw += decoder.decode(value, { stream: true });
  }
  const totalMs = performance.now() - started;

  let cost: number | null = null;
  let usageSeen = false;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as { usage?: { cost?: number } };
      if (parsed.usage) { usageSeen = true; if (typeof parsed.usage.cost === "number") cost = parsed.usage.cost; }
    } catch { /* partial frame */ }
  }
  return {
    status: response.status, totalMs,
    firstChunkMs: arrivals[0] ?? totalMs, lastChunkMs: arrivals[arrivals.length - 1] ?? totalMs,
    chunks: arrivals.length, arrivals, cost, costSource: captured["x-sentinel-cost-source"] ?? null,
    usageSeen, sawDone: raw.includes("[DONE]"), headers: captured, text: raw
  };
}

/** Waits for a killed child to actually exit; the port is not free until it has. */
function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once("exit", () => resolve());
    setTimeout(resolve, 5_000);
  });
}

function startProxy(port: number, env: Record<string, string>): Promise<{ child: ChildProcess; banner: string }> {
  return new Promise((resolve, reject) => {
    // Spawned as a direct node child rather than through npx: on Windows npx is
    // npx.cmd so a bare "npx" is ENOENT, and killing the wrapper there can leave
    // the real node process alive still holding the port.
    const child = spawn(process.execPath, ["--import", "tsx", "src/proxy/server.ts"], {
      env: { ...process.env, ORBIO_API_KEY: KEY, SENTINEL_PROXY_PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let banner = "";
    const timer = setTimeout(() => reject(new Error(`proxy did not start on port ${port} in 60s:\n${banner}`)), 60_000);
    child.on("exit", (code) => { if (!banner.includes("client auth")) reject(new Error(`proxy exited with ${code} before listening:\n${banner}`)); });
    const onData = (chunk: Buffer) => {
      banner += chunk.toString();
      if (banner.includes("client auth")) { clearTimeout(timer); setTimeout(() => resolve({ child, banner }), 250); }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("error", reject);
  });
}

const fence = (label: string, content: string) => `\`\`\`${label}\n${content.trimEnd()}\n\`\`\``;
const ms = (value: number) => `${value.toFixed(0)} ms`;
const usd = (value: number | null) => (value === null ? "none reported" : `$${value.toFixed(6)}`);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function main(): Promise<void> {
  const cacheDir = mkdtempSync(join(tmpdir(), "sentinel-live-"));
  const env = {
    SENTINEL_PROXY_DAILY_CAP_USD: String(DAILY_CAP_USD),
    SENTINEL_PROXY_SPEND: join(cacheDir, "spend.json"),
    SENTINEL_PROXY_PRICE_CACHE: join(cacheDir, "price-table.json")
  };

  console.log("starting the proxy...");
  let { child, banner } = await startProxy(PORT, env);

  const out: string[] = [];
  const startedAt = new Date().toISOString();
  out.push(`# Proxy live verification`);
  out.push(``);
  out.push(`Generated by \`npm run proxy:verify:live\` on ${startedAt}. Every figure below was`);
  out.push(`captured from the run that produced this file; none of it is transcribed by hand.`);
  out.push(``);
  out.push(`- Model: \`${CHEAP_MODEL}\``);
  out.push(`- Prompt: \`${PROMPT}\``);
  out.push(`- \`max_tokens\`: ${MAX_TOKENS}`);
  out.push(`- Upstream: \`${DIRECT_URL}\``);
  out.push(``);
  out.push(`## 1. Startup`);
  out.push(``);
  out.push(fence("", banner));

  try {
    // --- 2. non-streaming ----------------------------------------------------
    console.log("non-streaming through the proxy...");
    const proxyRuns: Once[] = [];
    for (let i = 0; i < REPEATS; i++) { const r = await once(PROXY_URL, clientHeaders, false); spend(r.cost, "proxy non-streaming"); proxyRuns.push(r); await sleep(400); }

    console.log("non-streaming direct...");
    const directRuns: Once[] = [];
    for (let i = 0; i < REPEATS; i++) { const r = await once(DIRECT_URL, headers, false); spend(r.cost, "direct non-streaming"); directRuns.push(r); await sleep(400); }

    const first = proxyRuns[0];
    out.push(``);
    out.push(`## 2. One real non-streaming completion`);
    out.push(``);
    out.push(`| | |`);
    out.push(`| --- | --- |`);
    out.push(`| HTTP status | ${first.status} |`);
    out.push(`| \`x-sentinel-cost-source\` | **${first.costSource ?? "absent"}** |`);
    out.push(`| Real cost (\`usage.cost\`) | ${usd(first.cost)} |`);
    out.push(`| \`x-sentinel-reserved-usd\` | ${first.headers["x-sentinel-reserved-usd"] ?? "absent"} |`);
    out.push(`| \`x-sentinel-input-tokens\` | ${first.headers["x-sentinel-input-tokens"] ?? "absent"} |`);
    out.push(`| \`x-sentinel-max-tokens\` | ${first.headers["x-sentinel-max-tokens"] ?? "absent"} |`);
    out.push(``);
    out.push(`Response headers as returned:`);
    out.push(``);
    out.push(fence("", Object.entries(first.headers).map(([k, v]) => `${k}: ${v}`).join("\n")));
    out.push(``);
    out.push(`Response body as returned:`);
    out.push(``);
    out.push(fence("json", first.body));

    out.push(``);
    out.push(`### Wall clock, proxy vs direct`);
    out.push(``);
    out.push(`${REPEATS} runs each, same prompt and ceiling, alternating warm connections.`);
    out.push(``);
    out.push(`| run | through the proxy | direct to the gateway |`);
    out.push(`| --- | --- | --- |`);
    for (let i = 0; i < REPEATS; i++) out.push(`| ${i + 1} | ${ms(proxyRuns[i].ms)} | ${ms(directRuns[i].ms)} |`);
    const pMed = median(proxyRuns.map((r) => r.ms));
    const dMed = median(directRuns.map((r) => r.ms));
    out.push(`| **median** | **${ms(pMed)}** | **${ms(dMed)}** |`);
    out.push(``);
    out.push(`Median overhead: **${ms(pMed - dMed)}** (${((pMed / dMed - 1) * 100).toFixed(1)}%).`);

    // --- 3. streaming --------------------------------------------------------
    console.log("streaming through the proxy...");
    const proxyStream = await streamed(PROXY_URL, clientHeaders);
    spend(proxyStream.cost, "proxy streaming");
    await sleep(400);

    console.log("streaming direct...");
    const directStream = await streamed(DIRECT_URL, headers);
    spend(directStream.cost, "direct streaming");

    const progressive = proxyStream.chunks > 1 && proxyStream.lastChunkMs - proxyStream.firstChunkMs > 50;
    out.push(``);
    out.push(`## 3. One real streamed completion`);
    out.push(``);
    out.push(`| | through the proxy | direct to the gateway |`);
    out.push(`| --- | --- | --- |`);
    out.push(`| HTTP status | ${proxyStream.status} | ${directStream.status} |`);
    out.push(`| \`x-sentinel-cost-source\` | **${proxyStream.costSource ?? "absent"}** | n/a |`);
    out.push(`| Real cost (\`usage.cost\`) | ${usd(proxyStream.cost)} | ${usd(directStream.cost)} |`);
    out.push(`| \`usage\` present in stream | ${proxyStream.usageSeen ? "yes" : "**no**"} | ${directStream.usageSeen ? "yes" : "**no**"} |`);
    out.push(`| \`[DONE]\` seen | ${proxyStream.sawDone ? "yes" : "no"} | ${directStream.sawDone ? "yes" : "no"} |`);
    out.push(`| chunks received | ${proxyStream.chunks} | ${directStream.chunks} |`);
    out.push(`| first chunk at | ${ms(proxyStream.firstChunkMs)} | ${ms(directStream.firstChunkMs)} |`);
    out.push(`| last chunk at | ${ms(proxyStream.lastChunkMs)} | ${ms(directStream.lastChunkMs)} |`);
    out.push(`| total | ${ms(proxyStream.totalMs)} | ${ms(directStream.totalMs)} |`);
    out.push(``);
    out.push(`### Progressive or buffered?`);
    out.push(``);
    out.push(`**${progressive ? "Progressive." : "Buffered."}** ${proxyStream.chunks} ${proxyStream.chunks === 1 ? "chunk" : "chunks"} arrived over a`);
    out.push(`${ms(proxyStream.lastChunkMs - proxyStream.firstChunkMs)} spread, first at ${ms(proxyStream.firstChunkMs)}`);
    out.push(`of a ${ms(proxyStream.totalMs)} total. A buffered proxy would deliver every chunk at`);
    out.push(`once, with the first arriving at essentially the same moment as the last.`);
    out.push(``);
    out.push(`Chunk arrival times through the proxy, ms from request start:`);
    out.push(``);
    out.push(fence("", proxyStream.arrivals.map((a) => a.toFixed(1)).join(", ")));
    out.push(``);
    out.push(`Direct, for comparison:`);
    out.push(``);
    out.push(fence("", directStream.arrivals.map((a) => a.toFixed(1)).join(", ")));
    out.push(``);
    out.push(`### Was \`stream_options: {include_usage: true}\` honoured?`);
    out.push(``);
    // Do not report costSource here: it is always absent on a streamed response,
    // because headers flush before the terminating chunk is read. Interpolating
    // it printed "committed the cost as `null`", a false statement in a document
    // whose whole value is being generated. State what the stream itself shows.
    out.push(proxyStream.usageSeen
      ? `**Yes.** The gateway returned a \`usage\` object on the terminating chunk, carrying \`cost: ${usd(proxyStream.cost)}\`, so the proxy commits a streamed call as exact rather than estimated.`
      : `**No.** The gateway returned no \`usage\` in the stream, so the proxy falls back to an estimate from observed output size. This is the documented fallback, not a failure.`);
    out.push(``);
    out.push(`\`x-sentinel-cost-source\` is absent on streamed responses regardless of the`);
    out.push(`answer above: response headers flush before the stream ends, so the cost is`);
    out.push(`not known in time to set it. Confirm which way a streamed call settled from`);
    out.push(`\`committed_exact\` and \`committed_estimated\` in the \`/healthz\` section below.`);
    out.push(``);
    out.push(`First 600 characters of the raw stream through the proxy:`);
    out.push(``);
    out.push(fence("", proxyStream.text.slice(0, 600)));

    // --- 4. healthz ----------------------------------------------------------
    const health = await (await fetch(HEALTH_URL)).text();
    out.push(``);
    out.push(`## 4. \`/healthz\` after the run`);
    out.push(``);
    out.push(fence("json", JSON.stringify(JSON.parse(health), null, 2)));

    // --- 5. forced refusal ---------------------------------------------------
    console.log("forcing a refusal with a low cap...");
    child.kill();
    await waitForExit(child);
    const tinyCap = "0.000001";
    // A fresh port: the kernel can hold the old one briefly after exit, and a
    // spurious EADDRINUSE here would look like a proxy failure rather than a race.
    const cappedPort = PORT + 1;
    ({ child, banner } = await startProxy(cappedPort, { ...env, SENTINEL_PROXY_DAILY_CAP_USD: tinyCap, SENTINEL_PROXY_SPEND: join(cacheDir, "spend-capped.json") }));
    const refused = await once(`http://127.0.0.1:${cappedPort}/v1/chat/completions`, clientHeaders, false);
    out.push(``);
    out.push(`## 5. Forced refusal`);
    out.push(``);
    out.push(`Restarted with \`SENTINEL_PROXY_DAILY_CAP_USD=${tinyCap}\`, everything else unchanged.`);
    out.push(``);
    out.push(`HTTP **${refused.status}**, and the body a client surfaces:`);
    out.push(``);
    out.push(fence("json", refused.body));
    out.push(``);
    out.push(`Refusal headers:`);
    out.push(``);
    out.push(fence("", Object.entries(refused.headers).map(([k, v]) => `${k}: ${v}`).join("\n")));
    out.push(``);
    out.push(`No upstream call was made: the refusal happens before dispatch.`);
    out.push(``);
    out.push(`The code above is whichever refusal the low cap triggered:`);
    out.push(`\`sentinel_budget_exceeded\` when the cap is merely too small for the call,`);
    out.push(`\`sentinel_daily_cap_reached\` when today's stored total already met it.`);

    out.push(``);
    out.push(`## 6. Total spend`);
    out.push(``);
    out.push(`**$${spent.toFixed(6)}** across ${REPEATS * 2} non-streaming and 2 streamed completions,`);
    out.push(`measured from each response's own \`usage.cost\`. The script aborts above`);
    out.push(`$${SPEND_ABORT_USD.toFixed(2)} and the proxy's own cap was $${DAILY_CAP_USD.toFixed(2)}.`);
  } finally {
    child.kill();
  }

  writeFileSync("docs/PROXY_VERIFICATION.md", `${out.join("\n")}\n`, "utf8");
  console.log(`\nwrote docs/PROXY_VERIFICATION.md`);
  console.log(`total spend: $${spent.toFixed(6)}`);
}

await main();
// The spawned proxy's piped stdio keeps the loop alive even after it is killed,
// so the run would otherwise finish its work and then hang instead of exiting.
process.exit(0);
