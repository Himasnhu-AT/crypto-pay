import { bytesToHex, hexToBytes, sha256 } from "viem";

/**
 * Tron address + tx-id helpers. Tron is NOT EVM: addresses are base58check
 * (`T…`) over a 21-byte payload `0x41 ‖ <20-byte body>`, and tx-ids are 64 hex
 * chars with NO `0x` prefix. But the 20-byte *body* of a Tron address is exactly
 * the EVM-equivalent address, and TRC-20 emits the identical
 * `Transfer(address,address,uint256)` event as ERC-20 — so once we strip the
 * `0x41` version byte we can feed everything through the same pure
 * `evaluateReceipt` core that EVM uses.
 *
 * No new dependency: base58 is a tiny self-contained decoder and the checksum
 * uses viem's `sha256` (viem is already a peer dep).
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = 58n;
const ALPHABET_MAP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET[i]!] = i;
  return m;
})();

/** The Tron mainnet address version byte. Every `T…` address decodes to this. */
const TRON_VERSION_BYTE = 0x41;

/** base58 (Bitcoin/Tron alphabet) decode. Leading `1`s map to leading 0x00. */
function base58Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  let num = 0n;
  for (const ch of str) {
    const v = ALPHABET_MAP[ch];
    if (v === undefined) {
      throw new Error(`crypto-pay/tron: invalid base58 character "${ch}".`);
    }
    num = num * BASE + BigInt(v);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  bytes.reverse();
  let leadingZeros = 0;
  for (const ch of str) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  out.set(bytes, leadingZeros);
  return out;
}

/** base58 encode (Bitcoin/Tron alphabet). Leading 0x00 map to leading `1`s. */
function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = "";
  while (num > 0n) {
    out = ALPHABET[Number(num % BASE)] + out;
    num /= BASE;
  }
  return "1".repeat(zeros) + out;
}

/** Double-SHA-256, as base58check uses for its 4-byte checksum. */
function doubleSha256(b: Uint8Array): Uint8Array {
  return sha256(sha256(b, "bytes"), "bytes");
}

/**
 * Decode a Tron base58check address (`T…`) to its 20-byte EVM-equivalent
 * address (`0x…`). Verifies the base58check checksum and the `0x41` version
 * byte, so a typo in configured env addresses fails loud at config time rather
 * than silently routing to the wrong address.
 */
export function tronBase58ToEvmAddress(base58: string): `0x${string}` {
  const decoded = base58Decode(base58.trim());
  // 1 version + 20 body + 4 checksum
  if (decoded.length !== 25) {
    throw new Error(
      `crypto-pay/tron: bad Tron address length (${decoded.length} bytes, expected 25).`,
    );
  }
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const expected = doubleSha256(payload);
  for (let i = 0; i < 4; i++) {
    if (expected[i] !== checksum[i]) {
      throw new Error("crypto-pay/tron: Tron address checksum mismatch.");
    }
  }
  if (payload[0] !== TRON_VERSION_BYTE) {
    throw new Error(
      "crypto-pay/tron: not a Tron mainnet address (version byte != 0x41).",
    );
  }
  return bytesToHex(payload.subarray(1));
}

/**
 * A Tron 41-prefixed hex address (e.g. `41a614…`, optionally `0x`-prefixed) →
 * 20-byte EVM hex. Used when a contract/address comes in hex rather than
 * base58, including the addresses TronGrid returns inside event logs.
 */
export function tronHexToEvmAddress(hex: string): `0x${string}` {
  let h = hex.trim().toLowerCase();
  if (h.startsWith("0x")) h = h.slice(2);
  // A 21-byte (42-hex) Tron address carries the 0x41 prefix; a 20-byte (40-hex)
  // value is already the EVM body (TronGrid log addresses come this way).
  if (h.length === 42 && h.startsWith("41")) h = h.slice(2);
  if (h.length !== 40 || !/^[0-9a-f]{40}$/.test(h)) {
    throw new Error("crypto-pay/tron: bad Tron hex address.");
  }
  return `0x${h}`;
}

/**
 * 20-byte EVM hex (`0x…`, or bare 40-hex) → Tron base58check address (`T…`).
 * The inverse of {@link tronBase58ToEvmAddress}; handy for displaying/validating
 * our own receive address in the EVM form some tools surface.
 */
export function evmAddressToTronBase58(hex: string): string {
  let h = hex.trim().toLowerCase();
  if (h.startsWith("0x")) h = h.slice(2);
  if (h.length !== 40 || !/^[0-9a-f]{40}$/.test(h)) {
    throw new Error("crypto-pay/tron: bad EVM hex address.");
  }
  const body = hexToBytes(`0x${h}`);
  const payload = new Uint8Array(21);
  payload[0] = TRON_VERSION_BYTE;
  payload.set(body, 1);
  const checksum = doubleSha256(payload).subarray(0, 4);
  const full = new Uint8Array(25);
  full.set(payload, 0);
  full.set(checksum, 21);
  return base58Encode(full);
}

const TRON_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** True for a 64-hex Tron tx-id (with or without a `0x` prefix). */
export function isTronTxId(value: string): boolean {
  return TRON_TXID_RE.test(value.startsWith("0x") ? value.slice(2) : value);
}

/**
 * Canonical tx-id form for Tron: lowercase 64-hex with NO `0x` prefix — the form
 * TronGrid expects in request bodies and the form we key `used_txhashes` on.
 * Throws on a malformed id.
 */
export function normalizeTronTxId(value: string): string {
  const v = value.startsWith("0x") ? value.slice(2) : value;
  if (!TRON_TXID_RE.test(v)) {
    throw new Error("crypto-pay/tron: bad Tron tx-id.");
  }
  return v.toLowerCase();
}
