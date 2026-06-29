import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, pad } from "viem";
import { TRANSFER_TOPIC0 } from "../erc20";
import {
  createTronValidator,
  tronInfoToReceipt,
  type TronReader,
  type TronTxInfo,
} from "../tron";
import {
  evmAddressToTronBase58,
  isTronTxId,
  normalizeTronTxId,
  tronBase58ToEvmAddress,
} from "../tron";

// ── fixtures ────────────────────────────────────────────────────────────────
// Real USDT-TRC20 contract and its known EVM-form (20-byte) address.
const USDT_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_EVM = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c" as const;

const RECEIVE_EVM = "0x1111111111111111111111111111111111111111" as const;
const SENDER_EVM = "0x2222222222222222222222222222222222222222" as const;
const STRANGER_EVM = "0x3333333333333333333333333333333333333333" as const;
const FAKE_TOKEN_EVM = "0x4444444444444444444444444444444444444444" as const;

const RECEIVE_BASE58 = evmAddressToTronBase58(RECEIVE_EVM);
const TXID = "ab".repeat(32); // 64 hex, no 0x — Tron tx-id form
const PRICE = 49_000_000n; // 49 USDT @ 6 decimals

const strip0x = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

// Build a TRC-20 Transfer log the way TronGrid returns it: addresses/topics/data
// are bare hex (no 0x), the log address is the 20-byte EVM body (no 41 prefix).
function tronTransferLog(
  tokenEvm: string,
  fromEvm: `0x${string}`,
  toEvm: `0x${string}`,
  value: bigint,
) {
  return {
    address: strip0x(tokenEvm),
    topics: [
      strip0x(TRANSFER_TOPIC0),
      strip0x(pad(fromEvm, { size: 32 })),
      strip0x(pad(toEvm, { size: 32 })),
    ],
    data: strip0x(encodeAbiParameters([{ type: "uint256" }], [value])),
  };
}

function tronInfo(
  logs: TronTxInfo["log"],
  opts: Partial<TronTxInfo> = {},
): TronTxInfo {
  return {
    id: TXID,
    blockNumber: 100,
    receipt: { result: "SUCCESS" },
    log: logs,
    ...opts,
  };
}

function stubReader(over: Partial<TronReader> = {}): TronReader {
  return {
    getTransactionInfoById: async () =>
      tronInfo([tronTransferLog(USDT_EVM, SENDER_EVM, RECEIVE_EVM, PRICE)]),
    getNowBlockNumber: async () => 120, // 21 confirmations over block 100
    ...over,
  };
}

const cfg = {
  apiUrls: ["https://api.invalid"],
  token: { addressBase58: USDT_BASE58, decimals: 6, symbol: "USDT" },
  receiveAddressBase58: RECEIVE_BASE58,
  minConfirmations: 12,
};

// ── address codec ───────────────────────────────────────────────────────────
describe("tron address codec", () => {
  it("decodes the real USDT base58 contract to its known EVM address", () => {
    expect(tronBase58ToEvmAddress(USDT_BASE58)).toBe(USDT_EVM);
  });

  it("round-trips EVM ⇄ base58", () => {
    expect(evmAddressToTronBase58(USDT_EVM)).toBe(USDT_BASE58);
    expect(tronBase58ToEvmAddress(RECEIVE_BASE58)).toBe(RECEIVE_EVM);
  });

  it("rejects a checksum-corrupted address", () => {
    const bad = USDT_BASE58.slice(0, -1) + (USDT_BASE58.endsWith("t") ? "u" : "t");
    expect(() => tronBase58ToEvmAddress(bad)).toThrow(/checksum|length|base58/i);
  });

  it("validates and normalises tx-ids (with/without 0x, any case)", () => {
    expect(isTronTxId(TXID)).toBe(true);
    expect(isTronTxId("0x" + TXID.toUpperCase())).toBe(true);
    expect(isTronTxId("xyz")).toBe(false);
    expect(normalizeTronTxId("0x" + TXID.toUpperCase())).toBe(TXID);
  });
});

// ── createTronValidator ─────────────────────────────────────────────────────
describe("createTronValidator", () => {
  it("accepts a confirmed USDT-TRC20 transfer to us (manual / any sender)", async () => {
    const v = createTronValidator(cfg, stubReader());
    const res = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.amount).toBe(PRICE);
      expect(res.confirmations).toBe(21);
      expect(res.blockNumber).toBe(100n);
    }
  });

  it("accepts an overpayment", async () => {
    const v = createTronValidator(
      cfg,
      stubReader({
        getTransactionInfoById: async () =>
          tronInfo([
            tronTransferLog(USDT_EVM, SENDER_EVM, RECEIVE_EVM, PRICE + 5n),
          ]),
      }),
    );
    const res = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a spoofed/look-alike token contract", async () => {
    const v = createTronValidator(
      cfg,
      stubReader({
        getTransactionInfoById: async () =>
          tronInfo([
            tronTransferLog(FAKE_TOKEN_EVM, SENDER_EVM, RECEIVE_EVM, PRICE),
          ]),
      }),
    );
    const res = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("rejects a transfer to the wrong recipient", async () => {
    const v = createTronValidator(
      cfg,
      stubReader({
        getTransactionInfoById: async () =>
          tronInfo([
            tronTransferLog(USDT_EVM, SENDER_EVM, STRANGER_EVM, PRICE),
          ]),
      }),
    );
    const res = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("rejects an underpayment", async () => {
    const v = createTronValidator(
      cfg,
      stubReader({
        getTransactionInfoById: async () =>
          tronInfo([
            tronTransferLog(USDT_EVM, SENDER_EVM, RECEIVE_EVM, PRICE - 1n),
          ]),
      }),
    );
    const res = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("rejects a failed (non-SUCCESS) transaction", async () => {
    const v = createTronValidator(
      cfg,
      stubReader({
        getTransactionInfoById: async () =>
          tronInfo([tronTransferLog(USDT_EVM, SENDER_EVM, RECEIVE_EVM, PRICE)], {
            receipt: { result: "REVERT" },
            result: "FAILED",
          }),
      }),
    );
    const res = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "reverted" });
  });

  it("returns not_found when the solidity node doesn't know the tx yet", async () => {
    const v = createTronValidator(
      cfg,
      stubReader({ getTransactionInfoById: async () => ({}) }),
    );
    const res = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found when the reader throws (network/HTTP error)", async () => {
    const v = createTronValidator(
      cfg,
      stubReader({
        getTransactionInfoById: async () => {
          throw new Error("HTTP 500");
        },
      }),
    );
    const res = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects a malformed tx-id without touching the chain", async () => {
    const getTransactionInfoById = vi.fn(async () => tronInfo([]));
    const v = createTronValidator(cfg, stubReader({ getTransactionInfoById }));
    const res = await v.validatePayment({
      txHash: "not-a-hash" as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "bad_tx_hash" });
    expect(getTransactionInfoById).not.toHaveBeenCalled();
  });

  it("enforces the sender pin when requireSender is true (forward-compat)", async () => {
    const v = createTronValidator(cfg, stubReader());
    const ok = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      sender: SENDER_EVM,
      requireSender: true,
    });
    expect(ok.ok).toBe(true);

    const bad = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      sender: STRANGER_EVM,
      requireSender: true,
    });
    expect(bad).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("rejects too few confirmations and reports the count", async () => {
    const v = createTronValidator(
      cfg,
      stubReader({ getNowBlockNumber: async () => 105 }), // 6 confs, below 12
    );
    const res = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({
      ok: false,
      reason: "insufficient_confirmations",
      confirmations: 6,
    });
  });

  it("matches when the log address is the 41-prefixed (42-hex) TronGrid form", async () => {
    // The production shape some TronGrid nodes emit: log.address carries the
    // Tron 0x41 version byte. The decoder must strip it and still match.
    const v = createTronValidator(
      cfg,
      stubReader({
        getTransactionInfoById: async () => {
          const log = tronTransferLog(USDT_EVM, SENDER_EVM, RECEIVE_EVM, PRICE);
          return tronInfo([{ ...log, address: "41" + log.address }]);
        },
      }),
    );
    const res = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res.ok).toBe(true);
  });

  it("tolerates 0x-prefixed topics/data from the reader", async () => {
    const v = createTronValidator(
      cfg,
      stubReader({
        getTransactionInfoById: async () => {
          const log = tronTransferLog(USDT_EVM, SENDER_EVM, RECEIVE_EVM, PRICE);
          return tronInfo([
            {
              address: log.address,
              topics: log.topics.map((t) => "0x" + t),
              data: "0x" + log.data,
            },
          ]);
        },
      }),
    );
    const res = await v.validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res.ok).toBe(true);
  });

  it("throws at construction on a typo'd config address", () => {
    expect(() =>
      createTronValidator(
        { ...cfg, receiveAddressBase58: "Tnot-a-real-address" },
        stubReader(),
      ),
    ).toThrow();
  });

  it("throws if built with no apiUrls and no injected reader", () => {
    expect(() => createTronValidator({ ...cfg, apiUrls: [] })).toThrow(/apiUrl/);
  });
});

// ── normaliser (pure) ───────────────────────────────────────────────────────
describe("tronInfoToReceipt", () => {
  it("maps SUCCESS → success and 0x-prefixes the log fields", () => {
    const r = tronInfoToReceipt(
      tronInfo([tronTransferLog(USDT_EVM, SENDER_EVM, RECEIVE_EVM, PRICE)]),
    );
    expect(r.status).toBe("success");
    expect(r.blockNumber).toBe(100n);
    expect(r.logs[0]!.address.startsWith("0x")).toBe(true);
    expect(r.logs[0]!.topics[0]!.startsWith("0x")).toBe(true);
  });
});
