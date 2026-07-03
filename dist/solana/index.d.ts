import { c as Validator } from '../validator-Bdhe622R.js';
import 'viem';

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
/**
 * base58 decode. Leading `1`s map to leading `0x00` bytes (base58's canonical
 * leading-zero handling). Throws on any character outside the alphabet, which is
 * what lets the signature/address validators reject non-base58 input.
 */
declare function base58Decode(str: string): Uint8Array;
/** base58 encode. Leading `0x00` bytes map to leading `1`s. */
declare function base58Encode(bytes: Uint8Array): string;

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
type SolanaTokenBalance = {
    /** Index into the tx's account keys — the join key between pre and post. */
    accountIndex: number;
    /** SPL mint. Pinned: only balances of `cfg.mint` are ever counted. */
    mint: string;
    /** The wallet that OWNS the token account (not the token account address). */
    owner?: string;
    /** Raw + UI amount; we only trust `.amount` (smallest units, as a string). */
    uiTokenAmount: {
        amount: string;
        decimals?: number;
    };
};
/** Minimal shape of the `getTransaction` result we read (jsonParsed). */
type SolanaTxInfo = {
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
type SolanaReader = {
    /** `null` ⇒ not found / not yet finalized, so the caller retries later. */
    getTransaction(signature: string): Promise<SolanaTxInfo | null>;
    /** Current finalized slot, for the confirmations calculation. */
    getSlot(): Promise<number>;
};
type SolanaPaymentConfig = {
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
/**
 * True for a syntactically valid Solana transaction signature: base58 that
 * decodes to exactly 64 bytes (typically 87–88 chars). CASE-SENSITIVE — Solana
 * base58 is never lowercased. Mirrors Tron's `isTronTxId`.
 */
declare function isValidSolanaSignature(value: string): boolean;
/**
 * Canonical signature form for Solana: the trimmed, case-PRESERVED base58 string
 * — the form the RPC expects and the form we key `used_txhashes` on. Throws on a
 * malformed signature. Mirrors Tron's `normalizeTronTxId` (but never lowercases).
 */
declare function normalizeSolanaSignature(value: string): string;
/** True for a valid Solana address/mint/owner: base58 decoding to 32 bytes. */
declare function isValidSolanaAddress(value: string): boolean;
/**
 * Build a Solana validator bound to one mint / receive owner. `reader` is
 * overridable for tests; in production it is built from `cfg.rpcUrls`.
 */
declare function createSolanaValidator(cfg: SolanaPaymentConfig, reader?: SolanaReader): Validator;

export { type SolanaPaymentConfig, type SolanaReader, type SolanaTokenBalance, type SolanaTxInfo, base58Decode, base58Encode, createSolanaValidator, isValidSolanaAddress, isValidSolanaSignature, normalizeSolanaSignature };
