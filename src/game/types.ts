import type { JsonObject } from "../orbio/types.js";

/** A policy is executable metadata, never a player-supplied prompt or program. */
export interface GamePolicy {
  model: string;
  maxTokens: number;
  retryLimit: number;
  chunkSize: number;
  escalateAfter: number | null;
}

export interface GameSeason {
  id: string;
  poolUsd: number;
  perPlayerCeilingUsd: number;
  prizePerWinUsd: number;
  allowedModels: readonly string[];
  active: boolean;
}

export type GameEventName =
  | "SEASON_FUNDED"
  | "ROUND_SEALED"
  | "GAME_COST_RESERVED"
  | "GAME_COST_SETTLED"
  | "GAME_COST_NOT_BILLED"
  | "ROUND_FINISHED"
  | "PRIZE_ALLOCATION_PENDING"
  | "PRIZE_ALLOCATION_APPLYING"
  | "PRIZE_ALLOCATION_GRANTED"
  | "PRIZE_ALLOCATION_RECONCILIATION_REQUIRED";

export interface GameEvent {
  id: string;
  ts: string;
  event: GameEventName;
  seasonId: string;
  runId: string;
  playerId: string | null;
  amountUsd: number | null;
  reason: string | null;
  policyHash: string | null;
  raw: JsonObject;
}

export interface GamePoolSnapshot {
  fundedUsd: number;
  reservedUsd: number;
  spentUsd: number;
  prizeHeldUsd: number;
  remainingUsd: number;
  playerAwardsUsd: Readonly<Record<string, number>>;
}

export interface GameExecutionResult {
  completed: boolean;
  /** Only a provider response belongs here. Never include the mission prompt. */
  upstreamRaw: JsonObject;
  usage: { cost?: number } | undefined;
}

export interface GameTransport {
  execute(input: {
    runId: string;
    seasonId: string;
    policy: GamePolicy;
    reservedUsd: number;
    inputTokens: number;
  }): Promise<GameExecutionResult>;
}

export interface HostedAllocationState {
  lifetimeAllocationUsd: number;
  lifetimeSpentUsd: number;
  raw: JsonObject;
}

/** The hosted service owns this implementation; the game only requests an allocation. */
export interface AllocationGateway {
  inspect(playerId: string): Promise<HostedAllocationState>;
  setLifetimeAllocation(input: { playerId: string; lifetimeAllocationUsd: number; reference: string }): Promise<{ lifetimeAllocationUsd: number; raw: JsonObject }>;
}

export interface RoundOutcome {
  runId: string;
  completed: boolean;
  billedUsd: number | null;
  prizePendingUsd: number;
  reason: string | null;
}
