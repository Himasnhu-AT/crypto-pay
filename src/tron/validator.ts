import { evaluateReceipt, type MinimalReceipt, type Validator } from "../validator";
import type { ValidateInput, ValidateResult } from "../config";
import {
  isTronTxId,
  normalizeTronTxId,
  tronBase58ToEvmAddress,
  tronHexToEvmAddress,
} from "./address";

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

export type TronTokenSpec = {
  /** USDT TRC-20 contract as base58 (`T…`). Pinned: only its Transfer logs count. */
  addressBase58: string;
  /** Token decimals. USDT-TRC20 is 6. */
  decimals: number;
  symbol: string;
};

export type TronPaymentConfig = {
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
export type TronTxLog = {
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
export type TronTxInfo = {
  id?: string;
  blockNumber?: number;
  receipt?: { result?: string };
  /** Top-level `result` is omitted on success, `"FAILED"` on failure. */
  result?: string;
  log?: TronTxLog[];
};

/**
 * The chain-reading surface the Tron validator needs. The production reader hits
 * TronGrid; tests inject a stub so no network is touched (mirrors EVM's
 * `ChainReader`).
 */
export type TronReader = {
  /** Empty object (no `blockNumber`) means not found / not yet irreversible. */
  getTransactionInfoById(txId: string): Promise<TronTxInfo>;
  getNowBlockNumber(): Promise<number>;
};

function with0x(hex: string): `0x${string}` {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return `0x${h}`;
}

/**
 * Normalise a raw TronGrid tx-info into the EVM-shaped `MinimalReceipt` the pure
 * core understands: success flag, block number, and logs whose address/topics/
 * data carry a `0x` prefix and whose addresses are the 20-byte EVM form.
 */
export function tronInfoToReceipt(info: TronTxInfo): MinimalReceipt {
  // Deliberately strict + fail-safe. A TRC-20 transfer is always a
  // TriggerSmartContract whose `receipt.result` is "SUCCESS" on success; anything
  // else — an explicit "FAILED"/"REVERT", or a missing field — maps to
  // "reverted". We never credit on an ambiguous receipt, and we do NOT loosen
  // this to "treat absent as success" (that would weaken the money path): the
  // binding guard remains the pinned-token Transfer-log scan in evaluateReceipt,
  // which a reverted tx never emits.
  const status: MinimalReceipt["status"] =
    info.receipt?.result === "SUCCESS" ? "success" : "reverted";
  const logs = (info.log ?? []).map((l) => ({
    address: tronHexToEvmAddress(l.address),
    topics: (l.topics ?? []).map(with0x),
    data: with0x(l.data ?? ""),
  }));
  return {
    status,
    blockNumber: BigInt(info.blockNumber ?? 0),
    logs,
  };
}

/** Production reader: TronGrid solidity-node reads with URL fallback + API key. */
function httpTronReader(cfg: TronPaymentConfig): TronReader {
  async function post(path: string, body: unknown): Promise<unknown> {
    let lastErr: unknown;
    for (const base of cfg.apiUrls) {
      try {
        const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(cfg.apiKey ? { "TRON-PRO-API-KEY": cfg.apiKey } : {}),
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`TronGrid ${path} HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`TronGrid ${path} failed`);
  }

  return {
    async getTransactionInfoById(txId) {
      return (await post("/walletsolidity/gettransactioninfobyid", {
        value: txId,
      })) as TronTxInfo;
    },
    async getNowBlockNumber() {
      const block = (await post("/walletsolidity/getnowblock", {})) as {
        block_header?: { raw_data?: { number?: number } };
      };
      const n = block?.block_header?.raw_data?.number;
      if (typeof n !== "number") {
        throw new Error("TronGrid getnowblock: missing block number");
      }
      return n;
    },
  };
}

/**
 * Build a Tron validator bound to one token / receiver. `reader` is overridable
 * for tests; in production it is built from `cfg.apiUrls`.
 */
export function createTronValidator(
  cfg: TronPaymentConfig,
  reader?: TronReader,
): Validator {
  if (!reader && cfg.apiUrls.length === 0) {
    throw new Error("crypto-pay/tron: at least one apiUrl is required.");
  }
  const chain = reader ?? httpTronReader(cfg);

  // Convert the configured base58 addresses to their 20-byte EVM form once.
  // Throws loudly here (at construction) on a malformed/typo'd config address.
  const tokenAddress = tronBase58ToEvmAddress(cfg.token.addressBase58);
  const receiveAddress = tronBase58ToEvmAddress(cfg.receiveAddressBase58);

  async function validatePayment(input: ValidateInput): Promise<ValidateResult> {
    if (typeof input.txHash !== "string" || !isTronTxId(input.txHash)) {
      return { ok: false, reason: "bad_tx_hash" };
    }
    const txId = normalizeTronTxId(input.txHash);

    let info: TronTxInfo;
    try {
      info = await chain.getTransactionInfoById(txId);
    } catch {
      return { ok: false, reason: "not_found" };
    }
    // No block number ⇒ unknown to the solidity node = not mined / not yet
    // irreversible. Treat as not_found so the caller retries later.
    if (!info || info.blockNumber === undefined || info.blockNumber === null) {
      return { ok: false, reason: "not_found" };
    }

    const headBlockNumber = BigInt(await chain.getNowBlockNumber());

    // Forward-compat: a Tron-bound sender may arrive as base58; the EVM/manual
    // path passes none. Convert so `evaluateReceipt` compares like-for-like.
    let sender: `0x${string}` | undefined;
    if (input.sender) {
      sender = input.sender.startsWith("0x")
        ? input.sender
        : tronBase58ToEvmAddress(input.sender);
    }

    return evaluateReceipt({
      receipt: tronInfoToReceipt(info),
      headBlockNumber,
      token: { address: tokenAddress },
      receiveAddress,
      expectedAmount: input.expectedAmount,
      sender,
      requireSender: input.requireSender ?? true,
      minConfirmations: cfg.minConfirmations,
      txHash: with0x(txId),
    });
  }

  return { validatePayment };
}
