import type { IncomingMessage, ServerResponse } from "node:http";
import type { PriceEntry } from "../governor/types.js";

const round = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

/**
 * Mirrors BudgetGovernor.estimateWorstCase, which is private. A refusal must say
 * what the request was refused for before any reservation exists, and the
 * hosted pool must hold the same amount the per-token governor will. Keep in
 * sync with src/governor/governor.ts.
 */
export function worstCaseUsd(price: PriceEntry, inputTokens: number, maxTokens: number, multiplier: number): number {
  return round(((inputTokens * price.inputPerMillionUsd + maxTokens * price.outputPerMillionUsd) / 1_000_000) * multiplier);
}

/**
 * Synthesised from the price table already resident in memory at startup, not
 * proxied live to the gateway. Most OpenAI-compatible clients -- Cursor is
 * confirmed to -- GET this on connect to populate a model dropdown and confirm
 * the endpoint is real, before the user can even attempt a completion. Serving
 * it from the table we already loaded costs nothing per connect and lists
 * exactly the models this proxy can actually admit; proxying it live would add
 * a gateway round trip to every client's connection check for no more truth,
 * since admission is checked against this same table regardless.
 */
export function modelsBody(prices: Readonly<Record<string, PriceEntry>>, defaultOwner: string): { object: "list"; data: Array<{ id: string; object: "model"; created: number; owned_by: string }> } {
  const data = Object.entries(prices)
    .map(([id, price]) => {
      const created = Math.floor(Date.parse(price.verifiedAt) / 1000);
      const slash = id.indexOf("/");
      return {
        id,
        object: "model" as const,
        created: Number.isFinite(created) ? created : 0,
        owned_by: slash === -1 ? defaultOwner : id.slice(0, slash)
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { object: "list", data };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`request body exceeds ${Math.round(maxBytes / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
