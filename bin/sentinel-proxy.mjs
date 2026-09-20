#!/usr/bin/env node
/**
 * The entrypoint a stranger hits:
 *
 *   npx github:Dolaporr/sentinel --budget 5
 *
 * Plain JavaScript on purpose. This file runs before tsx is registered, so it
 * cannot be TypeScript itself, and it does its own argument and environment
 * checking so that the common failures -- no key, a typo'd budget -- surface as
 * one line of advice instead of a stack trace from somewhere inside the server.
 */
import "dotenv/config";

const USAGE = `sentinel-proxy - a budget-enforcing proxy in front of the Orbio gateway

Usage:
  npx github:Dolaporr/sentinel [options]

Options:
  -b, --budget <usd>   Total USD this proxy may commit. Sets both the session
                       ceiling and the rolling daily cap. Default: 3.
  -p, --port <port>    Port to listen on (loopback only). Default: 8787.
  -h, --help           Show this message.
  -V, --version        Print the version.

Environment:
  ORBIO_API_KEY        Required. The gateway key. Held by the proxy and never
                       forwarded to clients. Read from the environment or from
                       a .env file in the current directory.

The proxy binds to 127.0.0.1 only. Spend is tracked in .cache/spend.json in the
current directory and survives restarts, so restarting does not grant a fresh
budget for the day.`;

/** A problem with how the command was invoked: print advice, not a trace. */
class UsageError extends Error {}

/**
 * Accepts `--budget 5` and `--budget=5`, plus the short forms. Rejects anything
 * that is not a positive finite number, because a budget silently parsed as NaN
 * would disable the only control this tool exists to provide.
 */
function parseArgs(argv) {
  const options = { budgetUsd: undefined, port: undefined, help: false, version: false };

  const number = (flag, raw) => {
    if (raw === undefined || raw.startsWith("-")) throw new UsageError(`${flag} needs a value, for example: ${flag} 5`);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`${flag} must be a positive number, got "${raw}".`);
    return parsed;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const take = () => (inline !== undefined ? inline : argv[++i]);

    switch (flag) {
      case "-b": case "--budget": options.budgetUsd = number("--budget", take()); break;
      case "-p": case "--port": options.port = number("--port", take()); break;
      case "-h": case "--help": options.help = true; break;
      case "-V": case "--version": options.version = true; break;
      default: throw new UsageError(`unknown option "${arg}". Run with --help to see what is accepted.`);
    }
  }
  return options;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) { console.log(USAGE); return; }
  if (options.version) {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return;
  }

  // Checked here rather than in the server so a missing key reads as advice
  // instead of a 503 on the first request or a throw during startup.
  if (!process.env.ORBIO_API_KEY && !process.env.OPENROUTER_API_KEY) {
    console.error("sentinel-proxy: ORBIO_API_KEY is not set.");
    console.error("");
    console.error("The proxy holds your gateway key and spends against it, so it will not");
    console.error("start without one. Supply it in either of these ways:");
    console.error("");
    console.error("  export ORBIO_API_KEY=sk-...          # current shell");
    console.error("  echo 'ORBIO_API_KEY=sk-...' > .env   # this directory");
    console.error("");
    console.error("Then run the command again.");
    process.exit(1);
  }

  // The session ceiling and the daily cap are separate controls, and the
  // effective budget is the lower of the two. Setting only one would leave
  // `--budget 5` silently clamped to the $3 default cap.
  if (options.budgetUsd !== undefined) {
    process.env.SENTINEL_PROXY_BUDGET_USD = String(options.budgetUsd);
    process.env.SENTINEL_PROXY_DAILY_CAP_USD = String(options.budgetUsd);
  }
  if (options.port !== undefined) process.env.SENTINEL_PROXY_PORT = String(options.port);

  // tsx is registered at runtime because the server is TypeScript and this
  // package ships its sources rather than a build. Registering in-process keeps
  // it to one process, so Ctrl-C reaches the server directly.
  const { register } = await import("tsx/esm/api");
  register();

  const server = await import(new URL("../src/proxy/server.ts", import.meta.url).href);
  await server.main();
}

try {
  await run();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`sentinel-proxy: ${error.message}`);
    process.exit(2);
  }
  // Anything else is a real fault, but a bare trace is still the wrong first
  // thing to read, so lead with the message and keep the trace underneath.
  console.error(`sentinel-proxy: failed to start: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) console.error(`\n${error.stack}`);
  process.exit(1);
}
