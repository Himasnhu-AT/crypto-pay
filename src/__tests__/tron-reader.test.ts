import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, pad } from "viem";
import { TRANSFER_TOPIC0 } from "../erc20";
import { createTronValidator } from "../tron";
import { evmAddressToTronBase58 } from "../tron";

// Exercises the PRODUCTION TronGrid reader (httpTronReader) end to end by
// stubbing global fetch — covering request shaping (path, API-key header, body),
// JSON parsing, URL fallback, and not-found — which the stub-reader unit tests
// in tron.test.ts deliberately bypass.

const USDT_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_EVM = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";
const RECEIVE_EVM = "0x1111111111111111111111111111111111111111" as const;
const SENDER_EVM = "0x2222222222222222222222222222222222222222" as const;
const RECEIVE_BASE58 = evmAddressToTronBase58(RECEIVE_EVM);
const TXID = "ab".repeat(32);
const PRICE = 49_000_000n;

const strip0x = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

// A realistic TronGrid gettransactioninfobyid body: 41-prefixed log address
// (the on-chain form), bare-hex topics/data.
function txInfoBody() {
  return {
    id: TXID,
    blockNumber: 100,
    receipt: { result: "SUCCESS" },
    log: [
      {
        address: "41" + strip0x(USDT_EVM),
        topics: [
          strip0x(TRANSFER_TOPIC0),
          strip0x(pad(SENDER_EVM, { size: 32 })),
          strip0x(pad(RECEIVE_EVM, { size: 32 })),
        ],
        data: strip0x(encodeAbiParameters([{ type: "uint256" }], [PRICE])),
      },
    ],
  };
}

const nowBlockBody = { block_header: { raw_data: { number: 120 } } };

function jsonRes(obj: unknown) {
  return { ok: true, status: 200, json: async () => obj } as unknown as Response;
}

const cfg = (over: Record<string, unknown> = {}) => ({
  apiUrls: ["https://primary.invalid"],
  token: { addressBase58: USDT_BASE58, decimals: 6, symbol: "USDT" },
  receiveAddressBase58: RECEIVE_BASE58,
  minConfirmations: 1,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("httpTronReader (production reader via stubbed fetch)", () => {
  it("validates a real-shaped TronGrid response over HTTP", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/walletsolidity/gettransactioninfobyid")) {
        return jsonRes(txInfoBody());
      }
      if (url.endsWith("/walletsolidity/getnowblock")) {
        return jsonRes(nowBlockBody);
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await createTronValidator(cfg()).validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res.ok).toBe(true);
    // Hit the solidity endpoints, not the (reorg-prone) full node.
    expect(fetchMock.mock.calls.every(([u]) => String(u).includes("/walletsolidity/"))).toBe(true);
  });

  it("forwards the TRON-PRO-API-KEY header when configured", async () => {
    const seenHeaders: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      seenHeaders.push(init.headers as Record<string, unknown>);
      return url.endsWith("getnowblock")
        ? jsonRes(nowBlockBody)
        : jsonRes(txInfoBody());
    });
    vi.stubGlobal("fetch", fetchMock);

    await createTronValidator(cfg({ apiKey: "secret-key" })).validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(
      seenHeaders.every((h) => h["TRON-PRO-API-KEY"] === "secret-key"),
    ).toBe(true);
  });

  it("falls back to the next apiUrl when the first fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://primary.invalid")) {
        throw new Error("ECONNREFUSED");
      }
      return url.endsWith("getnowblock")
        ? jsonRes(nowBlockBody)
        : jsonRes(txInfoBody());
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await createTronValidator(
      cfg({ apiUrls: ["https://primary.invalid", "https://backup.example"] }),
    ).validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res.ok).toBe(true);
  });

  it("returns not_found when every apiUrl errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502 }) as unknown as Response),
    );
    const res = await createTronValidator(cfg()).validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found when the solidity node returns an empty object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("getnowblock") ? jsonRes(nowBlockBody) : jsonRes({}),
      ),
    );
    const res = await createTronValidator(cfg()).validatePayment({
      txHash: TXID,
      expectedAmount: PRICE,
      requireSender: false,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });
});
