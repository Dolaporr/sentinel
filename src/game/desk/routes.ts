/**
 * HTTP surface for the desk. Mounted inside the hosted game routes, so it
 * exists only when the operator enables the game.
 *
 * Every round runs here, on the server: the page only renders the public view
 * and sends a sitting player's locks. There is one shared live round that
 * anyone can watch and pick a seat on, and private rounds for players who
 * take a seat. Play credit only: no route here touches the gateway key, the
 * free-tier pool, a player token or any real credit.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readBody, sendJson } from "../../proxy/http.js";
import { DeskRound, parsePolicy, SIT_TIMING, WATCH_TIMING, type Timing } from "./engine.js";

const PAGE_PATH = fileURLToPath(new URL("./desk.html", import.meta.url));
const MAX_BODY_BYTES = 2 * 1024;
/** Private rounds in memory at once. Each is small; the cap bounds an anonymous flood. */
const DEFAULT_MAX_ROUNDS = 200;
const KEEP_DONE_MS = 5 * 60_000;
const MAX_AGE_MS = 20 * 60_000;
/** How long a finished live round stays on screen before the next one deals. */
const LIVE_HOLD_MS = 15_000;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface DeskRoutesOptions {
  clock?: () => number;
  watchTiming?: Timing;
  sitTiming?: Timing;
  maxRounds?: number;
}

export interface DeskRoutes {
  handle(req: IncomingMessage, res: ServerResponse, url: string, method: string): Promise<boolean>;
  /** Test seam: the current live round, if one has been dealt. */
  liveRound(): DeskRound | null;
  round(id: string): DeskRound | undefined;
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const NO_STORE = { "cache-control": "no-store" };

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && ID.test(s) ? s : undefined;
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await readBody(req, MAX_BODY_BYTES)).toString("utf8");
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

const fail = (res: ServerResponse, status: number, code: string, message: string) => sendJson(res, status, { error: { code, message } }, NO_STORE);

export function createDeskRoutes(options: DeskRoutesOptions = {}): DeskRoutes {
  const clock = options.clock ?? Date.now;
  const watchTiming = options.watchTiming ?? WATCH_TIMING;
  const sitTiming = options.sitTiming ?? SIT_TIMING;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  // Read once at mount. A static page: nothing about any round is templated into it.
  const page = readFileSync(PAGE_PATH, "utf8");
  const rounds = new Map<string, DeskRound>();
  let live: DeskRound | null = null;

  const sweep = (now: number) => {
    for (const [id, r] of rounds) {
      if ((r.doneAt !== null && now - r.doneAt > KEEP_DONE_MS) || now - r.createdAt > MAX_AGE_MS) rounds.delete(id);
    }
  };

  async function currentLive(now: number): Promise<DeskRound> {
    if (live) await live.advance(now);
    if (!live || (live.doneAt !== null && now - live.doneAt >= LIVE_HOLD_MS) || now - live.createdAt > MAX_AGE_MS) {
      live = new DeskRound("watch", watchTiming, now);
    }
    return live;
  }

  return {
    liveRound: () => live,
    round: (id) => rounds.get(id),
    async handle(req, res, url, method) {
      if (!(url === "/desk" || url === "/desk/" || url.startsWith("/desk/api/"))) return false;
      const now = clock();

      if (url === "/desk" || url === "/desk/") {
        if (method !== "GET" && method !== "HEAD") { fail(res, 405, "method_not_allowed", "Use GET."); return true; }
        res.writeHead(200, HTML_HEADERS);
        res.end(method === "HEAD" ? undefined : page);
        return true;
      }

      if (url === "/desk/api/live" && method === "GET") {
        const round = await currentLive(now);
        sendJson(res, 200, round.view(now, null, header(req, "x-desk-viewer") ?? null), NO_STORE);
        return true;
      }

      if (url === "/desk/api/live/pick" && method === "POST") {
        const body = await jsonBody(req);
        const viewer = typeof body?.viewer === "string" && ID.test(body.viewer) ? body.viewer : null;
        if (!body || !viewer || typeof body.seat !== "string" || typeof body.round !== "string") { fail(res, 400, "invalid_pick", "A pick needs round, seat and viewer."); return true; }
        const round = await currentLive(now);
        if (round.id !== body.round) { fail(res, 409, "round_changed", "That round has closed. A new one is dealing."); return true; }
        const result = await round.pick(viewer, body.seat, now);
        if (!result.ok) { fail(res, 409, result.code, "That pick was not recorded."); return true; }
        sendJson(res, 200, round.view(now, null, viewer), NO_STORE);
        return true;
      }

      if (url === "/desk/api/sit" && method === "POST") {
        sweep(now);
        if (rounds.size >= maxRounds) { fail(res, 503, "desk_full", "Every table is busy. Try again in a minute."); return true; }
        const round = new DeskRound("sit", sitTiming, now);
        rounds.set(round.id, round);
        const secret = round.playerSecret() as string;
        const seat = round.seatForSecret(secret) as string;
        sendJson(res, 201, { seat, secret, round: round.view(now, seat, null) }, NO_STORE);
        return true;
      }

      const match = /^\/desk\/api\/rounds\/([A-Za-z0-9_-]{8,64})(\/lock)?$/.exec(url);
      if (!match) { fail(res, 404, "not_found", "No such desk route."); return true; }
      const round = rounds.get(match[1]);
      if (!round) { fail(res, 404, "round_not_found", "That round has closed."); return true; }
      const seat = round.seatForSecret(header(req, "x-desk-seat"));

      if (!match[2] && method === "GET") {
        await round.advance(now);
        sendJson(res, 200, round.view(now, seat, null), NO_STORE);
        return true;
      }
      if (match[2] && method === "POST") {
        if (!seat) { fail(res, 403, "not_your_seat", "Only the player in this seat can lock it."); return true; }
        const body = await jsonBody(req);
        const policy = parsePolicy(body?.policy);
        const step = typeof body?.step === "number" && Number.isInteger(body.step) ? body.step : -1;
        if (!policy || step < 0) { fail(res, 400, "invalid_policy", "Lock a route (cheap or strong), max tokens (512, 1024 or 2048) and burst (true or false) for the open step."); return true; }
        const result = await round.lock(seat, step, policy, now);
        if (!result.ok) { fail(res, 409, result.code, "That lock was not accepted."); return true; }
        sendJson(res, 200, round.view(now, seat, null), NO_STORE);
        return true;
      }
      fail(res, 405, "method_not_allowed", "That method is not allowed here.");
      return true;
    }
  };
}
