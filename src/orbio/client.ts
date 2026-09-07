import type { BalanceResult, GatewayKeyResult, GatewayKeyStatus, OrbioClient, SpendResult } from "./types.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const roundUsd = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export const MOCK_FAILURE_MODES = ["stale_balance", "tool_latency_30s", "revoke_midway_fail", "spend_telemetry_lag"] as const;
export type MockFailureMode = (typeof MOCK_FAILURE_MODES)[number] | "none";

function failureMode(): MockFailureMode {
  const value = process.env.MOCK_FAILURE_MODE ?? "none";
  if (value === "none" || (MOCK_FAILURE_MODES as readonly string[]).includes(value)) return value as MockFailureMode;
  throw new Error(`Unknown MOCK_FAILURE_MODE=${value}.`);
}

/** Deterministic gateway-model stand-in. It never accesses a real key or network. */
export class MockOrbioClient implements OrbioClient {
  readonly backend = "mock" as const;
  private balance = 50;
  private spent = 0;
  private sequence = 0;
  private key: { prefix: string; secret: string; active: boolean } | null = null;
  private readonly mode = failureMode();
  private staleSnapshot: BalanceResult | null = null;
  private lastSpendAt: number | null = null;

  async getBalance(): Promise<BalanceResult> {
    await this.beforeToolCall();
    const actual: BalanceResult = { balance: roundUsd(this.balance), spent: roundUsd(this.spent), raw: { environment: "mock", balance_usd: roundUsd(this.balance), spent_usd: roundUsd(this.spent), failure_mode: this.mode } };
    if (this.mode !== "stale_balance") return actual;
    return this.staleSnapshot ??= actual;
  }

  async createKey(input: { label?: string } = {}): Promise<GatewayKeyResult> {
    await this.beforeToolCall();
    const prefix = `mock-gateway-${String(++this.sequence).padStart(4, "0")}`;
    const secret = `mock-secret-${prefix}`;
    this.key = { prefix, secret, active: true };
    return { prefix, secret, raw: { environment: "mock", prefix, label: input.label ?? null, created: true, replaced: false } };
  }

  async getKeyStatus(): Promise<GatewayKeyStatus> {
    await this.beforeToolCall();
    const hasKey = this.key?.active ?? false;
    const telemetryLagging = this.mode === "spend_telemetry_lag" && this.lastSpendAt !== null && Date.now() - this.lastSpendAt < 30_000;
    return {
      hasKey,
      prefix: hasKey ? this.key!.prefix : null,
      state: hasKey ? "active" : "revoked",
      raw: { environment: "mock", has_key: hasKey, prefix: hasKey ? this.key!.prefix : null, telemetry_lagging: telemetryLagging, visible_spent_usd: telemetryLagging ? 0 : roundUsd(this.spent) }
    };
  }

  async runInference(input: { keySecret: string; model: string; prompt: string; maxCostUsd: number }): Promise<SpendResult> {
    await this.beforeToolCall();
    if (!this.key?.active || input.keySecret !== this.key.secret) throw new Error("Mock gateway key is revoked or invalid.");
    const cost = 0.00002;
    if (cost > input.maxCostUsd) throw new Error("Mock inference exceeds the configured cost cap.");
    this.balance = roundUsd(this.balance - cost);
    this.spent = roundUsd(this.spent + cost);
    this.lastSpendAt = Date.now();
    return { model: input.model, cost, raw: { environment: "mock", model: input.model, cost_usd: cost, prompt_sha256: "mock-trivial-prompt" } };
  }

  async revokeKey(): Promise<{ raw: Record<string, string | boolean> }> {
    await this.beforeToolCall();
    if (!this.key?.active) throw new Error("Mock gateway key is already revoked.");
    this.key.active = false;
    if (this.mode === "revoke_midway_fail") throw new Error("Mock revoke failed after the gateway key was disabled; recovery must re-read state.");
    return { raw: { environment: "mock", revoked: true, balance_unchanged: true } };
  }

  private async beforeToolCall(): Promise<void> { if (this.mode === "tool_latency_30s") await sleep(30_000); }
}

/**
 * The authenticated MCP invocation stays isolated at this boundary. The D1
 * script is mock-runnable; live orchestration records verbatim MCP responses.
 */
class McpOrbioClient implements OrbioClient {
  readonly backend = "mcp" as const;
  private unavailable(): never { throw new Error("Live MCP calls are invoked by the authenticated Orbio bridge, not from this local Node process."); }
  getBalance(): Promise<BalanceResult> { return Promise.reject(this.unavailable()); }
  createKey(_input?: { label?: string }): Promise<GatewayKeyResult> { return Promise.reject(this.unavailable()); }
  getKeyStatus(): Promise<GatewayKeyStatus> { return Promise.reject(this.unavailable()); }
  runInference(_input: { keySecret: string; model: string; prompt: string; maxCostUsd: number }): Promise<SpendResult> { return Promise.reject(this.unavailable()); }
  revokeKey(): Promise<{ raw: Record<string, string | boolean> }> { return Promise.reject(this.unavailable()); }
}

export function createOrbioClient(): OrbioClient { return process.env.ORBIO_BACKEND === "mcp" ? new McpOrbioClient() : new MockOrbioClient(); }
