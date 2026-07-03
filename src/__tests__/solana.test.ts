import { describe, expect, it, vi } from "vitest";
import {
  createSolanaValidator,
  isValidSolanaAddress,
  isValidSolanaSignature,
  normalizeSolanaSignature,
  base58Decode,
  base58Encode,
  type SolanaReader,
  type SolanaTokenBalance,
  type SolanaTxInfo,
} from "../solana";

// ── fixtures ────────────────────────────────────────────────────────────────
// Real Solana USDC mint + our documented receive owner (both 32-byte base58).
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECEIVE_OWNER = "CoeWSvQzk4MWSkVH5GqBnoYs9nisXsbSiQ6QeveP4js3";

// Deterministic 32-byte pubkeys / 64-byte signature via the package's own codec.
const pk = (seed: number) => base58Encode(new Uint8Array(32).fill(seed));
const sig = (seed: number) => base58Encode(new Uint8Array(64).fill(seed));

const SENDER = pk(2);
const STRANGER = pk(3);
const WRONG_MINT = pk(4);
const WRONG_OWNER = pk(5);
const SIG = sig(7);
const PRICE = 49_000_000n; // 49 USDC @ 6 decimals

function bal(
  accountIndex: number,
  mint: string,
  owner: string,
  amount: bigint | string,
): SolanaTokenBalance {
  return {
    accountIndex,
    mint,
    owner,
    uiTokenAmount: { amount: String(amount), decimals: 6 },
  };
}

// A standard SPL transfer: sender ATA (idx 1) debited, receive ATA (idx 2)
// credited by PRICE. slot 100.
function goodInfo(over: Partial<SolanaTxInfo["meta"]> = {}): SolanaTxInfo {
  const meta = {
    err: null as unknown,
    preTokenBalances: [
      bal(1, USDC_MINT, SENDER, 100_000_000n),
      bal(2, USDC_MINT, RECEIVE_OWNER, 0n),
    ],
    postTokenBalances: [
      bal(1, USDC_MINT, SENDER, 100_000_000n - PRICE),
      bal(2, USDC_MINT, RECEIVE_OWNER, PRICE),
    ],
    ...over,
  };
  return { slot: 100, meta };
}

function reader(over: Partial<SolanaReader> = {}): SolanaReader {
  return {
    getTransaction: async () => goodInfo(),
    getSlot: async () => 120, // 21 finalized-slot depth over slot 100
    ...over,
  };
}

const cfg = {
  rpcUrls: ["https://api.invalid"],
  mint: USDC_MINT,
  decimals: 6,
  symbol: "USDC",
  receiveOwner: RECEIVE_OWNER,
  minConfirmations: 1,
};

// ── signature / address helpers ─────────────────────────────────────────────
describe("solana signature + address helpers", () => {
  it("validates a 64-byte base58 signature and rejects everything else", () => {
    expect(isValidSolanaSignature(SIG)).toBe(true);
    expect(isValidSolanaSignature(pk(2))).toBe(false); // 32 bytes, not 64
    expect(isValidSolanaSignature("not-a-sig!")).toBe(false); // non-base58
    expect(isValidSolanaSignature("0OIl")).toBe(false); // ambiguous glyphs absent
    expect(isValidSolanaSignature("")).toBe(false);
  });

  it("normalises by trimming, case-preserved (never lowercased)", () => {
    expect(normalizeSolanaSignature(`  ${SIG}  `)).toBe(SIG);
    expect(() => normalizeSolanaSignature("nope")).toThrow(/signature/i);
  });

  it("recognises 32-byte base58 addresses", () => {
    expect(isValidSolanaAddress(USDC_MINT)).toBe(true);
    expect(isValidSolanaAddress(RECEIVE_OWNER)).toBe(true);
    expect(isValidSolanaAddress(SIG)).toBe(false); // 64 bytes
    expect(isValidSolanaAddress("bad!")).toBe(false);
  });
});

// ── base58 codec ────────────────────────────────────────────────────────────
describe("base58 codec", () => {
  it("round-trips arbitrary bytes (incl. leading zeros)", () => {
    for (const arr of [
      new Uint8Array([1, 2, 3, 255, 0, 42]),
      new Uint8Array([0, 0, 1, 2, 3]), // leading zeros → leading "1"s
      new Uint8Array(32).fill(9),
      new Uint8Array(64).fill(200),
    ]) {
      expect(Array.from(base58Decode(base58Encode(arr)))).toEqual(Array.from(arr));
    }
  });

  it("decodes real Solana values to their expected byte lengths", () => {
    expect(base58Decode(USDC_MINT).length).toBe(32);
    expect(base58Decode(SIG).length).toBe(64);
  });
});

// ── createSolanaValidator ───────────────────────────────────────────────────
describe("createSolanaValidator", () => {
  it("accepts a finalized SPL transfer to us (manual / any sender)", async () => {
    const v = createSolanaValidator(cfg, reader());
    const res = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.amount).toBe(PRICE);
      expect(res.confirmations).toBe(21);
      expect(res.blockNumber).toBe(100n);
      expect(res.txHash).toBe(SIG);
    }
  });

  it("accepts an overpayment", async () => {
    const v = createSolanaValidator(
      cfg,
      reader({
        getTransaction: async () =>
          goodInfo({
            postTokenBalances: [
              bal(1, USDC_MINT, SENDER, 100_000_000n - PRICE - 5n),
              bal(2, USDC_MINT, RECEIVE_OWNER, PRICE + 5n),
            ],
          }),
      }),
    );
    const res = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.amount).toBe(PRICE + 5n);
  });

  it("rejects an underpayment", async () => {
    const v = createSolanaValidator(
      cfg,
      reader({
        getTransaction: async () =>
          goodInfo({
            postTokenBalances: [
              bal(1, USDC_MINT, SENDER, 100_000_000n - PRICE + 1n),
              bal(2, USDC_MINT, RECEIVE_OWNER, PRICE - 1n),
            ],
          }),
      }),
    );
    const res = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("rejects a spoofed/look-alike mint", async () => {
    const v = createSolanaValidator(
      cfg,
      reader({
        getTransaction: async () =>
          goodInfo({
            preTokenBalances: [bal(2, WRONG_MINT, RECEIVE_OWNER, 0n)],
            postTokenBalances: [bal(2, WRONG_MINT, RECEIVE_OWNER, PRICE)],
          }),
      }),
    );
    const res = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("rejects a transfer to the wrong receive owner", async () => {
    const v = createSolanaValidator(
      cfg,
      reader({
        getTransaction: async () =>
          goodInfo({
            preTokenBalances: [bal(2, USDC_MINT, WRONG_OWNER, 0n)],
            postTokenBalances: [bal(2, USDC_MINT, WRONG_OWNER, PRICE)],
          }),
      }),
    );
    const res = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("credits when the receive ATA was created in this tx (no pre balance)", async () => {
    const v = createSolanaValidator(
      cfg,
      reader({
        getTransaction: async () =>
          goodInfo({
            // pre has ONLY the sender — the receive ATA is opened in-tx.
            preTokenBalances: [bal(1, USDC_MINT, SENDER, 100_000_000n)],
            postTokenBalances: [
              bal(1, USDC_MINT, SENDER, 100_000_000n - PRICE),
              bal(2, USDC_MINT, RECEIVE_OWNER, PRICE),
            ],
          }),
      }),
    );
    const res = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.amount).toBe(PRICE);
  });

  it("rejects a failed transaction (meta.err set) as reverted", async () => {
    const v = createSolanaValidator(
      cfg,
      reader({
        getTransaction: async () =>
          goodInfo({ err: { InstructionError: [0, { Custom: 1 }] } }),
      }),
    );
    const res = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "reverted" });
  });

  it("returns not_found when the reader has no tx (null)", async () => {
    const v = createSolanaValidator(cfg, reader({ getTransaction: async () => null }));
    const res = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found when the reader throws (network/HTTP error)", async () => {
    const v = createSolanaValidator(
      cfg,
      reader({
        getTransaction: async () => {
          throw new Error("HTTP 500");
        },
      }),
    );
    const res = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects a malformed signature without touching the chain", async () => {
    const getTransaction = vi.fn(async () => goodInfo());
    const v = createSolanaValidator(cfg, reader({ getTransaction }));

    const nonBase58 = await v.validatePayment({
      txHash: "not-a-sig!" as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(nonBase58).toEqual({ ok: false, reason: "bad_tx_hash" });

    const wrongLen = await v.validatePayment({
      txHash: pk(9) as `0x${string}`, // valid base58 but only 32 bytes
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(wrongLen).toEqual({ ok: false, reason: "bad_tx_hash" });

    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("enforces the sender pin when requireSender is true", async () => {
    const v = createSolanaValidator(cfg, reader());

    const ok = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      sender: SENDER, // negative delta ⇒ they sent
      requireSender: true,
    });
    expect(ok.ok).toBe(true);

    const stranger = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      sender: STRANGER, // touched no such balance
      requireSender: true,
    });
    expect(stranger).toEqual({ ok: false, reason: "no_matching_transfer" });

    const noSender = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: true, // fail-safe: proof required but none given
    });
    expect(noSender).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  it("reports insufficient_confirmations when the finalized depth is too small", async () => {
    const v = createSolanaValidator(
      { ...cfg, minConfirmations: 50 },
      reader({ getSlot: async () => 120 }), // depth 21 < 50
    );
    const res = await v.validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({
      ok: false,
      reason: "insufficient_confirmations",
      confirmations: 21,
    });
  });

  it("throws at construction on a typo'd mint or receive owner", () => {
    expect(() => createSolanaValidator({ ...cfg, mint: "not-a-mint!" }, reader())).toThrow(
      /mint/i,
    );
    expect(() =>
      createSolanaValidator({ ...cfg, receiveOwner: "nope!" }, reader()),
    ).toThrow(/receiveOwner/i);
  });

  it("throws if built with no rpcUrls and no injected reader", () => {
    expect(() => createSolanaValidator({ ...cfg, rpcUrls: [] })).toThrow(/rpcUrl/);
  });
});
