export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue; }

export type OrbioBackend = "mock" | "mcp";

export interface BalanceResult {
  balance: number;
  spent: number;
  raw: JsonObject;
}

export interface GatewayKeyResult {
  /** Held in memory only. Never written to evidence or stdout. */
  secret: string;
  prefix: string;
  raw: JsonObject;
}

export interface GatewayKeyStatus {
  hasKey: boolean;
  prefix: string | null;
  state: "active" | "revoked";
  raw: JsonObject;
}

export interface SpendResult {
  model: string;
  cost: number;
  raw: JsonObject;
}

/** Current authenticated Orbio gateway interface; no funded-key return exists. */
export interface OrbioClient {
  readonly backend: OrbioBackend;
  getBalance(): Promise<BalanceResult>;
  createKey(input?: { label?: string }): Promise<GatewayKeyResult>;
  getKeyStatus(): Promise<GatewayKeyStatus>;
  runInference(input: { keySecret: string; model: string; prompt: string; maxCostUsd: number }): Promise<SpendResult>;
  revokeKey(): Promise<{ raw: JsonObject }>;
}
