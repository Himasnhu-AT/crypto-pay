import { Chain } from 'viem';

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
     * The wallet the payer is known to control. When `requireSender` is true (the
     * default), the transfer's `from` must equal this — that's what stops someone
     * claiming a stranger's txHash. Omit only with `requireSender: false`.
     */
    sender?: `0x${string}`;
    /**
     * Whether to enforce `from === sender`. Default `true`. Set `false` for a
     * manual, human-reviewed flow where the sender isn't proven — the result then
     * only confirms "this tx paid us >= price", and a human / single-use-txHash
     * guard provides attribution.
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

export { type ChainReader as C, type EvaluateParams as E, type MinimalReceipt as M, type PaymentConfig as P, type ReceiptLog as R, type TokenSpec as T, type ValidateInput as V, type ValidateReason as a, type ValidateResult as b, type Validator as c, createValidator as d, evaluateReceipt as e };
