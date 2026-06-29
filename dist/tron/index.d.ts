import { c as Validator, M as MinimalReceipt } from '../validator-Bdhe622R.js';
import 'viem';

/**
 * Decode a Tron base58check address (`T…`) to its 20-byte EVM-equivalent
 * address (`0x…`). Verifies the base58check checksum and the `0x41` version
 * byte, so a typo in configured env addresses fails loud at config time rather
 * than silently routing to the wrong address.
 */
declare function tronBase58ToEvmAddress(base58: string): `0x${string}`;
/**
 * A Tron 41-prefixed hex address (e.g. `41a614…`, optionally `0x`-prefixed) →
 * 20-byte EVM hex. Used when a contract/address comes in hex rather than
 * base58, including the addresses TronGrid returns inside event logs.
 */
declare function tronHexToEvmAddress(hex: string): `0x${string}`;
/**
 * 20-byte EVM hex (`0x…`, or bare 40-hex) → Tron base58check address (`T…`).
 * The inverse of {@link tronBase58ToEvmAddress}; handy for displaying/validating
 * our own receive address in the EVM form some tools surface.
 */
declare function evmAddressToTronBase58(hex: string): string;
/** True for a 64-hex Tron tx-id (with or without a `0x` prefix). */
declare function isTronTxId(value: string): boolean;
/**
 * Canonical tx-id form for Tron: lowercase 64-hex with NO `0x` prefix — the form
 * TronGrid expects in request bodies and the form we key `used_txhashes` on.
 * Throws on a malformed id.
 */
declare function normalizeTronTxId(value: string): string;

/**
 * Tron (TRC-20) payment validation. Mirrors the EVM `createValidator` surface
 * (same `Validator` interface, same `ValidateResult`) but reads Tron over the
 * TronGrid HTTP API instead of JSON-RPC and decodes Tron's address/log encoding.
 *
 * The actual decision — token-contract pin, recipient match, optional sender
 * pin, amount, confirmations — is delegated to the SAME pure `evaluateReceipt`
 * core the EVM path uses, because a TRC-20 `Transfer` log decodes identically to
 * ERC-20 once addresses are normalised to their 20-byte EVM form.
 *
 * Finality: we read the **solidity** node (`/walletsolidity/*`), which only
 * surfaces a transaction once its block is irreversible under Tron's BFT
 * finality. So `minConfirmations` can be as low as 1 — appearing there *is*
 * finality — though it stays configurable.
 *
 * Node-only (uses `fetch` against TronGrid). The repo's payment routes already
 * run on the Node.js runtime.
 */
type TronTokenSpec = {
    /** USDT TRC-20 contract as base58 (`T…`). Pinned: only its Transfer logs count. */
    addressBase58: string;
    /** Token decimals. USDT-TRC20 is 6. */
    decimals: number;
    symbol: string;
};
type TronPaymentConfig = {
    /**
     * TronGrid base URLs, tried in order. Use the mainnet `https://api.trongrid.io`
     * (and a keyed backup). The validator calls the `/walletsolidity/*` endpoints.
     */
    apiUrls: string[];
    /** Optional `TRON-PRO-API-KEY` for higher TronGrid rate limits. */
    apiKey?: string;
    token: TronTokenSpec;
    /** Our receiving wallet as base58 (`T…`). */
    receiveAddressBase58: string;
    /** Irreversible-block confirmations required. Default-safe at 1 on the solidity node. */
    minConfirmations: number;
};
/** A single decoded event log from TronGrid `gettransactioninfobyid`. */
type TronTxLog = {
    /**
     * Contract address as TronGrid returns it: hex, no `0x`. Typically the 20-byte
     * EVM body (40 hex), but some nodes/responses return the 41-prefixed Tron form
     * (42 hex). `tronHexToEvmAddress` normalises BOTH to the 20-byte EVM body.
     */
    address: string;
    /** Hex (no `0x`); `topics[0]` is the Transfer signature, then indexed from/to. */
    topics?: string[];
    data?: string;
};
/** Minimal shape of the TronGrid `gettransactioninfobyid` response we read. */
type TronTxInfo = {
    id?: string;
    blockNumber?: number;
    receipt?: {
        result?: string;
    };
    /** Top-level `result` is omitted on success, `"FAILED"` on failure. */
    result?: string;
    log?: TronTxLog[];
};
/**
 * The chain-reading surface the Tron validator needs. The production reader hits
 * TronGrid; tests inject a stub so no network is touched (mirrors EVM's
 * `ChainReader`).
 */
type TronReader = {
    /** Empty object (no `blockNumber`) means not found / not yet irreversible. */
    getTransactionInfoById(txId: string): Promise<TronTxInfo>;
    getNowBlockNumber(): Promise<number>;
};
/**
 * Normalise a raw TronGrid tx-info into the EVM-shaped `MinimalReceipt` the pure
 * core understands: success flag, block number, and logs whose address/topics/
 * data carry a `0x` prefix and whose addresses are the 20-byte EVM form.
 */
declare function tronInfoToReceipt(info: TronTxInfo): MinimalReceipt;
/**
 * Build a Tron validator bound to one token / receiver. `reader` is overridable
 * for tests; in production it is built from `cfg.apiUrls`.
 */
declare function createTronValidator(cfg: TronPaymentConfig, reader?: TronReader): Validator;

export { type TronPaymentConfig, type TronReader, type TronTokenSpec, type TronTxInfo, type TronTxLog, createTronValidator, evmAddressToTronBase58, isTronTxId, normalizeTronTxId, tronBase58ToEvmAddress, tronHexToEvmAddress, tronInfoToReceipt };
