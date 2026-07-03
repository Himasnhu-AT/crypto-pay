import { afterEach, describe, expect, it, vi } from "vitest";
import { base58Encode, createSolanaValidator } from "../solana";

// Exercises the PRODUCTION Solana JSON-RPC reader (httpSolanaReader) end to end
// by stubbing global fetch — covering request shaping (method, params, body),
// JSON parsing, URL fallback, and result:null → not-found — which the
// stub-reader unit tests in solana.test.ts deliberately bypass.

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECEIVE_OWNER = "CoeWSvQzk4MWSkVH5GqBnoYs9nisXsbSiQ6QeveP4js3";
const SENDER = base58Encode(new Uint8Array(32).fill(2));
const SIG = base58Encode(new Uint8Array(64).fill(7));
const PRICE = 49_000_000n;

// A realistic jsonParsed getTransaction result: slot + pre/postTokenBalances.
function txInfoBody() {
  return {
    slot: 100,
    meta: {
      err: null,
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT,
          owner: SENDER,
          uiTokenAmount: { amount: "100000000", decimals: 6 },
        },
        {
          accountIndex: 2,
          mint: USDC_MINT,
          owner: RECEIVE_OWNER,
          uiTokenAmount: { amount: "0", decimals: 6 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT,
          owner: SENDER,
          uiTokenAmount: { amount: String(100_000_000n - PRICE), decimals: 6 },
        },
        {
          accountIndex: 2,
          mint: USDC_MINT,
          owner: RECEIVE_OWNER,
          uiTokenAmount: { amount: String(PRICE), decimals: 6 },
        },
      ],
    },
  };
}

/** Wrap a value as a JSON-RPC 2.0 success envelope (what the reader unwraps). */
function rpcRes(result: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result }),
  } as unknown as Response;
}

const cfg = (over: Record<string, unknown> = {}) => ({
  rpcUrls: ["https://primary.invalid"],
  mint: USDC_MINT,
  decimals: 6,
  symbol: "USDC",
  receiveOwner: RECEIVE_OWNER,
  minConfirmations: 1,
  ...over,
});

const methodOf = (init: RequestInit) => JSON.parse(String(init.body)).method as string;
const paramsOf = (init: RequestInit) => JSON.parse(String(init.body)).params as unknown[];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("httpSolanaReader (production reader via stubbed fetch)", () => {
  it("POSTs getTransaction with the finalized/jsonParsed params and validates", async () => {
    const seen: { url: string; method: string; params: unknown[] }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const method = methodOf(init);
      seen.push({ url, method, params: paramsOf(init) });
      if (method === "getTransaction") return rpcRes(txInfoBody());
      if (method === "getSlot") return rpcRes(130);
      throw new Error(`unexpected method ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await createSolanaValidator(cfg()).validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res.ok).toBe(true);

    const getTx = seen.find((c) => c.method === "getTransaction")!;
    expect(getTx.params[0]).toBe(SIG);
    expect(getTx.params[1]).toEqual({
      encoding: "jsonParsed",
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    // getSlot is called at the finalized commitment.
    const getSlot = seen.find((c) => c.method === "getSlot")!;
    expect(getSlot.params[0]).toEqual({ commitment: "finalized" });
  });

  it("falls back to the next rpcUrl when the first fails", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://primary.invalid")) throw new Error("ECONNREFUSED");
      return methodOf(init) === "getSlot" ? rpcRes(130) : rpcRes(txInfoBody());
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await createSolanaValidator(
      cfg({ rpcUrls: ["https://primary.invalid", "https://backup.example"] }),
    ).validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res.ok).toBe(true);
  });

  it("maps result:null from getTransaction to not_found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) =>
        methodOf(init) === "getSlot" ? rpcRes(130) : rpcRes(null),
      ),
    );
    const res = await createSolanaValidator(cfg()).validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found when every rpcUrl errors (non-2xx)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502 }) as unknown as Response),
    );
    const res = await createSolanaValidator(cfg()).validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found when the RPC returns a JSON error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32602 } }),
          }) as unknown as Response,
      ),
    );
    const res = await createSolanaValidator(cfg()).validatePayment({
      txHash: SIG as `0x${string}`,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });
});
