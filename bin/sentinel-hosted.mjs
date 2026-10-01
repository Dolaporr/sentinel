#!/usr/bin/env node
/**
 * Entrypoint for the hosted governor (Railway: `node bin/sentinel-hosted.mjs`).
 * Plain JavaScript for the same reason as sentinel-proxy.mjs: it registers tsx
 * before loading the TypeScript sources, and turns startup failures into one
 * line of advice instead of a trace.
 */
import "dotenv/config";

try {
  const { register } = await import("tsx/esm/api");
  register();
  const { main } = await import(new URL("../src/proxy/hosted/main.ts", import.meta.url).href);
  await main();
} catch (error) {
  console.error(`sentinel-hosted: failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
