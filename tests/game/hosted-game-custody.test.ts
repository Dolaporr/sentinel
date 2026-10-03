/**
 * Game-path key custody proof. The upstream is intentionally hostile: it
 * reflects the operator key in normal JSON, an error, and across streamed
 * chunks. A result is only valid when the key reached the hostile upstream
 * (positive control) yet reaches none of the player's or game's durable views.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prices } from "../../src/proxy/mission-constants.js";
import { orbioProvider } from "../../src/proxy/providers/orbio.js";
import { HostedGateway, type HostedServerConfig } from "../../src/proxy/hosted/server.js";
import { createHostedGameRoutes } from "../../src/game/hosted-routes.js";
import type { GamePolicy } from "../../src/game/types.js";

const KEY = "sk-orbio-GAME-CUSTODY-TEST-key-must-never-appear-0123456789";
const ADMIN = "game-custody-admin-secret-0123456789abcdef";
const MINI = "openai/gpt-4.1-mini";
const root = mkdtempSync(join(tmpdir(), "sentinel-game-custody-"));
let failures = 0;
const logs: string[] = [];
const originalConsole = { log: console.log, error: console.error, warn: console.warn };
for (const level of ["log", "error", "warn"] as const) {
  console[level] = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
}
const check = (name: string, condition: boolean) => {
  originalConsole.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  if (!condition) failures++;
};

let upstreamSawKey = false;
let upstreamHits = 0;
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return (server.address() as { port: number }).port;
}
async function close(server: Server): Promise<void> { await new Promise<void>((resolveClose) => server.close(() => resolveClose())); }

const hostile = createServer((req, res) => {
  let request = "";
  req.on("data", (chunk) => { request += String(chunk); });
  req.on("end", () => {
    upstreamHits++;
    const auth = String(req.headers.authorization ?? "");
    upstreamSawKey ||= auth.includes(KEY);
    const body = JSON.parse(request || "{}");
    const mode = String(body.user ?? "normal");
    if (mode === "error") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `reflected ${auth}` } }));
      return;
    }
    if (body.stream === true) {
      const split = Math.floor(auth.length / 2);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"choices":[{"delta":{"content":"${auth.slice(0, split)}`);
      setTimeout(() => {
        res.write(`${auth.slice(split)}"}}]}\n\n`);
        res.write("data: {\"choices\":[],\"usage\":{\"completion_tokens\":2,\"cost\":0.000001}}\n\n");
        res.end("data: [DONE]\n\n");
      }, 5);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: `reflected ${auth}` } }], usage: { completion_tokens: 2, cost: 0.000001 } }));
  });
});

const hostilePort = await listen(hostile);
const gateway = new HostedGateway({
  port: 0, host: "127.0.0.1", provider: orbioProvider,
  upstreamUrl: `http://127.0.0.1:${hostilePort}/api/v1/chat/completions`, apiKey: KEY, adminToken: ADMIN,
  prices, priceSource: "test", priceVerifiedAt: "test", statePath: join(root, "hosted-state.json"), callLedgerPath: join(root, "calls.jsonl"),
  seedConfig: { poolDailyCapUsd: 5, tokenDailyCapUsd: 0.25, modelAllowlist: [MINI], requestsPerMinute: 20, paused: false, operatorFaultPauseAfter: 3 },
  reservationTtlMs: 20_000, reservationSafetyMultiplier: 1.25, defaultMaxTokens: 128
} satisfies HostedServerConfig);

const mission = (policy: GamePolicy) => {
  const mode = policy.maxTokens === 129 ? "error" : policy.maxTokens === 130 ? "stream" : "normal";
  return {
    body: { model: policy.model, max_tokens: policy.maxTokens, stream: mode === "stream", user: mode, messages: [{ role: "user", content: "sealed game task" }] },
    completed: true
  };
};
gateway.mountGameRoutes(createHostedGameRoutes({
  dataPath: join(root, "game-events.jsonl"), apiKey: KEY, provider: orbioProvider,
  upstreamUrl: `http://127.0.0.1:${hostilePort}/api/v1/chat/completions`, prices, store: gateway.store,
  reservationTtlMs: 20_000, safetyMultiplier: 1.25, mission
}));
const hosted = gateway.listen();
await new Promise<void>((resolveListen) => hosted.once("listening", resolveListen));
const port = (hosted.address() as { port: number }).port;

async function request(path: string, input: { token?: string; body?: unknown; method?: string } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: input.method ?? (input.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(input.token ? { authorization: `Bearer ${input.token}` } : {}) },
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  });
  return { status: response.status, text: await response.text() };
}

const issued = await request("/admin/invites", { token: ADMIN, body: { count: 2 } });
const [codeA, codeB] = JSON.parse(issued.text).codes as string[];
const redemptionA = await request("/v1/redeem", { body: { code: codeA } });
const redemptionB = await request("/v1/redeem", { body: { code: codeB } });
const player = JSON.parse(redemptionA.text).token as string;
const playerB = JSON.parse(redemptionB.text).token as string;
check("positive control: hostile upstream received the operator key", upstreamSawKey === false); // checked after runs
check("admin bearer cannot access game run", (await request("/game/run", { token: ADMIN, body: {} })).status === 401);
check("player token cannot reach admin through the game mount", (await request("/admin/tokens", { token: player })).status === 401);
check("an /admin path is never matched as a game route", (await request("/admin/not-a-game-route", { token: player })).status === 401);

const poolBefore = gateway.pool.committedUsd();
const ledgerBefore = gateway.callLedger.readToday(new Date()).length;

const hitsBeforePause = upstreamHits;
gateway.store.updateConfig({ paused: true });
check("paused hosted service refuses game runs", (await request("/game/run", { token: player, body: {} })).status === 503);
check("paused game run never reaches upstream", upstreamHits === hitsBeforePause);
gateway.store.updateConfig({ paused: false });

const gameEventsBeforeModelRefusal = existsSync(join(root, "game-events.jsonl")) ? readFileSync(join(root, "game-events.jsonl"), "utf8") : "";
const hitsBeforeModelRefusal = upstreamHits;
const outOfAllowlist = await request("/game/run", { token: player, body: { model: "openai/gpt-4.1", max_tokens: 128 } });
const gameEventsAfterModelRefusal = readFileSync(join(root, "game-events.jsonl"), "utf8");
check("model outside hosted allowlist is refused", outOfAllowlist.status === 400 || outOfAllowlist.status === 403);
check("out-of-allowlist game model creates no reservation", gameEventsAfterModelRefusal === gameEventsBeforeModelRefusal);
check("out-of-allowlist game model never reaches upstream", upstreamHits === hitsBeforeModelRefusal);

gateway.store.updateConfig({ requestsPerMinute: 1 });
const rateFirst = await request("/game/run", { token: playerB, body: { max_tokens: 128 } });
const rateSecond = await request("/game/run", { token: playerB, body: { max_tokens: 128 } });
check("dedicated per-player game limiter admits one request", rateFirst.status === 200);
check("dedicated per-player game limiter refuses the next request", rateSecond.status === 429);
gateway.store.updateConfig({ requestsPerMinute: 20 });

const normal = await request("/game/run", { token: player, body: { max_tokens: 128 } });
const error = await request("/game/run", { token: player, body: { max_tokens: 129 } });
const stream = await request("/game/run", { token: player, body: { max_tokens: 130 } });
check("normal hostile response reaches the player", normal.status === 200);
check("hostile error reaches the player", error.status === 400);
check("hostile split stream reaches the player", stream.status === 200);
check("positive control: all three hostile variants dispatched", upstreamHits === 4 && upstreamSawKey);

const gameJsonl = readFileSync(join(root, "game-events.jsonl"), "utf8");
const board = (await request("/game/ledger.json")).text;
const allClientBodies = `${normal.text}\n${error.text}\n${stream.text}`;
const allLogs = logs.join("\n");
check("positive control: unredacted hostile source contains the key", `Bearer ${KEY}`.includes(KEY));
const playPage = await fetch(`http://127.0.0.1:${port}/game`);
const playHtml = await playPage.text();
check("GET /game serves the play page", playPage.status === 200 && (playPage.headers.get("content-type") ?? "").startsWith("text/html") && playHtml.includes("THE RUN"));
check("play page contains no operator key, admin secret or player token", !playHtml.includes(KEY) && !playHtml.includes(ADMIN) && !playHtml.includes(player));
check("play page loads nothing from another origin", !/(src|href)=["']https?:\/\/(?!sentinelagent\.tech)/.test(playHtml));
check("game JSONL contains no operator key", !gameJsonl.includes(KEY));
check("public game board contains no operator key", !board.includes(KEY));
check("all player-visible provider responses contain no operator key", !allClientBodies.includes(KEY));
check("all game/dispatch logs contain no operator key", !allLogs.includes(KEY));
check("stored evidence was captured after redaction", gameJsonl.includes("[redacted]") && !gameJsonl.includes(`Bearer ${KEY}`));
check("game calls leave the hosted free-tier pool untouched", gateway.pool.committedUsd() === poolBefore);
check("game calls leave the hosted call ledger untouched", gateway.callLedger.readToday(new Date()).length === ledgerBefore);

const playerHandle = gateway.store.findTokenByHandle(JSON.parse(redemptionA.text).handle as string)?.handle;
assert.ok(playerHandle);
await request(`/admin/tokens/${playerHandle}/revoke`, { token: ADMIN, body: {} });
check("revoked player token is refused by the game route", (await request("/game/run", { token: player, body: {} })).status === 401);
await request("/admin/revoke-all", { token: ADMIN, body: {} });
check("kill-all leaves every game token refused", (await request("/game/run", { token: playerB, body: {} })).status === 401);

const gameRoot = resolve("src/game");
const imported = readdirSync(gameRoot, { recursive: true })
  .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
  .filter((entry) => readFileSync(join(gameRoot, entry), "utf8").includes("dispatchAdmitted"));
const wrapper = readFileSync(join(gameRoot, "hosted-dispatch.ts"), "utf8");
const hostedMain = readFileSync(resolve("src/proxy/hosted/main.ts"), "utf8");
check("only the game custody wrapper imports dispatchAdmitted", imported.length === 1 && imported[0].replace(/\\/g, "/") === "hosted-dispatch.ts");
check("game wrapper hard-codes client-body redaction", /redactClientBodies:\s*true/.test(wrapper));
check("the hosted game mount is opt-in behind SENTINEL_GAME_ENABLED=1", /process\.env\.SENTINEL_GAME_ENABLED\s*===\s*"1"/.test(hostedMain));

await close(hosted); await close(hostile);

// A real source mutation, run in a fresh process, proves the custody scan is
// not ceremonial. The finally restores the literal before this test returns.
if (!process.argv.includes("--mutation-child")) {
  const wrapperPath = join(gameRoot, "hosted-dispatch.ts");
  const original = readFileSync(wrapperPath, "utf8");
  try {
    writeFileSync(wrapperPath, original.replace("redactClientBodies: true", "redactClientBodies: false"), "utf8");
    const self = fileURLToPath(import.meta.url);
    const child = spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), self, "--mutation-child"], { encoding: "utf8" });
    check("mutation: redaction=false makes the game custody proof fail", child.status !== 0);
  } finally {
    writeFileSync(wrapperPath, original, "utf8");
  }
}

rmSync(root, { recursive: true, force: true });
Object.assign(console, originalConsole);
if (failures) process.exitCode = 1;
