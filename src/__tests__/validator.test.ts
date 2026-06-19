import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, pad } from "viem";
import { arbitrum } from "viem/chains";
import {
  createValidator,
  evaluateReceipt,
  type ChainReader,
  type MinimalReceipt,
} from "../validator";
import { TRANSFER_TOPIC0 } from "../erc20";
import type { PaymentConfig } from "../config";

// ── fixtures ──────────────────────────────────────────────────────────────
const TOKEN = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const; // mainnet USDT
const FAKE_TOKEN = "0x4444444444444444444444444444444444444444" as const;
const RECEIVE = "0x1111111111111111111111111111111111111111" as const;
const SENDER = "0x2222222222222222222222222222222222222222" as const;
const STRANGER = "0x3333333333333333333333333333333333333333" as const;
const TX = ("0x" + "ab".repeat(32)) as `0x${string}`;
const PRICE = 49_000_000n; // 49 USDT @ 6 decimals

// Build a raw ERC-20 Transfer log the way the chain emits it: topic0 + the two
// indexed addresses left-padded to 32 bytes, value in the data word.
function transferLog(
  tokenAddress: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
) {
  return {
    address: tokenAddress,
    topics: [
      TRANSFER_TOPIC0,
      pad(from, { size: 32 }),
      pad(to, { size: 32 }),
    ] as const,
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

function receipt(
  logs: MinimalReceipt["logs"],
  opts: Partial<MinimalReceipt> = {},
): MinimalReceipt {
  return { status: "success", blockNumber: 100n, logs, ...opts };
}

const baseEval = {
  headBlockNumber: 120n, // 21 confirmations over block 100
  token: { address: TOKEN },
  receiveAddress: RECEIVE,
  expectedAmount: PRICE,
  sender: SENDER,
  minConfirmations: 12,
  txHash: TX,
} as const;

// ── evaluateReceipt: the pure decision core ─────────────────────────────────
describe("evaluateReceipt", () => {
  it("accepts an exact, confirmed USDT transfer to us from the bound wallet", () => {
    const res = evaluateReceipt({
      ...baseEval,
      receipt: receipt([transferLog(TOKEN, SENDER, RECEIVE, PRICE)]),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.amount).toBe(PRICE);
      expect(res.confirmations).toBe(21);
      expect(res.blockNumber).toBe(100n);
      expect(res.txHash).toBe(TX);
    }
  });

  it("accepts an overpayment (value > expected)", () => {
    const res = evaluateReceipt({
      ...baseEval,
      receipt: receipt([transferLog(TOKEN, SENDER, RECEIVE, PRICE + 1_000_000n)]),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.amount).toBe(PRICE + 1_000_000n);
  });

  it("rejects an underpayment", () => {
    const res = evaluateReceipt({
      ...baseEval,
      receipt: receipt([transferLog(TOKEN, SENDER, RECEIVE, PRICE - 1n)]),
    });
    expect(res).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("rejects a reverted transaction", () => {
    const res = evaluateReceipt({
      ...baseEval,
      receipt: receipt([transferLog(TOKEN, SENDER, RECEIVE, PRICE)], {
        status: "reverted",
      }),
    });
    expect(res).toEqual({ ok: false, reason: "reverted" });
  });

  it("rejects a transfer to the wrong recipient", () => {
    const res = evaluateReceipt({
      ...baseEval,
      receipt: receipt([transferLog(TOKEN, SENDER, STRANGER, PRICE)]),
    });
    expect(res).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("rejects a transfer from a wallet other than the bound sender (replay defense)", () => {
    // A stranger's real, valid USDT transfer to us — replayed by an attacker.
    const res = evaluateReceipt({
      ...baseEval,
      receipt: receipt([transferLog(TOKEN, STRANGER, RECEIVE, PRICE)]),
    });
    expect(res).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("rejects a Transfer emitted by a spoofed/look-alike token contract", () => {
    // Correct from/to/value, but the log came from a fake token, not USDT.
    const res = evaluateReceipt({
      ...baseEval,
      receipt: receipt([transferLog(FAKE_TOKEN, SENDER, RECEIVE, PRICE)]),
    });
    expect(res).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("rejects when there are too few confirmations, and reports the count", () => {
    const res = evaluateReceipt({
      ...baseEval,
      headBlockNumber: 105n, // 6 confirmations, below the 12 required
      receipt: receipt([transferLog(TOKEN, SENDER, RECEIVE, PRICE)]),
    });
    expect(res).toEqual({
      ok: false,
      reason: "insufficient_confirmations",
      confirmations: 6,
    });
  });

  it("clamps confirmations to 0 when the head lags behind the receipt block", () => {
    // Reorg / lagging RPC node: head (95) is behind the receipt block (100).
    const res = evaluateReceipt({
      ...baseEval,
      headBlockNumber: 95n,
      receipt: receipt([transferLog(TOKEN, SENDER, RECEIVE, PRICE)]),
    });
    expect(res).toEqual({
      ok: false,
      reason: "insufficient_confirmations",
      confirmations: 0,
    });
  });

  it("finds the correct transfer among unrelated logs", () => {
    const noise1 = transferLog(FAKE_TOKEN, SENDER, RECEIVE, PRICE); // wrong token
    const noise2 = transferLog(TOKEN, STRANGER, STRANGER, 999n); // unrelated
    const good = transferLog(TOKEN, SENDER, RECEIVE, PRICE);
    const res = evaluateReceipt({
      ...baseEval,
      receipt: receipt([noise1, noise2, good]),
    });
    expect(res.ok).toBe(true);
  });

  it("skips a non-Transfer event emitted by the token contract", () => {
    const bogus = {
      address: TOKEN,
      // a different topic0 (not Transfer) — must be ignored before decoding
      topics: [("0x" + "cd".repeat(32)) as `0x${string}`],
      data: "0x" as `0x${string}`,
    };
    const res = evaluateReceipt({ ...baseEval, receipt: receipt([bogus]) });
    expect(res).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("matches addresses case-insensitively (checksum-agnostic)", () => {
    const res = evaluateReceipt({
      ...baseEval,
      token: { address: TOKEN.toLowerCase() as `0x${string}` },
      receiveAddress: RECEIVE.toLowerCase() as `0x${string}`,
      sender: SENDER.toLowerCase() as `0x${string}`,
      receipt: receipt([transferLog(TOKEN, SENDER, RECEIVE, PRICE)]),
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a receipt with no logs at all", () => {
    const res = evaluateReceipt({ ...baseEval, receipt: receipt([]) });
    expect(res).toEqual({ ok: false, reason: "no_matching_transfer" });
  });
});

// ── createValidator: the chain-I/O wrapper ──────────────────────────────────
function stubReader(over: Partial<ChainReader> = {}): ChainReader {
  return {
    getChainId: async () => arbitrum.id,
    getBlockNumber: async () => 120n,
    getTransactionReceipt: async () =>
      receipt([transferLog(TOKEN, SENDER, RECEIVE, PRICE)]),
    ...over,
  };
}

const cfg: PaymentConfig = {
  chain: arbitrum,
  rpcUrls: ["https://example.invalid"],
  token: { address: TOKEN, decimals: 6, symbol: "USDT" },
  receiveAddress: RECEIVE,
  minConfirmations: 12,
};

describe("createValidator", () => {
  it("rejects a malformed tx hash without touching the chain", async () => {
    const getChainId = vi.fn(async () => arbitrum.id);
    const v = createValidator(cfg, stubReader({ getChainId }));
    const res = await v.validatePayment({
      txHash: "0x123" as `0x${string}`,
      expectedAmount: PRICE,
      sender: SENDER,
    });
    expect(res).toEqual({ ok: false, reason: "bad_tx_hash" });
    expect(getChainId).not.toHaveBeenCalled();
  });

  it("rejects when the RPC is on the wrong chain", async () => {
    const v = createValidator(cfg, stubReader({ getChainId: async () => 999 }));
    const res = await v.validatePayment({
      txHash: TX,
      expectedAmount: PRICE,
      sender: SENDER,
    });
    expect(res).toEqual({ ok: false, reason: "wrong_chain" });
  });

  it("returns not_found when the receipt is missing (pending/dropped)", async () => {
    const v = createValidator(
      cfg,
      stubReader({
        getTransactionReceipt: async () => {
          throw new Error("TransactionReceiptNotFoundError");
        },
      }),
    );
    const res = await v.validatePayment({
      txHash: TX,
      expectedAmount: PRICE,
      sender: SENDER,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("validates a real-shaped receipt end to end", async () => {
    const v = createValidator(cfg, stubReader());
    const res = await v.validatePayment({
      txHash: TX,
      expectedAmount: PRICE,
      sender: SENDER,
    });
    expect(res.ok).toBe(true);
  });

  it("only checks the chain id once across calls", async () => {
    const getChainId = vi.fn(async () => arbitrum.id);
    const v = createValidator(cfg, stubReader({ getChainId }));
    await v.validatePayment({ txHash: TX, expectedAmount: PRICE, sender: SENDER });
    await v.validatePayment({ txHash: TX, expectedAmount: PRICE, sender: SENDER });
    expect(getChainId).toHaveBeenCalledTimes(1);
  });

  it("throws if built with no rpc urls and no injected reader", () => {
    expect(() => createValidator({ ...cfg, rpcUrls: [] })).toThrow(/rpcUrl/);
  });
});
