import type { ValidateInput, ValidateResult } from "../config";
import type { Validator } from "../validator";
import { base58Decode } from "./base58";

/**
 * Solana (SPL-token) payment validation. Mirrors the EVM `createValidator` and
 * Tron `createTronValidator` surface — same `Validator` interface, same
 * `ValidateResult` — but decides on Solana's terms.
 *
 * Solana has no ERC-20-style `Transfer` event to scan. The robust, tamper-proof
 * signal is the transaction's **token-balance delta**: the JSON-RPC
 * `getTransaction` response carries `meta.pre/postTokenBalances`, each pinned to
 * a `{ mint, owner }`. We compare the receive owner's balance for the configured
 * mint before vs after the tx. A worthless look-alike SPL token can't spoof
 * this: its balances carry a different `mint`, so they never match.
 *
 * Finality: we read at `finalized` commitment, so a returned tx is already
 * irreversible — appearing there *is* finality. `minConfirmations` stays
 * configurable but is default-safe at 1.
 *
 * Node-only (uses global `fetch` against a Solana JSON-RPC endpoint). The repo's
 * payment routes already run on the Node.js runtime.
 */

/** One entry from `meta.pre/postTokenBalances` (jsonParsed `getTransaction`). */
export type SolanaTokenBalance = {
  /** Index into the tx's account keys — the join key between pre and post. */
  accountIndex: number;
  /** SPL mint. Pinned: only balances of `cfg.mint` are ever counted. */
  mint: string;
  /** The wallet that OWNS the token account (not the token account address). */
  owner?: string;
  /** Raw + UI amount; we only trust `.amount` (smallest units, as a string). */
  uiTokenAmount: { amount: string; decimals?: number };
};

/** Minimal shape of the `getTransaction` result we read (jsonParsed). */
export type SolanaTxInfo = {
  /** The slot (block) the tx landed in. Reported back as `blockNumber`. */
  slot: number;
  meta: {
    /** `null` on success; any object means the tx failed → reverted. */
    err: unknown;
    preTokenBalances?: SolanaTokenBalance[];
    postTokenBalances?: SolanaTokenBalance[];
  } | null;
};

/**
 * The chain-reading surface the Solana validator needs. Production hits a
 * JSON-RPC node; tests inject a stub so no network is touched (mirrors EVM's
 * `ChainReader` and Tron's `TronReader`).
 */
export type SolanaReader = {
  /** `null` ⇒ not found / not yet finalized, so the caller retries later. */
  getTransaction(signature: string): Promise<SolanaTxInfo | null>;
  /** Current finalized slot, for the confirmations calculation. */
  getSlot(): Promise<number>;
};

export type SolanaPaymentConfig = {
  /**
   * Solana JSON-RPC URLs, tried in order (fallback). Put a reliable public RPC
   * first and a keyed backup after it. Read-only — infra, not a processor.
   */
  rpcUrls: string[];
  /** SPL mint as base58 (32-byte). Pinned: only this mint's balances count. */
  mint: string;
  /** Token decimals. USDC on Solana is 6. Not used in validation, only display. */
  decimals: number;
  /** Display symbol, e.g. "USDC". Not used in validation. */
  symbol: string;
  /** The wallet (owner) whose token balance must increase — our receiver. */
  receiveOwner: string;
  /** Finalized-slot confirmations required. Default-safe at 1 (finalized = final). */
  minConfirmations: number;
};

const SIGNATURE_BYTES = 64;
const PUBKEY_BYTES = 32;

/**
 * True for a syntactically valid Solana transaction signature: base58 that
 * decodes to exactly 64 bytes (typically 87–88 chars). CASE-SENSITIVE — Solana
 * base58 is never lowercased. Mirrors Tron's `isTronTxId`.
 */
export function isValidSolanaSignature(value: string): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0) return false;
  try {
    return base58Decode(v).length === SIGNATURE_BYTES;
  } catch {
    return false;
  }
}

/**
 * Canonical signature form for Solana: the trimmed, case-PRESERVED base58 string
 * — the form the RPC expects and the form we key `used_txhashes` on. Throws on a
 * malformed signature. Mirrors Tron's `normalizeTronTxId` (but never lowercases).
 */
export function normalizeSolanaSignature(value: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!isValidSolanaSignature(v)) {
    throw new Error("crypto-pay/solana: bad Solana signature.");
  }
  return v;
}

/** True for a valid Solana address/mint/owner: base58 decoding to 32 bytes. */
export function isValidSolanaAddress(value: string): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0) return false;
  try {
    return base58Decode(v).length === PUBKEY_BYTES;
  } catch {
    return false;
  }
}

/** Assert + trim a configured address, throwing loudly at construction on typo. */
function assertAddress(value: string, label: string): string {
  if (!isValidSolanaAddress(value)) {
    throw new Error(
      `crypto-pay/solana: ${label} is not a valid base58 32-byte address.`,
    );
  }
  return value.trim();
}

/**
 * Net token-balance change for `owner` on `mint` across the tx, summing every
 * token account they hold for that mint. A missing pre entry (ATA created in the
 * tx) counts as 0; a missing post entry (ATA closed) also counts as 0. Positive
 * ⇒ received, negative ⇒ sent. `null` ⇒ this owner touched no such balance.
 */
function netTokenDelta(
  pre: SolanaTokenBalance[],
  post: SolanaTokenBalance[],
  mint: string,
  owner: string,
): bigint | null {
  const indexes = new Set<number>();
  for (const b of post) {
    if (b.mint === mint && b.owner === owner) indexes.add(b.accountIndex);
  }
  for (const b of pre) {
    if (b.mint === mint && b.owner === owner) indexes.add(b.accountIndex);
  }
  if (indexes.size === 0) return null;

  const amountAt = (arr: SolanaTokenBalance[], idx: number): bigint => {
    const hit = arr.find((b) => b.accountIndex === idx);
    if (!hit) return 0n;
    try {
      return BigInt(hit.uiTokenAmount.amount);
    } catch {
      return 0n;
    }
  };

  let total = 0n;
  for (const idx of indexes) total += amountAt(post, idx) - amountAt(pre, idx);
  return total;
}

/** Production reader: Solana JSON-RPC over `fetch`, with URL fallback. */
function httpSolanaReader(cfg: SolanaPaymentConfig): SolanaReader {
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    let lastErr: unknown;
    for (const base of cfg.rpcUrls) {
      try {
        const res = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!res.ok) throw new Error(`Solana RPC ${method} HTTP ${res.status}`);
        const json = (await res.json()) as { result?: unknown; error?: unknown };
        if (json.error) {
          throw new Error(`Solana RPC ${method} error: ${JSON.stringify(json.error)}`);
        }
        return json.result;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`Solana RPC ${method} failed`);
  }

  return {
    async getTransaction(signature) {
      const result = await rpc("getTransaction", [
        signature,
        {
          encoding: "jsonParsed",
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        },
      ]);
      // A finalized-but-unknown tx returns `null` — map straight to not-found.
      if (result === null || result === undefined) return null;
      return result as SolanaTxInfo;
    },
    async getSlot() {
      const result = await rpc("getSlot", [{ commitment: "finalized" }]);
      if (typeof result !== "number") {
        throw new Error("Solana RPC getSlot: missing slot number");
      }
      return result;
    },
  };
}

/**
 * Build a Solana validator bound to one mint / receive owner. `reader` is
 * overridable for tests; in production it is built from `cfg.rpcUrls`.
 */
export function createSolanaValidator(
  cfg: SolanaPaymentConfig,
  reader?: SolanaReader,
): Validator {
  if (!reader && cfg.rpcUrls.length === 0) {
    throw new Error("crypto-pay/solana: at least one rpcUrl is required.");
  }
  const chain = reader ?? httpSolanaReader(cfg);

  // Validate the pinned addresses ONCE, at construction — a typo'd mint or
  // receive owner fails loud here rather than silently never matching a payment.
  const mint = assertAddress(cfg.mint, "mint");
  const receiveOwner = assertAddress(cfg.receiveOwner, "receiveOwner");

  async function validatePayment(input: ValidateInput): Promise<ValidateResult> {
    if (typeof input.txHash !== "string" || !isValidSolanaSignature(input.txHash)) {
      return { ok: false, reason: "bad_tx_hash" };
    }
    const signature = normalizeSolanaSignature(input.txHash);

    let info: SolanaTxInfo | null;
    try {
      info = await chain.getTransaction(signature);
    } catch {
      return { ok: false, reason: "not_found" };
    }
    // Unknown / not yet finalized (or a missing meta block) ⇒ not_found so the
    // caller retries later.
    if (!info || !info.meta) {
      return { ok: false, reason: "not_found" };
    }

    // A failed tx moved no funds even though it occupies a slot.
    if (info.meta.err !== null && info.meta.err !== undefined) {
      return { ok: false, reason: "reverted" };
    }

    const pre = info.meta.preTokenBalances ?? [];
    const post = info.meta.postTokenBalances ?? [];

    // (d) Our receive owner's balance for the pinned mint must have grown by at
    //     least the price. Overpay passes (`>=`), underpay fails — same rule as
    //     the EVM/Tron `evaluateReceipt`.
    const received = netTokenDelta(pre, post, mint, receiveOwner);
    if (received === null || received < input.expectedAmount) {
      return { ok: false, reason: "no_matching_transfer" };
    }

    // (e) Optional sender pin. When enforced, a token account owned by the
    //     claimed sender for the same mint must show a NEGATIVE delta (they
    //     sent). requireSender with no sender is a fail-safe reject — matching
    //     the EVM/Tron `evaluateReceipt` policy.
    const requireSender = input.requireSender ?? true;
    if (requireSender) {
      if (!input.sender) return { ok: false, reason: "no_matching_transfer" };
      const sent = netTokenDelta(pre, post, mint, input.sender);
      if (sent === null || sent >= 0n) {
        return { ok: false, reason: "no_matching_transfer" };
      }
    }

    // (f) Confirmations. We read at `finalized`, so the tx is already
    //     irreversible. Report the finalized-slot depth (clamped to >= 1); a
    //     lagging RPC or an unavailable head never pushes us below 1.
    let headSlot: number;
    try {
      headSlot = await chain.getSlot();
    } catch {
      headSlot = info.slot;
    }
    const confirmations = Math.max(1, headSlot - info.slot + 1);
    if (confirmations < cfg.minConfirmations) {
      return { ok: false, reason: "insufficient_confirmations", confirmations };
    }

    return {
      ok: true,
      amount: received,
      confirmations,
      blockNumber: BigInt(info.slot),
      // Solana signatures are base58, not `0x`-hex; the field is typed for EVM
      // but carries the canonical signature at runtime (as Tron does its tx-id).
      txHash: signature as `0x${string}`,
    };
  }

  return { validatePayment };
}
