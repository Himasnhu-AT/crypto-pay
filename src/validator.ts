import { createPublicClient, decodeEventLog, fallback, getAddress, http } from "viem";
import { TRANSFER_EVENT, TRANSFER_TOPIC0 } from "./erc20";
import type { PaymentConfig, ValidateInput, ValidateResult } from "./config";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Minimal structural shape of a transaction receipt — exactly what the pure
 * decision core needs. viem's `TransactionReceipt` satisfies this, and tests
 * can hand-craft one with no network.
 */
export type ReceiptLog = {
  address: string;
  topics: readonly string[];
  data: string;
};
export type MinimalReceipt = {
  status: "success" | "reverted";
  blockNumber: bigint;
  logs: readonly ReceiptLog[];
};

export type EvaluateParams = {
  receipt: MinimalReceipt;
  /** Current chain head, for the confirmations calculation. */
  headBlockNumber: bigint;
  token: { address: `0x${string}` };
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
export function evaluateReceipt(params: EvaluateParams): ValidateResult {
  const { receipt, headBlockNumber, expectedAmount, minConfirmations, txHash } =
    params;

  // A reverted tx moved no funds even though it occupies a block.
  if (receipt.status !== "success") return { ok: false, reason: "reverted" };

  // Normalise the addresses we compare against, once.
  const tokenAddress = getAddress(params.token.address);
  const receiveAddress = getAddress(params.receiveAddress);
  // The required sender is only enforced when requireSender is set. A
  // requireSender call with no sender is a programming error → reject safely.
  let expectedSender: string | null = null;
  if (params.requireSender) {
    if (!params.sender) return { ok: false, reason: "no_matching_transfer" };
    expectedSender = getAddress(params.sender);
  }

  let matched: bigint | null = null;
  for (const log of receipt.logs) {
    // (a) The log MUST be emitted by the canonical token contract. This single
    //     check rejects fake/look-alike tokens that emit their own Transfer
    //     events — the cornerstone of the whole defense.
    let logAddress: string;
    try {
      logAddress = getAddress(log.address);
    } catch {
      continue;
    }
    if (logAddress !== tokenAddress) continue;

    // (b) It MUST be a Transfer event: topic0 match + exactly 3 topics
    //     (sig + indexed `from` + indexed `to`). Anything else from the token
    //     contract (Approval, etc.) is skipped.
    const topic0 = log.topics[0];
    if (!topic0 || topic0.toLowerCase() !== TRANSFER_TOPIC0) continue;
    if (log.topics.length !== 3) continue;

    let decoded;
    try {
      decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
    } catch {
      continue;
    }
    const args = decoded.args as unknown as {
      from?: `0x${string}`;
      to?: `0x${string}`;
      value?: bigint;
    };
    if (!args.from || !args.to || typeof args.value !== "bigint") continue;

    // (c) recipient must be us, (d) sender must be the SIWE-bound wallet.
    let from: string;
    let to: string;
    try {
      from = getAddress(args.from);
      to = getAddress(args.to);
    } catch {
      continue;
    }
    if (to !== receiveAddress) continue;
    if (expectedSender !== null && from !== expectedSender) continue;

    // (e) must cover the price; `>=` lets an accidental overpay through.
    if (args.value < expectedAmount) continue;

    matched = args.value;
    break;
  }

  if (matched === null) return { ok: false, reason: "no_matching_transfer" };

  // (f) finality — guard against a reorg dropping a just-mined block. Clamp to
  // 0: under a reorg or a lagging RPC node the head can sit behind the receipt
  // block, which would otherwise surface a negative count to the caller.
  const confirmations = Math.max(
    0,
    Number(headBlockNumber - receipt.blockNumber + 1n),
  );
  if (confirmations < minConfirmations) {
    return { ok: false, reason: "insufficient_confirmations", confirmations };
  }

  return {
    ok: true,
    amount: matched,
    confirmations,
    blockNumber: receipt.blockNumber,
    txHash,
  };
}

/**
 * The chain-reading surface the validator needs. The real viem PublicClient
 * satisfies this structurally; tests inject a stub so no network is touched.
 */
export type ChainReader = {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<MinimalReceipt>;
  getBlockNumber(): Promise<bigint>;
  getChainId(): Promise<number>;
};

export type Validator = {
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
export function createValidator(
  cfg: PaymentConfig,
  reader?: ChainReader,
): Validator {
  if (!reader && cfg.rpcUrls.length === 0) {
    throw new Error("crypto-pay: at least one rpcUrl is required.");
  }

  const chain: ChainReader =
    reader ??
    (() => {
      const client = createPublicClient({
        chain: cfg.chain,
        transport:
          cfg.rpcUrls.length === 1
            ? http(cfg.rpcUrls[0]!)
            : fallback(cfg.rpcUrls.map((url) => http(url))),
      });
      return {
        getTransactionReceipt: ({ hash }) =>
          client.getTransactionReceipt({ hash }),
        getBlockNumber: () => client.getBlockNumber(),
        getChainId: () => client.getChainId(),
      };
    })();

  // Cache the one-time chain-id self-check (catches an RPC pointed at the
  // wrong network — a deploy misconfiguration, not an attack, but fatal).
  let chainOk: boolean | null = null;
  async function ensureChain(): Promise<boolean> {
    if (chainOk !== null) return chainOk;
    try {
      chainOk = (await chain.getChainId()) === cfg.chain.id;
    } catch {
      chainOk = false;
    }
    return chainOk;
  }

  async function validatePayment(input: ValidateInput): Promise<ValidateResult> {
    if (!TX_HASH_RE.test(input.txHash)) {
      return { ok: false, reason: "bad_tx_hash" };
    }
    if (!(await ensureChain())) return { ok: false, reason: "wrong_chain" };

    let receipt: MinimalReceipt;
    try {
      receipt = await chain.getTransactionReceipt({ hash: input.txHash });
    } catch {
      // Not mined yet, dropped, or unknown to this chain's RPC.
      return { ok: false, reason: "not_found" };
    }

    const headBlockNumber = await chain.getBlockNumber();

    return evaluateReceipt({
      receipt,
      headBlockNumber,
      token: { address: cfg.token.address },
      receiveAddress: cfg.receiveAddress,
      expectedAmount: input.expectedAmount,
      sender: input.sender,
      requireSender: input.requireSender ?? true,
      minConfirmations: cfg.minConfirmations,
      txHash: input.txHash,
    });
  }

  return { validatePayment };
}
