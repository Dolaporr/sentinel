import { randomUUID } from "node:crypto";
import type { AllocationGateway, GamePolicy, GameSeason, GameTransport, RoundOutcome } from "./types.js";
import { GameEventStore, gameEvent, policyHash, providerEvidence } from "./store.js";

const round = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

export class GameRoundRunner {
  constructor(
    private readonly season: GameSeason,
    private readonly store: GameEventStore,
    private readonly transport: GameTransport,
    /** Provider prices are resolved by the hosted game service, not the governor. */
    private readonly quoteWorstCase: (policy: GamePolicy) => number
  ) {}

  fund(amountUsd: number): void {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error("Season funding must be positive.");
    this.store.append(gameEvent("SEASON_FUNDED", {
      seasonId: this.season.id, runId: "season", playerId: null, amountUsd: round(amountUsd), reason: "season_funding", policyHash: null, raw: {}
    }));
  }

  async run(playerId: string, policy: GamePolicy): Promise<RoundOutcome> {
    if (!this.season.active) throw new Error("This season is closed.");
    if (!this.season.allowedModels.includes(policy.model)) throw new Error("GAME_MODEL_REFUSED");
    const quoteUsd = round(this.quoteWorstCase(policy));
    if (!Number.isFinite(quoteUsd) || quoteUsd <= 0) throw new Error("GAME_QUOTE_INVALID");
    const snapshot = this.store.snapshot(this.season);
    if (quoteUsd > snapshot.remainingUsd) throw new Error("GAME_POOL_EXHAUSTED");

    const runId = randomUUID();
    const hash = policyHash(policy);
    this.store.append(gameEvent("ROUND_SEALED", {
      seasonId: this.season.id, runId, playerId, amountUsd: null, reason: "policy_sealed", policyHash: hash,
      raw: { policy: { model: policy.model, max_tokens: policy.maxTokens, retry_limit: policy.retryLimit, chunk_size: policy.chunkSize, escalate_after: policy.escalateAfter } }
    }));
    this.store.append(gameEvent("GAME_COST_RESERVED", {
      seasonId: this.season.id, runId, playerId, amountUsd: quoteUsd, reason: "provider_worst_case", policyHash: hash, raw: {}
    }));

    let result;
    try { result = await this.transport.execute({ runId, seasonId: this.season.id, policy }); }
    catch (error) {
      this.store.append(gameEvent("GAME_COST_NOT_BILLED", {
        seasonId: this.season.id, runId, playerId, amountUsd: null, reason: "upstream_error", policyHash: hash,
        raw: { reserved_usd: quoteUsd, error: error instanceof Error ? error.name : "unknown" }
      }));
      this.store.append(gameEvent("ROUND_FINISHED", {
        seasonId: this.season.id, runId, playerId, amountUsd: null, reason: "upstream_error", policyHash: hash, raw: {}
      }));
      return { runId, completed: false, billedUsd: null, prizePendingUsd: 0, reason: "upstream_error" };
    }

    const cost = result.usage?.cost;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      this.store.append(gameEvent("GAME_COST_NOT_BILLED", {
        seasonId: this.season.id, runId, playerId, amountUsd: null, reason: "not_billed", policyHash: hash,
        raw: { reserved_usd: quoteUsd, upstream: providerEvidence(result.upstreamRaw) }
      }));
      this.store.append(gameEvent("ROUND_FINISHED", {
        seasonId: this.season.id, runId, playerId, amountUsd: null, reason: "not_billed", policyHash: hash, raw: {}
      }));
      return { runId, completed: false, billedUsd: null, prizePendingUsd: 0, reason: "not_billed" };
    }

    const billedUsd = round(cost);
    this.store.append(gameEvent("GAME_COST_SETTLED", {
      seasonId: this.season.id, runId, playerId, amountUsd: billedUsd, reason: "usage.cost", policyHash: hash,
      raw: { reserved_usd: quoteUsd, upstream: providerEvidence(result.upstreamRaw) }
    }));
    const settled = this.store.snapshot(this.season);
    const awarded = settled.playerAwardsUsd[playerId] ?? 0;
    const prize = result.completed
      ? round(Math.max(0, Math.min(this.season.prizePerWinUsd, this.season.perPlayerCeilingUsd - awarded, settled.remainingUsd)))
      : 0;
    if (prize > 0) this.store.append(gameEvent("PRIZE_ALLOCATION_PENDING", {
      seasonId: this.season.id, runId, playerId, amountUsd: prize, reason: "mission_completed", policyHash: hash, raw: {}
    }));
    this.store.append(gameEvent("ROUND_FINISHED", {
      seasonId: this.season.id, runId, playerId, amountUsd: null, reason: result.completed ? "mission_completed" : "mission_incomplete", policyHash: hash, raw: {}
    }));
    return { runId, completed: result.completed, billedUsd, prizePendingUsd: prize, reason: result.completed ? null : "mission_incomplete" };
  }

  async grantPrize(runId: string, allocations: AllocationGateway): Promise<void> {
    const pending = this.store.all(this.season.id).find((event) => event.event === "PRIZE_ALLOCATION_PENDING" && event.runId === runId);
    if (!pending?.playerId || pending.amountUsd === null) throw new Error("No pending prize exists for this run.");
    const alreadyGranted = this.store.all(this.season.id).some((event) => event.event === "PRIZE_ALLOCATION_GRANTED" && event.runId === runId);
    if (alreadyGranted) throw new Error("Prize has already been granted.");
    const response = await allocations.grant({ playerId: pending.playerId, amountUsd: pending.amountUsd, reference: runId });
    this.store.append(gameEvent("PRIZE_ALLOCATION_GRANTED", {
      seasonId: this.season.id, runId, playerId: pending.playerId, amountUsd: pending.amountUsd, reason: "manual_allocation", policyHash: pending.policyHash,
      raw: { allocation_id: response.allocationId, upstream: providerEvidence(response.raw) }
    }));
  }
}
