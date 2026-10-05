/**
 * HTTP surface for server-run Sneak. Mounted inside the hosted game routes,
 * so it exists only when the operator enables the game.
 *
 *   GET  /sneak/api/config   the public deck and today's prize amounts
 *   POST /sneak/api/run      { mode: "practice" | "prize" }  (prize needs a snt_ bearer token)
 *   POST /sneak/api/move     { runId, trick, kind: "probe" | "wave" }
 *
 * No route here calls a model, touches the gateway key, the free-tier pool,
 * the governor or any wallet.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readBody, sendJson } from "../../proxy/http.js";
import { userTokenHashFromHeader } from "../../proxy/hosted/secrets.js";
import { BUDGET_USD, GUARD_HEAD_START, publicTricks, SneakRun, START_LIVES, START_PROBES } from "./engine.js";
import { prizesOn, SneakPrizeLog, utcDay, type SneakPrizeConfig } from "./prizes.js";

const MAX_BODY_BYTES = 2 * 1024;
const DEFAULT_MAX_RUNS = 2_000;
const RUN_TTL_MS = 2 * 60 * 60_000;
const RUN_ID = /^[A-Za-z0-9_-]{16,64}$/;
const NO_STORE = { "cache-control": "no-store" };

/** The slice of the hosted token store this module reads. */
export interface SneakTokenStore {
  findToken(tokenHash: string): { handle: string; revokedAt: string | null } | undefined;
  config: { paused: boolean };
}

export interface SneakRoutesOptions {
  store: SneakTokenStore;
  logPath: string;
  prizes: SneakPrizeConfig;
  clock?: () => number;
  maxRuns?: number;
  /** Test-only seam: fix the guard's secret. Production draws it with crypto. */
  drawSecret?: () => string[];
}

export interface SneakRoutes {
  handle(req: IncomingMessage, res: ServerResponse, url: string, method: string): Promise<boolean>;
}

interface Live { run: SneakRun; mode: "practice" | "prize"; player: string | null; day: string; createdAt: number }

const fail = (res: ServerResponse, status: number, code: string, message: string) => sendJson(res, status, { error: { code, message } }, NO_STORE);

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await readBody(req, MAX_BODY_BYTES)).toString("utf8");
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export function createSneakRoutes(options: SneakRoutesOptions): SneakRoutes {
  const clock = options.clock ?? Date.now;
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const log = new SneakPrizeLog(options.logPath);
  const runs = new Map<string, Live>();
  const prizes = options.prizes;

  const player = (req: IncomingMessage): string | null => {
    const hash = userTokenHashFromHeader(req.headers.authorization);
    const token = hash ? options.store.findToken(hash) : undefined;
    return token && !token.revokedAt ? token.handle : null;
  };
  const sweep = (now: number) => { for (const [id, r] of runs) if (now - r.createdAt > RUN_TTL_MS) runs.delete(id); };
  const prizeView = () => ({ flawlessUsd: prizes.flawlessUsd, oneLifeLostUsd: prizes.oneLifeLostUsd, on: prizesOn(prizes) });

  return {
    async handle(req, res, url, method) {
      if (!url.startsWith("/sneak/api/")) return false;
      const now = clock();

      if (url === "/sneak/api/config" && method === "GET") {
        sendJson(res, 200, { tricks: publicTricks(), budgetUsd: BUDGET_USD, lives: START_LIVES, probes: START_PROBES, guardKnows: GUARD_HEAD_START, prizes: prizeView() }, NO_STORE);
        return true;
      }

      if (url === "/sneak/api/run" && method === "POST") {
        const body = await jsonBody(req);
        const mode = body?.mode === "prize" ? "prize" : body?.mode === "practice" ? "practice" : null;
        if (!mode) { fail(res, 400, "invalid_mode", "Start a practice run or a prize run."); return true; }
        sweep(now);
        if (runs.size >= maxRuns) { fail(res, 503, "sneak_busy", "Too many runs in progress. Try again in a minute."); return true; }
        const day = utcDay(now);
        let who: string | null = null;
        if (mode === "prize") {
          who = player(req);
          if (!who) { fail(res, 401, "sneak_invalid_token", "A prize run needs a live Sentinel player token."); return true; }
          if (options.store.config.paused) { fail(res, 503, "sneak_paused", "Sentinel is paused. Prize runs are closed; practice is open."); return true; }
          if (log.usedToday(who, day)) { fail(res, 429, "sneak_prize_run_used", "This token has had its prize run today. Practice is unlimited; the next prize run opens at 00:00 UTC."); return true; }
        }
        const run = new SneakRun(options.drawSecret?.());
        const runId = randomBytes(18).toString("base64url");
        if (mode === "prize" && !log.start(who as string, day, runId, run.commitment)) { fail(res, 429, "sneak_prize_run_used", "This token has had its prize run today."); return true; }
        runs.set(runId, { run, mode, player: who, day, createdAt: now });
        sendJson(res, 201, { runId, mode, commitment: run.commitment, state: run.snapshot(), prizes: mode === "prize" ? prizeView() : null }, NO_STORE);
        return true;
      }

      if (url === "/sneak/api/move" && method === "POST") {
        const body = await jsonBody(req);
        const runId = typeof body?.runId === "string" && RUN_ID.test(body.runId) ? body.runId : null;
        const live = runId ? runs.get(runId) : undefined;
        if (!live) { fail(res, 404, "sneak_run_not_found", "No run with that id is in progress."); return true; }
        if (live.mode === "prize" && player(req) !== live.player) { fail(res, 403, "sneak_not_your_run", "Only the token that started this prize run can play it."); return true; }
        // Synchronous from here to the response: two moves on one run cannot interleave.
        const result = live.run.move(body?.kind, body?.trick);
        if (!result.ok) { fail(res, result.code === "bad_kind" || result.code === "unknown_trick" ? 400 : 409, result.code, "That move was not accepted."); return true; }
        let prize = null;
        if (result.kind === "wave" && result.end && live.mode === "prize") prize = log.finish(live.player as string, live.day, runId as string, result.end, prizes);
        if (live.run.over) runs.delete(runId as string);
        sendJson(res, 200, { ...result, prize }, NO_STORE);
        return true;
      }

      fail(res, 404, "not_found", "No such Sneak route.");
      return true;
    }
  };
}
