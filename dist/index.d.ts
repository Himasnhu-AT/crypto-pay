import { Chain } from 'viem';
export { createSiweMessage, generateSiweNonce, parseSiweMessage } from 'viem/siwe';

type TokenSpec = {
    /**
     * Canonical token contract address on `chain`. This is the single most
     * important anti-spoofing pin: only `Transfer` logs emitted BY this exact
     * contract are ever counted. A worthless look-alike token that emits its own
     * Transfer event is ignored because its `log.address` won't match.
     */
    address: `0x${string}`;
    /** Token decimals. USDT/USDC are 6 on most chains, but 18 on BSC. Per-chain. */
    decimals: number;
    /** Display symbol, e.g. "USDT". Not used in validation. */
    symbol: string;
};
type PaymentConfig = {
    /** viem chain object. The read client is pinned to this chain. */
    chain: Chain;
    /**
     * RPC URLs tried in order via viem `fallback()`. Put the public RPC first and
     * keyed providers (Alchemy/Infura) after it as backups. Read-only — these
     * never hold funds and take no fee; they are infra, not a payment processor.
     */
    rpcUrls: string[];
    token: TokenSpec;
    /** Our wallet address that the transfer must pay. */
    receiveAddress: `0x${string}`;
    /** Block confirmations required before a payment is treated as final. */
    minConfirmations: number;
};
type ValidateInput = {
    txHash: `0x${string}`;
    /**
     * Required amount in smallest units (see toSmallestUnit). The on-chain
     * transfer value must be `>=` this — overpay passes, underpay fails.
     */
    expectedAmount: bigint;
    /**
     * The wallet the user proved they own (via SIWE). When `requireSender` is
     * true (the default), the transfer's `from` must equal this — that's what
     * stops someone claiming a stranger's txHash. Omit only with
     * `requireSender: false`.
     */
    sender?: `0x${string}`;
    /**
     * Whether to enforce `from === sender`. Default `true` (the connected/SIWE
     * flow). Set `false` for a manual, human-reviewed flow where the sender
     * isn't proven — the result then only confirms "this tx paid us >= price",
     * and a human / single-use-txHash guard provides attribution.
     */
    requireSender?: boolean;
};
type ValidateReason = "bad_tx_hash" | "not_found" | "wrong_chain" | "reverted" | "no_matching_transfer" | "insufficient_confirmations";
type ValidateResult = {
    ok: true;
    /** The matched transfer value in smallest units (>= expectedAmount). */
    amount: bigint;
    confirmations: number;
    blockNumber: bigint;
    txHash: `0x${string}`;
} | {
    ok: false;
    reason: ValidateReason;
    confirmations?: number;
};

/**
 * Minimal structural shape of a transaction receipt — exactly what the pure
 * decision core needs. viem's `TransactionReceipt` satisfies this, and tests
 * can hand-craft one with no network.
 */
type ReceiptLog = {
    address: string;
    topics: readonly string[];
    data: string;
};
type MinimalReceipt = {
    status: "success" | "reverted";
    blockNumber: bigint;
    logs: readonly ReceiptLog[];
};
type EvaluateParams = {
    receipt: MinimalReceipt;
    /** Current chain head, for the confirmations calculation. */
    headBlockNumber: bigint;
    token: {
        address: `0x${string}`;
    };
    receiveAddress: `0x${string}`;
    expectedAmount: bigint;
    /** Required when `requireSender` is true; ignored otherwise. */
    sender?: `0x${string}`;
    /** Enforce `from === sender`. Default true at the createValidator layer. */
    requireSender: boolean;
    minConfirmations: number;
    txHash: `0x${string}`;
};
/**
 * PURE decision core — no I/O, no clock, no Firebase. Given an already-fetched
 * receipt and the current head block, decide whether it represents a valid
 * payment. EVERY security check lives here so the whole policy is unit-testable
 * deterministically with crafted receipts.
 *
 * Order matters: cheap rejections first, decode last.
 */
declare function evaluateReceipt(params: EvaluateParams): ValidateResult;
/**
 * The chain-reading surface the validator needs. The real viem PublicClient
 * satisfies this structurally; tests inject a stub so no network is touched.
 */
type ChainReader = {
    getTransactionReceipt(args: {
        hash: `0x${string}`;
    }): Promise<MinimalReceipt>;
    getBlockNumber(): Promise<bigint>;
    getChainId(): Promise<number>;
};
type Validator = {
    validatePayment(input: ValidateInput): Promise<ValidateResult>;
};
/**
 * Build a validator bound to one chain / token / receiver. It performs the
 * chain I/O (fetch receipt, head, chain id) and delegates the entire decision
 * to the pure `evaluateReceipt`.
 *
 * @param reader optional override of the chain-reading surface — used by tests.
 *               In production it is built from `cfg.rpcUrls` via viem.
 */
declare function createValidator(cfg: PaymentConfig, reader?: ChainReader): Validator;

type VerifySiweParams = {
    /** The full EIP-4361 message the user signed. */
    message: string;
    /** The signature returned by the wallet (personal_sign). */
    signature: `0x${string}`;
    /** The wallet address the user claims to control. */
    address: `0x${string}`;
    /** Expected domain (the site host) — anti cross-site replay. */
    domain: string;
    /** The single-use nonce WE issued for this uid. */
    nonce: string;
    /** Chain id the message must be scoped to. */
    chainId: number;
    /**
     * Optional current time (ms) to enforce the message's own
     * expirationTime / notBefore. Omit to skip time checks — the server's
     * single-use nonce TTL is the primary freshness guarantee.
     */
    now?: number;
};
/**
 * Verify a SIWE (EIP-4361) message + signature for an EOA wallet (MetaMask).
 *
 * Pure: recovers the signer locally with no RPC call. Returns true only if the
 * signature is valid AND the message's address / domain / nonce / chainId match
 * exactly what we issued. Binding all four is what prevents a signature minted
 * for another site, another user, or another chain from being replayed here.
 *
 * Smart-contract (ERC-1271 / ERC-6492) wallets are out of scope — EOA only.
 */
declare function verifySiwe(params: VerifySiweParams): Promise<boolean>;

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

export { type ChainReader, type EvaluateParams, type MinimalReceipt, type PaymentConfig, type ReceiptLog, TRANSFER_EVENT, TRANSFER_TOPIC0, type TokenSpec, type ValidateInput, type ValidateReason, type ValidateResult, type Validator, type VerifySiweParams, createValidator, evaluateReceipt, fromSmallestUnit, toSmallestUnit, verifySiwe };
