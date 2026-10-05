/**
 * Robinhood Chain wallet addresses.
 *
 * Robinhood Chain is an Arbitrum Orbit chain (chain id 4663): its accounts
 * are ordinary Ethereum addresses, "0x" and 40 hex digits. A mixed-case
 * address carries an EIP-55 checksum, which catches almost every typo; it is
 * checked here because a prize sent to a mistyped address is gone. All-lower
 * or all-upper input has no checksum to check; it is accepted and stored in
 * its checksummed form so the payer copies a checksummed address.
 *
 * Node's crypto has SHA3-256 but not Keccak-256 (they pad differently), so
 * Keccak-256 is implemented below. It only ever hashes a 40-character string.
 */

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
/** Rotation offsets r[x][y]. */
const R = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14]
];
const rotl = (v: bigint, n: number) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function keccakF(a: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d;
    }
    const b = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], R[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK & b[((x + 2) % 5) + 5 * y]);
    a[0] ^= RC[round];
  }
}

/** Keccak-256 (the Ethereum hash), hex out. */
export function keccak256Hex(input: Uint8Array): string {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const a = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      a[i] ^= lane;
    }
    keccakF(a);
  }
  let hex = "";
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) hex += Number((a[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0");
  return hex;
}

export function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256Hex(new TextEncoder().encode(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

export type WalletCheck = { ok: true; address: string } | { ok: false; reason: "format" | "zero" | "checksum" };

export function parseWallet(raw: unknown): WalletCheck {
  if (typeof raw !== "string") return { ok: false, reason: "format" };
  const s = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, reason: "format" };
  const body = s.slice(2);
  if (/^0+$/.test(body)) return { ok: false, reason: "zero" };
  const checksummed = toChecksumAddress(s);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && checksummed !== s) return { ok: false, reason: "checksum" };
  return { ok: true, address: checksummed };
}
