/**
 * Minimal, self-contained base58 codec (Bitcoin/Solana alphabet). Solana is a
 * non-EVM chain: addresses/mints/owners are 32-byte base58 public keys and
 * transaction signatures are 64-byte base58 — both CASE-SENSITIVE (unlike hex,
 * you must never lowercase them). We only need decode (for length validation)
 * and encode (for the round-trip test), so this stays tiny and dependency-free.
 *
 * The alphabet has no `0`, `O`, `I`, or `l` — the four glyphs that read
 * ambiguously — which is exactly why base58 is used for keys/signatures.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = 58n;
const ALPHABET_MAP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET[i]!] = i;
  return m;
})();

/**
 * base58 decode. Leading `1`s map to leading `0x00` bytes (base58's canonical
 * leading-zero handling). Throws on any character outside the alphabet, which is
 * what lets the signature/address validators reject non-base58 input.
 */
export function base58Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  let num = 0n;
  for (const ch of str) {
    const v = ALPHABET_MAP[ch];
    if (v === undefined) {
      throw new Error(`crypto-pay/solana: invalid base58 character "${ch}".`);
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

/** base58 encode. Leading `0x00` bytes map to leading `1`s. */
export function base58Encode(bytes: Uint8Array): string {
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
