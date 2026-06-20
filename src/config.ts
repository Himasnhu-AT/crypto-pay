import type { Chain } from "viem";

export type TokenSpec = {
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

export type PaymentConfig = {
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

export type ValidateInput = {
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

export type ValidateReason =
  | "bad_tx_hash"
  | "not_found"
  | "wrong_chain"
  | "reverted"
  | "no_matching_transfer"
  | "insufficient_confirmations";

export type ValidateResult =
  | {
      ok: true;
      /** The matched transfer value in smallest units (>= expectedAmount). */
      amount: bigint;
      confirmations: number;
      blockNumber: bigint;
      txHash: `0x${string}`;
    }
  | { ok: false; reason: ValidateReason; confirmations?: number };
