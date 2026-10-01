/**
 * Tokens, invite codes and handles for the hosted service.
 *
 * Only hashes are ever stored. A user token or invite code exists in plaintext
 * exactly once -- in the response that issues it -- so the state file, the
 * ledger and every log line can be read by anyone without handing out spend.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { extractBearerToken, normalizeAgentLabel } from "../agent-label.js";

export const TOKEN_PREFIX = "snt_";
const INVITE_PREFIX = "SNT";
// Crockford base32: no I, L, O, U, so a code read aloud or copied off a
// screenshot cannot be misread as a different valid code.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** 256 bits. Worthless outside Sentinel: it only ever authorises spend against Sentinel's own caps. */
export function newUserToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** SNT-XXXX-XXXX-XXXX-XXXX: 80 bits, handed out by hand, redeemed once. */
export function newInviteCode(): string {
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => CROCKFORD[b & 31]).join("");
  return `${INVITE_PREFIX}-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

/** Case and dash tolerant, so a hand-typed code still matches its hash. */
export function canonicalInviteCode(raw: string): string {
  const compact = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
  const body = compact.startsWith(INVITE_PREFIX) ? compact.slice(INVITE_PREFIX.length) : compact;
  if (body.length !== 16) return "";
  return `${INVITE_PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
}

/**
 * The public, anonymised name for a token: what the ledger page shows in place
 * of an agent label. Random, not derived from the token, so nothing about the
 * secret can be recovered from it. Passed through the local proxy's own label
 * normaliser so both ledgers store labels under exactly one set of rules.
 */
export function newHandle(taken: ReadonlySet<string>): string {
  for (;;) {
    const handle = normalizeAgentLabel(`t-${randomBytes(3).toString("hex")}`);
    if (!taken.has(handle)) return handle;
  }
}

/**
 * The local proxy's bearer-as-label pattern, with one change: the bearer is a
 * secret here, so it is looked up by hash rather than used as the label.
 * Returns the token's hash, or undefined for anything that is not one of ours.
 */
export function userTokenHashFromHeader(authorizationHeader: string | string[] | undefined): string | undefined {
  const bearer = extractBearerToken(authorizationHeader);
  if (!bearer || !bearer.startsWith(TOKEN_PREFIX)) return undefined;
  return sha256(bearer);
}

/** Admin auth: compare hashes in constant time, so response timing says nothing about the secret. */
export function adminTokenMatches(authorizationHeader: string | string[] | undefined, adminSecret: string): boolean {
  const bearer = extractBearerToken(authorizationHeader);
  if (!bearer || bearer.startsWith(TOKEN_PREFIX)) return false;
  return timingSafeEqual(Buffer.from(sha256(bearer), "hex"), Buffer.from(sha256(adminSecret), "hex"));
}
