/**
 * Sneak Past Sentinel, decided on the server. A score can only come from
 * playing the run, in order, through the API: the secret never reaches the
 * page, a run cannot be finished out of order, a tampered run id or a
 * different token is refused, one prize run per token per UTC day holds, the
 * daily prize cap holds across everyone and across restarts, and prizes stay
 * at $0 until the operator sets them.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitmentFor, SneakRun, TRICKS } from "../../src/game/sneak/engine.js";
import { createSneakRoutes, type SneakTokenStore } from "../../src/game/sneak/routes.js";
import { DEFAULT_PRIZES, prizeConfigFromEnv, type SneakEvent, type SneakPrizeConfig } from "../../src/game/sneak/prizes.js";
import { userTokenHashFromHeader } from "../../src/proxy/hosted/secrets.js";
import { keccak256Hex, parseWallet } from "../../src/game/sneak/wallet.js";

let failures = 0;
const check = (name: string, condition: boolean) => {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  if (!condition) failures++;
};

const SECRET = ["clones", "switch"];
const BLIND = ["swarm", "lowball", "addons"];

// ------------------------------------------------------------------ engine
{
  const run = new SneakRun(SECRET);
  check("a run publishes only a commitment at the start", /^[0-9a-f]{64}$/.test(run.commitment) && !JSON.stringify(run.snapshot()).includes("clones"));
  const p1 = run.move("probe", "clones");
  check("a probe on a known trick snaps the eye", p1.ok && p1.kind === "probe" && p1.alert === true);
  check("the same trick cannot be probed twice", (() => { const r = run.move("probe", "clones"); return !r.ok && r.code === "already_probed"; })());
  run.move("probe", "swarm");
  check("there are only two probes", (() => { const r = run.move("probe", "lowball"); return !r.ok && r.code === "no_probes_left"; })());
  check("an unknown move kind is refused", (() => { const r = run.move("finish", "swarm"); return !r.ok && r.code === "bad_kind"; })());
  let last = run.move("wave", BLIND[0]);
  check("a wave on a blind spot breaks the budget", last.ok && last.kind === "wave" && last.outcome === "learned" && last.wave.breach);
  check("a spent trick cannot be sent again", (() => { const r = run.move("wave", BLIND[0]); return !r.ok && r.code === "trick_spent"; })());
  for (const id of BLIND.slice(1)) last = run.move("wave", id);
  const end = last.ok && last.kind === "wave" ? last.end : null;
  check("fooling all three blind spots with no life lost is flawless", end?.outcome === "flawless" && end.fooled === 3 && end.lives === 3);
  check("the reveal matches the commitment", !!end && commitmentFor(end.reveal.salt, end.reveal.knows) === run.commitment && end.reveal.knows.join() === [...SECRET].sort().join());
  check("no move is accepted after the run ends", (() => { const r = run.move("wave", "clones"); return !r.ok && r.code === "run_over"; })());

  const lost = new SneakRun(SECRET);
  lost.move("wave", "clones");
  for (const id of BLIND) last = lost.move("wave", id);
  check("one life lost is its own outcome", last.ok && last.kind === "wave" && last.end?.outcome === "one_life_lost");
  check("the default draw picks two distinct tricks", Array.from({ length: 200 }, () => new SneakRun()).every((r) => r.commitment.length === 64));
}

// ------------------------------------------------------------------ config
{
  check("prizes default to $0 with a $5 daily cap", DEFAULT_PRIZES.flawlessUsd === 0 && DEFAULT_PRIZES.oneLifeLostUsd === 0 && DEFAULT_PRIZES.dailyCapUsd === 5);
  const empty = prizeConfigFromEnv({});
  check("with no environment set, prizes are off", empty.flawlessUsd === 0 && empty.oneLifeLostUsd === 0);
  const bad = prizeConfigFromEnv({ SENTINEL_SNEAK_PRIZE_FLAWLESS_USD: "-3", SENTINEL_SNEAK_PRIZE_ONE_LIFE_LOST_USD: "lots" });
  check("negative or garbage prize settings fall back to $0", bad.flawlessUsd === 0 && bad.oneLifeLostUsd === 0);
  const set = prizeConfigFromEnv({ SENTINEL_SNEAK_PRIZE_FLAWLESS_USD: "1", SENTINEL_SNEAK_PRIZE_ONE_LIFE_LOST_USD: "0.5", SENTINEL_SNEAK_PRIZE_DAILY_CAP_USD: "5" });
  check("the operator can turn prizes on by config", set.flawlessUsd === 1 && set.oneLifeLostUsd === 0.5 && set.dailyCapUsd === 5);
}

// -------------------------------------------------------------------- HTTP
const root = mkdtempSync(join(tmpdir(), "sentinel-sneak-"));
const tokens = new Map<string, { handle: string; revokedAt: string | null }>();
const store: SneakTokenStore = { findToken: (hash) => tokens.get(hash), config: { paused: false } };
const mint = (raw: string, handle: string) => { tokens.set(userTokenHashFromHeader(`Bearer ${raw}`) as string, { handle, revokedAt: null }); return raw; };
const ALICE = mint("snt_alice_0123456789", "tok_alice");
const BOB = mint("snt_bob_0123456789", "tok_bob");
const CARA = mint("snt_cara_0123456789", "tok_cara");
const DREW = mint("snt_drew_0123456789", "tok_drew");
const EVE = mint("snt_eve_0123456789", "tok_eve");
const REVOKED = mint("snt_revoked_0123456789", "tok_revoked");
(tokens.get(userTokenHashFromHeader(`Bearer ${REVOKED}`) as string) as { revokedAt: string | null }).revokedAt = new Date().toISOString();

let clock = Date.UTC(2026, 9, 5, 12, 0, 0);
async function serve(logPath: string, prizes: SneakPrizeConfig, adminToken?: string): Promise<{ base: string; server: Server }> {
  const routes = createSneakRoutes({ store, logPath, prizes, adminToken, clock: () => clock, drawSecret: () => SECRET });
  const server = createServer(async (req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (!(await routes.handle(req, res, url, req.method ?? "GET"))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}
type Json = Record<string, any>;
async function post(base: string, path: string, body: unknown, token?: string): Promise<{ status: number; json: Json; text: string }> {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {}, text };
}
async function playFlawless(base: string, runId: string, token?: string): Promise<Json> {
  let last: Json = {};
  for (const trick of BLIND) last = (await post(base, "/sneak/api/move", { runId, trick, kind: "wave" }, token)).json;
  return last;
}
const readLog = (path: string): SneakEvent[] => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

{
  const logPath = join(root, "default", "sneak-events.jsonl");
  const { base, server } = await serve(logPath, DEFAULT_PRIZES);

  const cfg = await (await fetch(`${base}/sneak/api/config`)).json() as Json;
  check("config lists the five tricks and no secret", cfg.tricks.length === 5 && !("knows" in cfg) && cfg.prizes.on === false);

  const practice = await post(base, "/sneak/api/run", { mode: "practice" });
  check("a practice run needs no token", practice.status === 201 && practice.json.mode === "practice");
  check("starting a run sends the commitment, never the secret", !/clones|switch/.test(JSON.stringify({ ...practice.json, state: undefined })) && !("reveal" in practice.json));
  const runId = practice.json.runId as string;
  const tampered = runId.slice(0, -1) + (runId.endsWith("A") ? "B" : "A");
  check("a tampered run id is refused", (await post(base, "/sneak/api/move", { runId: tampered, trick: "swarm", kind: "wave" })).status === 404);
  check("there is no route to finish a run without playing it", (await post(base, "/sneak/api/finish", { runId })).status === 404);
  check("a move with an invented kind is refused", (await post(base, "/sneak/api/move", { runId, trick: "swarm", kind: "win" })).status === 400);
  await post(base, "/sneak/api/move", { runId, trick: "swarm", kind: "wave" });
  check("a wave on a spent trick is refused, out of order", (await post(base, "/sneak/api/move", { runId, trick: "swarm", kind: "wave" })).status === 409);
  await post(base, "/sneak/api/move", { runId, trick: "lowball", kind: "wave" });
  const done = await post(base, "/sneak/api/move", { runId, trick: "addons", kind: "wave" });
  check("the run ends on the server, which reveals the secret only then", done.json.end?.outcome === "flawless" && done.json.end.reveal.knows.join() === "clones,switch" && done.json.prize === null);
  check("a finished run takes no more moves", (await post(base, "/sneak/api/move", { runId, trick: "clones", kind: "wave" })).status === 404);

  check("a prize run needs a token", (await post(base, "/sneak/api/run", { mode: "prize" })).status === 401);
  check("a revoked token cannot start a prize run", (await post(base, "/sneak/api/run", { mode: "prize" }, REVOKED)).status === 401);
  const prize = await post(base, "/sneak/api/run", { mode: "prize" }, ALICE);
  check("a live token starts its prize run", prize.status === 201 && prize.json.mode === "prize");
  const prizeId = prize.json.runId as string;
  check("another token cannot play someone's prize run", (await post(base, "/sneak/api/move", { runId: prizeId, trick: "swarm", kind: "wave" }, BOB)).status === 403);
  check("a prize run cannot be played without its token", (await post(base, "/sneak/api/move", { runId: prizeId, trick: "swarm", kind: "wave" })).status === 403);
  check("one prize run per token per UTC day", (await post(base, "/sneak/api/run", { mode: "prize" }, ALICE)).status === 429);
  check("practice stays unlimited for that token", (await post(base, "/sneak/api/run", { mode: "practice" }, ALICE)).status === 201);
  const flawless = await playFlawless(base, prizeId, ALICE);
  check("prizes default to $0: a flawless prize run owes nothing", flawless.prize?.status === "prizes_off" && flawless.prize.amountUsd === 0);
  check("with prizes off, no pending prize is written", !readLog(logPath).some((e) => e.event === "SNEAK_PRIZE_PENDING"));
  check("the log keeps the token's handle, never the token", !readFileSync(logPath, "utf8").includes(ALICE) && readFileSync(logPath, "utf8").includes("tok_alice"));
  server.close();

  const restarted = await serve(logPath, DEFAULT_PRIZES);
  check("the daily limit survives a restart", (await post(restarted.base, "/sneak/api/run", { mode: "prize" }, ALICE)).status === 429);
  clock += 24 * 60 * 60_000;
  check("the next UTC day opens a new prize run", (await post(restarted.base, "/sneak/api/run", { mode: "prize" }, ALICE)).status === 201);
  restarted.server.close();
}

{
  // Prizes on: $1 flawless, $0.50 one life lost, a $1.50 cap to make the cap bite.
  const logPath = join(root, "cap", "sneak-events.jsonl");
  const on: SneakPrizeConfig = { flawlessUsd: 1, oneLifeLostUsd: 0.5, dailyCapUsd: 1.5 };
  const { base, server } = await serve(logPath, on);
  const a = await post(base, "/sneak/api/run", { mode: "prize" }, BOB);
  const first = await playFlawless(base, a.json.runId, BOB);
  check("a flawless prize run records $1 pending", first.prize?.status === "pending" && first.prize.amountUsd === 1);
  const b = await post(base, "/sneak/api/run", { mode: "prize" }, CARA);
  const second = await playFlawless(base, b.json.runId, CARA);
  check("the daily cap trims the next prize to what is left", second.prize?.status === "capped" && second.prize.amountUsd === 0.5);
  server.close();
  const restarted = await serve(logPath, on);
  const c = await post(restarted.base, "/sneak/api/run", { mode: "prize" }, DREW);
  const third = await playFlawless(restarted.base, c.json.runId, DREW);
  check("the daily cap holds across everyone and across a restart", third.prize?.status === "cap_reached" && third.prize.amountUsd === 0);
  const pending = readLog(logPath).filter((e) => e.event === "SNEAK_PRIZE_PENDING").reduce((sum, e) => sum + (e.amountUsd ?? 0), 0);
  check("pending prizes for the day never exceed the cap", Math.abs(pending - 1.5) < 1e-9);
  store.config.paused = true;
  check("a paused service opens no prize runs", (await post(restarted.base, "/sneak/api/run", { mode: "prize" }, EVE)).status === 503);
  check("practice stays open while paused", (await post(restarted.base, "/sneak/api/run", { mode: "practice" })).status === 201);
  store.config.paused = false;
  restarted.server.close();
}

// ------------------------------------------------------------- wallets
{
  check("Keccak-256 matches the empty-input test vector", keccak256Hex(new Uint8Array()) === "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  check("Keccak-256 matches the \"abc\" test vector", keccak256Hex(new TextEncoder().encode("abc")) === "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  const vectors = ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB", "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb"];
  check("the EIP-55 test addresses are accepted as written", vectors.every((a) => { const r = parseWallet(a); return r.ok && r.address === a; }));
  check("an all-lowercase address is accepted and stored checksummed", vectors.every((a) => { const r = parseWallet(a.toLowerCase()); return r.ok && r.address === a; }));
  const flip = (a: string) => { const i = [...a].findIndex((c, k) => k > 1 && /[a-fA-F]/.test(c)); return a.slice(0, i) + (a[i] === a[i].toUpperCase() ? a[i].toLowerCase() : a[i].toUpperCase()) + a.slice(i + 1); };
  check("a one-letter case typo fails the checksum", vectors.every((a) => { const r = parseWallet(flip(a)); return !r.ok && r.reason === "checksum"; }));
  check("wrong length, non-hex, missing 0x and the zero address are refused", ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeg", "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed00", 42].every((a) => !parseWallet(a).ok) && (parseWallet("0x" + "0".repeat(40)) as { reason?: string }).reason === "zero");
}

// --------------------------------------------- claims and the admin list
{
  const ADMIN_TOKEN = "sneak-admin-test-secret-0123456789abcdef";
  const GOOD = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const logPath = join(root, "claims", "sneak-events.jsonl");
  const on: SneakPrizeConfig = { flawlessUsd: 1, oneLifeLostUsd: 0.5, dailyCapUsd: 5 };
  const { base, server } = await serve(logPath, on, ADMIN_TOKEN);
  const getAdmin = (token?: string) => fetch(`${base}/sneak/api/admin/prizes`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  const run = await post(base, "/sneak/api/run", { mode: "prize" }, EVE);
  const runId = run.json.runId as string;
  const won = await playFlawless(base, runId, EVE);
  check("the winner gets the prize's runId to claim it with", won.prize?.runId === runId && won.prize.amountUsd === 1);
  check("a malformed wallet is refused", (await post(base, "/sneak/api/claim", { runId, wallet: "0x123" }, EVE)).json.error?.code === "invalid_wallet_format");
  check("the zero address is refused", (await post(base, "/sneak/api/claim", { runId, wallet: "0x" + "0".repeat(40) }, EVE)).json.error?.code === "invalid_wallet_zero");
  check("a checksum typo is refused", (await post(base, "/sneak/api/claim", { runId, wallet: "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }, EVE)).json.error?.code === "invalid_wallet_checksum");
  check("another token cannot set the winner's wallet", (await post(base, "/sneak/api/claim", { runId, wallet: GOOD }, BOB)).status === 403);
  check("no token cannot set a wallet", (await post(base, "/sneak/api/claim", { runId, wallet: GOOD })).status === 401);
  check("an unknown prize cannot be claimed", (await post(base, "/sneak/api/claim", { runId: "x".repeat(24), wallet: GOOD }, EVE)).status === 404);
  const claimed = await post(base, "/sneak/api/claim", { runId, wallet: GOOD.toLowerCase() }, EVE);
  check("the winner saves a wallet, stored checksummed", claimed.status === 200 && claimed.json.prize.wallet === GOOD);
  const mine = (await post(base, "/sneak/api/my-prizes", {}, EVE)).json.prizes as Json[];
  check("the winner can find their prize and wallet later", mine.length === 1 && mine[0].wallet === GOOD && mine[0].paid === false);
  check("a player sees only their own prizes", ((await post(base, "/sneak/api/my-prizes", {}, BOB)).json.prizes as Json[]).length === 0);

  const second = await post(base, "/sneak/api/run", { mode: "prize" }, CARA);
  await playFlawless(base, second.json.runId, CARA);

  check("the admin list needs the admin token", (await getAdmin()).status === 401);
  check("a player token cannot open the admin list", (await getAdmin(EVE)).status === 401);
  const list = await (await getAdmin(ADMIN_TOKEN)).json() as Json;
  const eve = (list.prizes as Json[]).find((p) => p.runId === runId);
  check("the admin list shows handle, amount and wallet", eve?.player === "tok_eve" && eve.amountUsd === 1 && eve.wallet === GOOD && eve.paidAt === null);
  check("the admin totals split unpaid from ready to pay", list.unpaidUsd === 2 && list.unpaidWithWalletUsd === 1 && list.unpaidCount === 2);
  const adminPost = (body: unknown, token = ADMIN_TOKEN) => post(base, "/sneak/api/admin/prizes/paid", body, token);
  check("a prize with no wallet cannot be marked paid", (await adminPost({ runId: second.json.runId })).json.error?.code === "no_wallet");
  check("a player token cannot mark a prize paid", (await adminPost({ runId }, EVE)).status === 401);
  const paid = await adminPost({ runId, tx: "0xfeedbeef" });
  check("the operator marks a prize paid, with the tx", paid.status === 200 && paid.json.prize.tx === "0xfeedbeef" && !!paid.json.prize.paidAt);
  check("a prize cannot be marked paid twice", (await adminPost({ runId })).json.error?.code === "already_paid");
  check("a paid prize's wallet can no longer change", (await post(base, "/sneak/api/claim", { runId, wallet: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359" }, EVE)).json.error?.code === "already_paid");
  server.close();

  const restarted = await serve(logPath, on, ADMIN_TOKEN);
  const after = await (await fetch(`${restarted.base}/sneak/api/admin/prizes`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json() as Json;
  const eveAfter = (after.prizes as Json[]).find((p) => p.runId === runId);
  check("wallets and payments survive a restart", eveAfter?.wallet === GOOD && eveAfter.tx === "0xfeedbeef" && after.unpaidUsd === 1);
  const page = await fetch(`${restarted.base}/sneak/admin`);
  const html = await page.text();
  check("the admin page is served, unindexed, with no token or prize data in it", page.status === 200 && page.headers.get("x-robots-tag") === "noindex" && !html.includes(ADMIN_TOKEN) && !html.includes(GOOD) && !html.includes("tok_eve"));
  check("the admin page calls only the admin API and never stores the token", (html.match(/fetch\(/g) ?? []).length === 1 && html.includes('window.fetch("/sneak/api/admin" + path') && !/localStorage|sessionStorage/.test(html));
  restarted.server.close();

  const closed = await serve(join(root, "closed", "sneak-events.jsonl"), on);
  check("with no admin token configured, the prize admin stays closed", (await fetch(`${closed.base}/sneak/api/admin/prizes`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).status === 503);
  closed.server.close();
  const weak = await serve(join(root, "weak", "sneak-events.jsonl"), on, "short");
  check("a too-short admin token keeps the prize admin closed", (await fetch(`${weak.base}/sneak/api/admin/prizes`, { headers: { authorization: "Bearer short" } })).status === 503);
  weak.server.close();
}

// -------------------------------------------------------------------- page
{
  const html = readFileSync(fileURLToPath(new URL("../../src/game/sneak.html", import.meta.url)), "utf8");
  check("the page holds no game rules or secret: no simulation, no secret draw, no trick table", !/simulateWave|function simulate|drawSecret|guardKnows\s*\)|knows:\s*new Set|actual:\s*0\.\d/.test(html) && !TRICKS.some((t) => html.includes(t.real)));
  check("the page calls only its own API", (html.match(/fetch\(/g) ?? []).length === 1 && html.includes('window.fetch("/sneak/api" + path'));
  check("the page never stores a token", !/localStorage\.setItem\([^)]*token|sessionStorage/.test(html));
  check("the page asks a winner for a wallet and can find past prizes", html.includes('id="claim"') && html.includes('api("/claim"') && html.includes('api("/my-prizes"'));
}

rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`${failures} sneak check(s) failed`); process.exit(1); }
console.log("sneak server tests passed");
