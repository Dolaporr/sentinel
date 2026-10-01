import type { JsonObject } from "../orbio/types.js";
import type { AllocationGateway, HostedAllocationState } from "./types.js";

interface HostedTokenView {
  handle: string;
  revoked_at: string | null;
  lifetime_allocation_usd: number | null;
  lifetime_spent_usd: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Adapter for the actual hosted allocation surface:
 *   GET /admin/tokens
 *   PATCH /admin/tokens/<handle> { lifetimeAllocationUsd: absoluteTotal }
 *
 * A player token with a null allocation is deliberately refused. It is already
 * unlimited, so a game prize cannot be represented as an auditable increment.
 */
export class HostedAllocationGateway implements AllocationGateway {
  constructor(
    private readonly config: { baseUrl: string; adminToken: string },
    private readonly request: FetchLike = fetch
  ) {}

  async inspect(playerId: string): Promise<HostedAllocationState> {
    if (!/^[a-z0-9_-]{1,40}$/.test(playerId)) throw new Error("Invalid hosted token handle.");
    const headers = { authorization: `Bearer ${this.config.adminToken}`, accept: "application/json" };
    const base = this.config.baseUrl.replace(/\/$/, "");
    const list = await this.request(`${base}/admin/tokens`, { headers });
    if (!list.ok) throw new Error(`Hosted token lookup failed with HTTP ${list.status}.`);
    const listed = await list.json() as { tokens?: unknown };
    const token = Array.isArray(listed.tokens)
      ? listed.tokens.find((candidate): candidate is HostedTokenView => Boolean(candidate && typeof candidate === "object" && (candidate as HostedTokenView).handle === playerId))
      : undefined;
    if (!token) throw new Error("Hosted token handle was not found.");
    if (token.revoked_at) throw new Error("Hosted token is revoked.");
    if (typeof token.lifetime_allocation_usd !== "number" || !Number.isFinite(token.lifetime_allocation_usd)) {
      throw new Error("Game prizes require a finite hosted lifetime allocation; issue game tokens with $0.00 allocation first.");
    }
    return { lifetimeAllocationUsd: token.lifetime_allocation_usd, lifetimeSpentUsd: token.lifetime_spent_usd, raw: token as unknown as JsonObject };
  }

  async setLifetimeAllocation(input: { playerId: string; lifetimeAllocationUsd: number; reference: string }): Promise<{ lifetimeAllocationUsd: number; raw: JsonObject }> {
    if (!/^[a-z0-9_-]{1,40}$/.test(input.playerId)) throw new Error("Invalid hosted token handle.");
    if (!Number.isFinite(input.lifetimeAllocationUsd) || input.lifetimeAllocationUsd < 0) throw new Error("Lifetime allocation must be non-negative.");
    const headers = { authorization: `Bearer ${this.config.adminToken}`, accept: "application/json" };
    const base = this.config.baseUrl.replace(/\/$/, "");
    const target = Math.round(input.lifetimeAllocationUsd * 1_000_000_000) / 1_000_000_000;
    const patched = await this.request(`${base}/admin/tokens/${encodeURIComponent(input.playerId)}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ lifetimeAllocationUsd: target })
    });
    if (!patched.ok) throw new Error(`Hosted allocation update failed with HTTP ${patched.status}.`);
    const raw = await patched.json() as JsonObject;
    const applied = raw.lifetime_allocation_usd;
    if (typeof applied !== "number" || applied !== target) throw new Error("Hosted allocation response did not confirm the requested total.");
    return { lifetimeAllocationUsd: applied, raw };
  }
}
