/**
 * The desk: server-run table rounds refereed by the real BudgetGovernor.
 * Every claim the page makes is checked here against the engine and the HTTP
 * surface: the books balance, a hold that does not fit is a 402, the unspent
 * part of a hold returns, nothing secret leaves the server early, and only a
 * seated player can lock their seat.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUY_IN_USD, DeskRound, JOB, SIT_TIMING, WATCH_TIMING, worstCaseFor, type Policy } from "../../src/game/desk/engine.js";
import { createDeskRoutes } from "../../src/game/desk/routes.js";

let failures = 0;
const check = (name: string, condition: boolean) => {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  if (!condition) failures++;
};
const close = (a: number, b: number) => Math.abs(a - b) < 1e-8;

/** Run a round to the end on a fake clock, sampling views along the way. */
async function playOut(round: DeskRound, start: number, onView?: (now: number) => void): Promise<number> {
  let now = start;
  for (let i = 0; i < 400 && round.doneAt === null; i++) {
    now += 500;
    await round.advance(now);
    onView?.(now);
  }
  return now;
}

// ---------------------------------------------------------------- the books
{
  let balanced = true, potBounded = true, winnerRight = true, seedOk = true, linesInTime = true, hiddenOk = true, needHidden = true, sawRefuse = false, sawWinner = false, sawNoWinner = false;
  for (let n = 0; n < 150; n++) {
    const t0 = 1_000_000;
    const round = new DeskRound("watch", WATCH_TIMING, t0, { seed: `books-${n}` });
    await playOut(round, t0, (now) => {
      const v = round.view(now, null, null);
      if (v.lines.some((l) => l.at > now)) linesInTime = false;
      if (v.seed !== null && v.phase !== "done") seedOk = false;
      if (v.phase === "lock" && v.step !== null) {
        // Another seat's policy for the open step is never shown while seats lock.
        if (v.seats.some((s) => s.policies[v.step as number] !== null)) hiddenOk = false;
        if (v.job.steps[v.step].needTokens !== null) needHidden = false;
      }
    });
    const end = (round.doneAt as number) + 1;
    const v = round.view(end, null, null);
    const books = round.books();
    if (!close(books.buyInsUsd, books.spentUsd + (books.potUsd as number))) balanced = false;
    if ((books.potUsd as number) > books.buyInsUsd + 1e-9 || (books.potUsd as number) < 0) potBounded = false;
    if (v.seed === null || createHash("sha256").update(v.seed).digest("hex") !== v.seedHash) seedOk = false;
    if (v.lines.some((l) => l.kind === "refuse")) sawRefuse = true;
    if (v.winner) {
      sawWinner = true;
      const finished = v.seats.filter((s) => s.status === "finished");
      const w = v.seats.find((s) => s.id === v.winner);
      if (!w || w.status !== "finished" || finished.some((s) => s.stackUsd > w.stackUsd + 1e-12)) winnerRight = false;
    } else {
      sawNoWinner = true;
      if (v.seats.some((s) => s.status === "finished")) winnerRight = false;
    }
  }
  check("books balance in 150 rounds: buy-ins = spent on calls + pot", balanced);
  check("the pot is never more than the buy-ins, never negative", potBounded);
  check("the winner finished the job and has the most left of any finisher", winnerRight);
  check("the seed stays sealed until the round closes and matches the published hash", seedOk);
  check("no ledger line is shown before its time", linesInTime);
  check("no seat's policy is shown while the step is still locking", hiddenOk);
  check("a step's real answer length stays hidden until the step runs", needHidden);
  check("the house plays rounds with a public 402 in them", sawRefuse);
  check("rounds end both with and without a winner", sawWinner && sawNoWinner);
}

// --------------------------------------------- a hold that does not fit is a 402
{
  const t0 = 2_000_000;
  const round = new DeskRound("sit", SIT_TIMING, t0, { seed: "refuse" });
  const seat = round.seatForSecret(round.playerSecret() as string) as string;
  const open = t0 + SIT_TIMING.introMs;
  await round.advance(open);
  const greedy: Policy = { route: "strong", maxTokens: 2048, burst: true };
  check("positive control: a strong burst at 2048 tokens needs more than the buy-in", worstCaseFor(greedy, JOB.steps[0]) > BUY_IN_USD);
  const locked = await round.lock(seat, 0, greedy, open + 100);
  check("the player can lock the open step", locked.ok);
  const again = await round.lock(seat, 0, { route: "cheap", maxTokens: 512, burst: false }, open + 200);
  check("a locked policy cannot be changed", !again.ok && again.code === "already_locked");
  const end = await playOut(round, open + 200);
  const v = round.view(end + 1, seat, null);
  const me = v.seats.find((s) => s.id === seat);
  check("the seat is out", me?.status === "out");
  check("the ledger shows the 402 with what Sentinel needed to hold", v.lines.some((l) => l.kind === "refuse" && l.seat === seat && l.text.startsWith("402") && l.text.includes(`$${worstCaseFor(greedy, JOB.steps[0]).toFixed(4)}`)));
  check("a refused burst sends nothing: the whole stack is still there", close(me?.stackUsd ?? 0, BUY_IN_USD));
  check("an out seat's stack stays on the table for the winner", close(round.books().spentUsd + (round.books().potUsd as number), BUY_IN_USD * 4));
}

// ----------------------------------------- the unspent part of a hold returns
{
  const t0 = 3_000_000;
  const round = new DeskRound("sit", SIT_TIMING, t0, { seed: "refund" });
  const seat = round.seatForSecret(round.playerSecret() as string) as string;
  const open = t0 + SIT_TIMING.introMs;
  await round.advance(open);
  const careful: Policy = { route: "strong", maxTokens: 2048, burst: false };
  const hold = worstCaseFor(careful, JOB.steps[0]);
  await round.lock(seat, 0, careful, open + 50);
  // Step one has resolved once every seat has locked; read the view after its lines are out.
  let now = open + 50;
  for (let i = 0; i < 60; i++) { now += 500; await round.advance(now); if (round.view(now, seat, null).lines.some((l) => l.kind === "bill" && l.seat === seat)) break; }
  const v = round.view(now, seat, null);
  const me = v.seats.find((s) => s.id === seat);
  const billLine = v.lines.find((l) => l.kind === "bill" && l.seat === seat)?.text ?? "";
  const billed = Number(/billed \$([0-9]+\.[0-9]+)/.exec(billLine)?.[1]);
  check("the hold was the governor's worst case for the locked policy", v.lines.some((l) => l.kind === "hold" && l.seat === seat && l.text.includes(`$${hold.toFixed(4)}`)));
  check("the bill is less than the hold", billed > 0 && billed < hold);
  check("the stack is the buy-in minus the bill, not minus the hold", Math.abs((me?.stackUsd ?? 0) - (BUY_IN_USD - billed)) < 0.00006);
  check("your own locked policy is shown to you", JSON.stringify(me?.policies[0]) === JSON.stringify(careful));
}

// ------------------------------------------ a missed window locks the default
{
  const t0 = 4_000_000;
  const round = new DeskRound("sit", SIT_TIMING, t0, { seed: "default" });
  const seat = round.seatForSecret(round.playerSecret() as string) as string;
  const late = t0 + SIT_TIMING.introMs + SIT_TIMING.lockMs + 1;
  await round.advance(late);
  const tooLate = await round.lock(seat, 0, { route: "strong", maxTokens: 1024, burst: false }, late);
  check("a lock after the window closes is refused", !tooLate.ok && tooLate.code === "lock_window_closed");
  const v = round.view(late + SIT_TIMING.runMs, seat, null);
  check("the desk locked its default and says so", v.lines.some((l) => l.seat === seat && l.text.includes("didn't lock in time")));
}

// ------------------------------------------------------------ HTTP surface
async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}
{
  let clock = 5_000_000;
  const desk = createDeskRoutes({ clock: () => clock, maxRounds: 3 });
  const server = createServer(async (req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (!(await desk.handle(req, res, url, req.method ?? "GET"))) { res.writeHead(404); res.end(); }
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  const page = await fetch(`${base}/desk`);
  const html = await page.text();
  check("GET /desk serves the table page", page.status === 200 && html.includes("Watch a round") && html.includes("Take a seat"));
  check("the page loads nothing from another origin and calls only its own API", !/<link[^>]+href=["']https?:|src=["']https?:|@import|XMLHttpRequest|WebSocket/i.test(html) && (html.match(/fetch\(/g) ?? []).length === (html.match(/window\.fetch\(API \+ path/g) ?? []).length);

  const live1 = await (await fetch(`${base}/desk/api/live`)).json() as { id: string; mode: string; seats: Array<{ id: string }>; seed: string | null; pickOpen: boolean };
  check("the live table is a house round anyone can watch", live1.mode === "watch" && live1.seats.length === 4 && live1.seed === null && live1.pickOpen);
  const viewer = "viewer-0001";
  const p1 = await post("/desk/api/live/pick", { round: live1.id, seat: live1.seats[2].id, viewer });
  const picked = await p1.json() as { yourPick?: string; picks: Record<string, number> };
  check("a spectator's pick is recorded and moves nothing", p1.status === 200 && picked.yourPick === live1.seats[2].id && picked.picks[live1.seats[2].id] === 1);
  const p2 = await post("/desk/api/live/pick", { round: live1.id, seat: live1.seats[0].id, viewer });
  check("one pick per viewer", p2.status === 409);
  clock += WATCH_TIMING.introMs + WATCH_TIMING.lockMs + 1;
  const p3 = await post("/desk/api/live/pick", { round: live1.id, seat: live1.seats[0].id, viewer: "viewer-0002" });
  check("picks close once the first step runs", p3.status === 409);

  const sit = await post("/desk/api/sit", {});
  const seated = await sit.json() as { seat: string; secret: string; round: { id: string; seats: Array<{ id: string; you: boolean }> } };
  check("taking a seat is free and returns the seat's secret once", sit.status === 201 && typeof seated.secret === "string" && seated.round.seats.some((s) => s.you && s.id === seated.seat));
  const anon = await (await fetch(`${base}/desk/api/rounds/${seated.round.id}`)).json() as { seats: Array<{ you: boolean }> };
  check("without the secret, nobody is shown as you", anon.seats.every((s) => !s.you));
  clock += SIT_TIMING.introMs + 1;
  const policy = { route: "cheap", maxTokens: 1024, burst: false };
  const noSecret = await post(`/desk/api/rounds/${seated.round.id}/lock`, { step: 0, policy });
  check("a lock without the seat's secret is refused", noSecret.status === 403);
  const other = await (await post("/desk/api/sit", {})).json() as { secret: string };
  const wrongSeat = await post(`/desk/api/rounds/${seated.round.id}/lock`, { step: 0, policy }, { "x-desk-seat": other.secret });
  check("another table's secret cannot lock this seat", wrongSeat.status === 403);
  const bad = await post(`/desk/api/rounds/${seated.round.id}/lock`, { step: 0, policy: { route: "cheap", maxTokens: 999, burst: false } }, { "x-desk-seat": seated.secret });
  check("only listed max-token sizes are accepted", bad.status === 400);
  const good = await post(`/desk/api/rounds/${seated.round.id}/lock`, { step: 0, policy }, { "x-desk-seat": seated.secret });
  check("the seated player locks with their secret", good.status === 200);
  await post("/desk/api/sit", {});
  const full = await post("/desk/api/sit", {});
  check("private tables are capped; the next seat waits", full.status === 503);
  check("an unknown desk path is a 404", (await fetch(`${base}/desk/api/nope`)).status === 404);
  server.close();
}

// The page and the mounted copy are the same file the hosted game serves.
check("the desk page ships next to its routes", readFileSync(fileURLToPath(new URL("../../src/game/desk/desk.html", import.meta.url)), "utf8").includes("<title>The Desk</title>"));

if (failures) { console.error(`${failures} desk check(s) failed`); process.exit(1); }
console.log("desk tests passed");
