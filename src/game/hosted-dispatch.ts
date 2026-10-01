/**
 * The only game-side import of dispatchAdmitted. Keeping this seam small is a
 * custody boundary: game code can never opt out of client-body redaction.
 */
import type { ServerResponse } from "node:http";
import type { Reservation } from "../governor/types.js";
import { dispatchAdmitted } from "../proxy/dispatch.js";
import type { ChatCompletionRequest } from "../proxy/messages.js";
import type { Provider } from "../proxy/providers/types.js";

export interface GameDispatchInput {
  upstreamUrl: string;
  provider: Provider;
  apiKey: string;
  body: ChatCompletionRequest;
  reservation: Reservation;
  res: ServerResponse;
}

/**
 * Runs already-admitted game inference. `true` is deliberately literal: this
 * file is source-scanned in the custody suite, and no game caller can supply
 * a weaker value.
 */
export async function dispatchGameAdmitted(input: GameDispatchInput): Promise<{ cost: number | null; costSource: "exact" | "estimated" | "not_billed" }> {
  let cost: number | null = null;
  let costSource: "exact" | "estimated" | "not_billed" = "not_billed";
  await dispatchAdmitted({
    upstreamUrl: input.upstreamUrl,
    provider: input.provider,
    apiKey: input.apiKey,
    body: input.body,
    streaming: input.body.stream === true,
    reservation: input.reservation,
    res: input.res,
    headers: {},
    redactClientBodies: true,
    // An upstream error can reflect the operator key. The dispatcher logs the
    // status alone here; client output remains redacted independently.
    logUpstreamErrorBodies: false,
    sink: {
      async exact(value) { cost = value; costSource = "exact"; },
      async estimated() { costSource = "estimated"; },
      async notBilled() { costSource = "not_billed"; }
    }
  });
  return { cost, costSource };
}
