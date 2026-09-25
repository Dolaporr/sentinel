/**
 * Turns the client's bearer token into an attribution label.
 *
 * The token was already ignored for authentication -- loopback trust, per
 * docs/PROXY.md -- and every OpenAI-compatible client forces a non-empty value
 * into that field regardless. This reuses the field that was already being
 * filled in with junk, rather than adding a header or a config file nobody
 * will set. It is a label, not an identity: anyone on the loopback can claim
 * any name, exactly as anyone on the loopback could already spend the budget.
 */

const MAX_LABEL_LENGTH = 40;
export const UNNAMED_AGENT = "unnamed";

/**
 * The exact placeholder both QUICKSTART.md and the startup banner tell every
 * unconfigured client to type. If it were treated as a real label, every
 * default install would report a distinct-looking "sentinel-local" agent that
 * is really just everyone who copy-pasted the example -- fake signal in the
 * one view this feature exists to make trustworthy. Reserved case-insensitively
 * since normalisation lowercases before this check runs.
 */
const RESERVED_PLACEHOLDER_LABELS: ReadonlySet<string> = new Set(["sentinel-local"]);

/** `Authorization: Bearer <token>` -> `<token>`, or undefined if absent/malformed. */
export function extractBearerToken(authorizationHeader: string | string[] | undefined): string | undefined {
  const header = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Hostile-input handling for a string that reaches a ledger file and an HTML
 * page: lower-cased, restricted to [a-z0-9-_], capped at 40 characters. This
 * strips rather than whole-rejects on the first disallowed character -- a
 * pasted "Roberto Ranker!!" becomes "robertoranker" rather than falling all
 * the way back to "unnamed", which would defeat the point for anyone who
 * didn't already know to type a slug. Falls back to `unnamed` only when
 * nothing usable survives, or the token is a known placeholder.
 *
 * This is normalisation for storage and display, not a security boundary by
 * itself -- callers must still HTML-escape the result before interpolating it
 * (see escapeHtml in ledger-view.ts), since even a fully "clean" [a-z0-9-_]
 * label is still attacker-controlled text choosing its own value.
 */
export function normalizeAgentLabel(bearerToken: string | undefined): string {
  if (!bearerToken) return UNNAMED_AGENT;
  const stripped = bearerToken.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const truncated = stripped.slice(0, MAX_LABEL_LENGTH);
  if (!truncated || RESERVED_PLACEHOLDER_LABELS.has(truncated)) return UNNAMED_AGENT;
  return truncated;
}

/** Reads the request's Authorization header straight through to a stored label. */
export function agentLabelFromHeader(authorizationHeader: string | string[] | undefined): string {
  return normalizeAgentLabel(extractBearerToken(authorizationHeader));
}
