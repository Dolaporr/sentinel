import {
  CHEAP_MODEL,
  EXPENSIVE_MODEL,
  MISSION_BUDGET_USD,
  SESSION_CEILING_USD,
  createOfflineTransport,
  createSentinel,
  runGovernedExpensiveAgent,
  runNakedAgent,
  sentinelSteps
} from "../src/runner/d2-mission.js";

const sessionBudgetUsd = Number(process.env.D2_BUDGET_USD ?? SESSION_CEILING_USD);
if (!Number.isFinite(sessionBudgetUsd) || sessionBudgetUsd <= 0 || sessionBudgetUsd > SESSION_CEILING_USD) {
  throw new Error("D2_BUDGET_USD must be greater than $0 and no more than the $3.00 session ceiling.");
}

const offlineTransport = createOfflineTransport();
const watchedA = createSentinel("watched-a", offlineTransport);
const watchedB = createSentinel("watched-b", offlineTransport);
const [a, b, naked, governedExpensive] = await Promise.all([
  watchedA.worker.run(sentinelSteps),
  watchedB.worker.run(sentinelSteps),
  runNakedAgent(offlineTransport),
  runGovernedExpensiveAgent(offlineTransport)
]);

console.log(JSON.stringify({
  mode: "offline",
  session_budget_usd: sessionBudgetUsd,
  mission_budget_usd: MISSION_BUDGET_USD,
  default_model: EXPENSIVE_MODEL,
  sentinel_routing: "cheap-by-default",
  cheap_model: CHEAP_MODEL,
  watched_a: { result: a, governor: watchedA.governor.snapshot(), events: watchedA.ledger.all() },
  watched_b: { result: b, governor: watchedB.governor.snapshot(), events: watchedB.ledger.all() },
  naked,
  governed_expensive: governedExpensive
}, null, 2));
