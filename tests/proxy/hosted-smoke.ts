/**
 * Live smoke test for a deployed Sentinel hosted service: the §7 sequence,
 * in order, against the real thing.
 *
 *   npm run hosted:verify -- --url https://<host> --admin <admin-token>
 *
 * Safe to re-run:
 * - one real upstream call, and its worst case is printed -- computed with the
 *   same functions the server reserves with -- before anything is spent. It
 *   stops unless you confirm (or pass --yes), and refuses outright if the
 *   bound is over --max-spend;
 * - the cap test narrows only this run's own token (through its lifetime
 *   allocation), never the shared caps other users are on;
 * - never calls revoke-all; at the end it revokes only the token it minted,
 *   and resumes only a pause it caused;
 * - refuses to start if the service is already paused: resuming at the end
 *   would undo the operator's pause.
 *
 * Secrets (admin token, invite code, user token) are never printed. The
 * admin token can come from SENTINEL_HOSTED_ADMIN_TOKEN instead of --admin,
 * which keeps it out of shell history.
 */
import { createInterface } from "node:readline/promises";
import { worstCaseUsd } from "../../src/proxy/http.js";
import { deriveInputTokens } from "../../src/proxy/messages.js";

interface Args { url: string; admin: string; model?: string; maxSpendUsd: number; yes: boolean }

const USAGE = `npm run hosted:verify -- --url <https://host> --admin <admin-token> [--model <id>] [--max-spend <usd>] [--yes]

  --url         the hosted service base URL
  --admin       admin token (or set SENTINEL_HOSTED_ADMIN_TOKEN)
  --model       allowlisted model to use (default: the first served model)
  --max-spend   refuse to run if the spend bound exceeds this (default 0.01)
  --yes         skip the confirmation prompt (required when not on a terminal)`;

function parseArgs(argv: string[]): Args | string {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  if (argv.includes("--help")) return USAGE;
  const url = get("--url")?.replace(/\/+$/, "");
  const admin = get("--admin") ?? process.env.SENTINEL_HOSTED_ADMIN_TOKEN;
  if (!url) return `--url is required.\n\n${USAGE}`;
  if (!admin) return `--admin (or SENTINEL_HOSTED_ADMIN_TOKEN) is required.\n\n${USAGE}`;
  const maxSpendUsd = Number(get("--max-spend") ?? "0.01");
  if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0) return "--max-spend must be a positive number.";
  return { url, admin, model: get("--model"), maxSpendUsd, yes: argv.includes("--yes") };
}

const usd = (v: number) => `$${Math.abs(v) > 0 && Math.abs(v) < 0.01 ? v.toFixed(6) : v.toFixed(4)}`;

interface Reply { status: number; headers: Headers; json: any; text: string }

export async function runSmoke(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") { console.log(parsed); return parsed === USAGE ? 0 : 2; }
  const args = parsed;

  const request = async (path: string, opts: { method?: string; auth?: string; body?: unknown } = {}): Promise<Reply> => {
    const res = await fetch(`${args.url}${path}`, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...(opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* html or empty */ }
    return { status: res.status, headers: res.headers, json, text };
  };
  const admin = (path: string, body?: unknown, method?: string) => request(path, { auth: args.admin, body, method });

  let failures = 0;
  const step = (label: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
    if (!ok) failures++;
    return ok;
  };
  const abort = (why: string) => { console.log(`\n  ABORTED before spending anything: ${why}`); return 1; };

  console.log(`Sentinel hosted smoke test -- ${args.url}\n`);

  // ------------------------------------------------------------ preflight, $0
  console.log("preflight (no spend)");
  let health: Reply;
  try { health = await request("/healthz"); } catch (error) { return abort(`cannot reach ${args.url}/healthz (${error instanceof Error ? error.message : String(error)}).`); }
  if (!step("service answers /healthz", health.status === 200, `HTTP ${health.status}`)) return abort("health check failed.");
  if (health.json.status !== "ok") {
    return abort(`service status is "${health.json.status}"${health.json.paused_reason ? ` (${health.json.paused_reason})` : ""}. This test pauses and resumes the service, so it will not run against one that is already paused or unhealthy.`);
  }
  step("service is healthy and not paused", true, `provider ${health.json.provider}, cost reporting ${health.json.cost_reporting}`);

  const cfg = await admin("/admin/config");
  if (!step("admin token accepted", cfg.status === 200, `HTTP ${cfg.status}`)) return abort("admin routes refused the token.");
  const pricing = cfg.json.pricing as { reservation_safety_multiplier: number; models: Array<{ id: string; input_per_million_usd: number; output_per_million_usd: number }> } | undefined;
  if (!pricing) return abort("this deployment's /admin/config has no pricing block; it predates the smoke test. Redeploy from main.");
  const model = pricing.models.find((m) => m.id === (args.model ?? pricing.models[0]?.id));
  if (!step("an allowlisted, priced model is available", Boolean(model), model?.id ?? `none matching ${args.model ?? "(first served)"}`)) return abort("no usable model.");

  const body = { model: model!.id, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word OK." }] };
  const price = { inputPerMillionUsd: model!.input_per_million_usd, outputPerMillionUsd: model!.output_per_million_usd, verifiedAt: "" };
  const worstCase = worstCaseUsd(price, deriveInputTokens(body), body.max_tokens, pricing.reservation_safety_multiplier);
  const bound = worstCase * 2;
  const poolLeft = health.json.pool.remaining_usd as number;
  if (!step("the shared pool has room for this run", poolLeft >= worstCase, `${usd(poolLeft)} left`)) return abort("not enough pool left today.");
  if (!step(`spend bound is within --max-spend ${usd(args.maxSpendUsd)}`, bound <= args.maxSpendUsd, `bound ${usd(bound)}`)) return abort("raise --max-spend if you mean it.");

  console.log(`
  About to spend:
    ONE real call to ${model!.id} (max_tokens ${body.max_tokens}). Sentinel will reserve
    at most ${usd(worstCase)} for it; the provider bills the actual cost, which is lower.
    One more call is built to be refused before it is sent. If Sentinel wrongly
    admitted it -- the bug that step exists to catch -- it could cost up to
    another ${usd(worstCase)}. Worst case for the whole run: ${usd(bound)}.
    The service is paused for about a second near the end (every user is refused
    during it), then resumed.`);

  if (!args.yes) {
    if (!process.stdin.isTTY) return abort("not running on a terminal, so it cannot ask. Re-run with --yes to confirm the spend above.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\n  Spend at most ${usd(bound)}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") return abort("not confirmed.");
  }

  // ------------------------------------------------------------- §7 sequence
  let handle: string | null = null;
  let pausedByUs = false;
  let realCostUsd: number | null = null;
  // Early returns end the sequence; cleanup and the summary always run.
  const sequence = async (): Promise<void> => {
    console.log("\n§7 sequence");
    const inv = await admin("/admin/invites", { count: 1 });
    if (!step("1. issue an invite", inv.status === 201 && inv.json.codes?.length === 1, `HTTP ${inv.status}`)) return;

    const red = await request("/v1/redeem", { body: { code: inv.json.codes[0] } });
    const token: string = red.json?.token ?? "";
    handle = red.json?.handle ?? null;
    if (!step("2. redeem it for a token", red.status === 201 && token.startsWith("snt_") && Boolean(handle), `handle ${handle}`)) return;

    const before = await request("/ledger.json");
    const call = await request("/v1/chat/completions", { auth: token, body });
    const source = call.headers.get("x-sentinel-cost-source");
    const reserved = Number(call.headers.get("x-sentinel-reserved-usd"));
    if (call.status === 200) realCostUsd = Number(call.headers.get("x-sentinel-cost-usd"));
    step("3. one real call on the allowlisted model", call.status === 200, realCostUsd !== null ? `cost ${usd(realCostUsd)} (${source})` : `HTTP ${call.status}: ${call.json?.error?.message ?? call.text.slice(0, 160)}`);
    if (realCostUsd === null) return;
    step("   cost is labelled as the provider reports it", source === health.json.cost_reporting, `${source} vs provider ${health.json.cost_reporting}`);
    step("   the reservation matched the bound printed before spending", Math.abs(reserved - worstCase) < 1e-9, `reserved ${usd(reserved)}`);
    step("   actual cost within the reservation", realCostUsd! <= reserved);

    const tokens = (await admin("/admin/tokens")).json.tokens as any[];
    const mine = tokens.find((t) => t.handle === handle);
    const after = await request("/ledger.json");
    const row = (after.json.byAgent as any[]).find((r) => r.key === handle);
    step("4. the ledger moved", Boolean(mine) && Math.abs(mine.spent_today_usd - realCostUsd!) < 1e-9 && row?.calls === 1 && after.json.today.callsMade > before.json.today.callsMade,
      `token spent ${usd(mine?.spent_today_usd ?? 0)}, public ledger shows ${row?.calls ?? 0} call(s) for ${handle}`);

    // Narrow only this run's token: allocation = spent + half a call's worst case.
    await admin(`/admin/tokens/${handle}`, { lifetimeAllocationUsd: mine.lifetime_spent_usd + worstCase / 2 }, "PATCH");
    const over = await request("/v1/chat/completions", { auth: token, body });
    const spentAfterOver = ((await admin("/admin/tokens")).json.tokens as any[]).find((t) => t.handle === handle).lifetime_spent_usd;
    step("5. a second call past the token's cap is refused", over.status === 402 && over.json?.error?.code === "sentinel_budget_exceeded", over.json?.error?.message ?? `HTTP ${over.status}`);
    step("   ...before it was sent: nothing spent", spentAfterOver === mine.lifetime_spent_usd, `spent ${usd(spentAfterOver)}`);
    await admin(`/admin/tokens/${handle}`, { lifetimeAllocationUsd: spentAfterOver }, "PATCH");
    const empty = await request("/v1/chat/completions", { auth: token, body });
    step("   a fully used cap is refused outright", empty.status === 402 && empty.json?.error?.code === "sentinel_token_allocation_exhausted", empty.json?.error?.message ?? `HTTP ${empty.status}`);

    const pause = await admin("/admin/pause", {});
    pausedByUs = pause.status === 200;
    step("6. pause", pausedByUs && (await request("/healthz")).json.status === "paused", `HTTP ${pause.status}`);
    const poolBefore = (await request("/healthz")).json.pool.committed_usd;
    const refused = await request("/v1/chat/completions", { auth: token, body });
    step("7. a call while paused is refused", refused.status === 503 && refused.json?.error?.code === "sentinel_paused", refused.json?.error?.message ?? `HTTP ${refused.status}`);
    step("   nothing spent while paused", (await request("/healthz")).json.pool.committed_usd === poolBefore);
    const resume = await admin("/admin/resume", {});
    if (resume.status === 200) pausedByUs = false;
    step("8. resume", resume.status === 200 && (await request("/healthz")).json.status !== "paused", `HTTP ${resume.status}`);
  };

  try {
    await sequence();
  } catch (error) {
    step("the sequence ran to completion", false, error instanceof Error ? error.message : String(error));
  } finally {
    console.log("\ncleanup");
    if (pausedByUs) {
      const r = await admin("/admin/resume", {}).catch(() => null);
      step("resumed the pause this run caused", r?.status === 200, r ? `HTTP ${r.status}` : "unreachable -- RESUME BY HAND: POST /admin/resume");
    }
    if (handle) {
      const r = await admin(`/admin/tokens/${handle}/revoke`, {}).catch(() => null);
      step(`revoked this run's token ${handle} (only that one)`, r?.status === 200, r ? `HTTP ${r.status}` : "unreachable");
    }
  }

  console.log(`\n${failures === 0 ? "ALL STEPS PASSED" : `${failures} STEP(S) FAILED`}. Real spend this run: ${realCostUsd === null ? "$0 (the real call did not complete)" : `${usd(realCostUsd)} (${health.json.cost_reporting})`}.`);
  return failures === 0 ? 0 : 1;
}
