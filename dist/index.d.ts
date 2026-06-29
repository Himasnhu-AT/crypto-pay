export { C as ChainReader, E as EvaluateParams, M as MinimalReceipt, P as PaymentConfig, R as ReceiptLog, T as TokenSpec, V as ValidateInput, a as ValidateReason, b as ValidateResult, c as Validator, d as createValidator, e as evaluateReceipt } from './validator-Bdhe622R.js';
import 'viem';

/**
 * Human decimal string → smallest-unit bigint, given the token's decimals.
 * e.g. toSmallestUnit("49", 6) === 49_000000n for 6-decimal USDT/USDC.
 * Always work in smallest units when comparing amounts — never floats.
 */
declare function toSmallestUnit(human: string, decimals: number): bigint;
/**
 * Smallest-unit bigint → human decimal string, given the token's decimals.
 * For display only — never round-trip through this for comparisons.
 */
declare function fromSmallestUnit(value: bigint, decimals: number): string;

/**
 * The canonical ERC-20 `Transfer` event. Every compliant token — including
 * USDT and USDC on every chain — emits exactly this on a transfer. Validation
 * keys off this event, not off the token's `transfer()` return value (USDT on
 * Ethereum mainnet famously returns no bool), so it works uniformly everywhere.
 */
declare const TRANSFER_EVENT: {
    readonly name: "Transfer";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "to";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "value";
    }];
};
/**
 * `keccak256("Transfer(address,address,uint256)")` — the topic0 of a Transfer
 * log. Hardcoded (not computed at runtime) so it is auditable at a glance and
 * costs nothing on the hot path. Used as a cheap pre-filter before decoding.
 */
declare const TRANSFER_TOPIC0: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export { TRANSFER_EVENT, TRANSFER_TOPIC0, fromSmallestUnit, toSmallestUnit };
