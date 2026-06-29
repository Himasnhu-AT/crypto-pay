import { evaluateReceipt } from '../chunk-UHO3ONJG.js';
import { bytesToHex, hexToBytes, sha256 } from 'viem';

var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
var BASE = 58n;
var ALPHABET_MAP = (() => {
  const m = {};
  for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET[i]] = i;
  return m;
})();
var TRON_VERSION_BYTE = 65;
function base58Decode(str) {
  if (str.length === 0) return new Uint8Array(0);
  let num = 0n;
  for (const ch of str) {
    const v = ALPHABET_MAP[ch];
    if (v === void 0) {
      throw new Error(`crypto-pay/tron: invalid base58 character "${ch}".`);
    }
    num = num * BASE + BigInt(v);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  bytes.reverse();
  let leadingZeros = 0;
  for (const ch of str) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  out.set(bytes, leadingZeros);
  return out;
}
function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = "";
  while (num > 0n) {
    out = ALPHABET[Number(num % BASE)] + out;
    num /= BASE;
  }
  return "1".repeat(zeros) + out;
}
function doubleSha256(b) {
  return sha256(sha256(b, "bytes"), "bytes");
}
function tronBase58ToEvmAddress(base58) {
  const decoded = base58Decode(base58.trim());
  if (decoded.length !== 25) {
    throw new Error(
      `crypto-pay/tron: bad Tron address length (${decoded.length} bytes, expected 25).`
    );
  }
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const expected = doubleSha256(payload);
  for (let i = 0; i < 4; i++) {
    if (expected[i] !== checksum[i]) {
      throw new Error("crypto-pay/tron: Tron address checksum mismatch.");
    }
  }
  if (payload[0] !== TRON_VERSION_BYTE) {
    throw new Error(
      "crypto-pay/tron: not a Tron mainnet address (version byte != 0x41)."
    );
  }
  return bytesToHex(payload.subarray(1));
}
function tronHexToEvmAddress(hex) {
  let h = hex.trim().toLowerCase();
  if (h.startsWith("0x")) h = h.slice(2);
  if (h.length === 42 && h.startsWith("41")) h = h.slice(2);
  if (h.length !== 40 || !/^[0-9a-f]{40}$/.test(h)) {
    throw new Error("crypto-pay/tron: bad Tron hex address.");
  }
  return `0x${h}`;
}
function evmAddressToTronBase58(hex) {
  let h = hex.trim().toLowerCase();
  if (h.startsWith("0x")) h = h.slice(2);
  if (h.length !== 40 || !/^[0-9a-f]{40}$/.test(h)) {
    throw new Error("crypto-pay/tron: bad EVM hex address.");
  }
  const body = hexToBytes(`0x${h}`);
  const payload = new Uint8Array(21);
  payload[0] = TRON_VERSION_BYTE;
  payload.set(body, 1);
  const checksum = doubleSha256(payload).subarray(0, 4);
  const full = new Uint8Array(25);
  full.set(payload, 0);
  full.set(checksum, 21);
  return base58Encode(full);
}
var TRON_TXID_RE = /^[0-9a-fA-F]{64}$/;
function isTronTxId(value) {
  return TRON_TXID_RE.test(value.startsWith("0x") ? value.slice(2) : value);
}
function normalizeTronTxId(value) {
  const v = value.startsWith("0x") ? value.slice(2) : value;
  if (!TRON_TXID_RE.test(v)) {
    throw new Error("crypto-pay/tron: bad Tron tx-id.");
  }
  return v.toLowerCase();
}

// src/tron/validator.ts
function with0x(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return `0x${h}`;
}
function tronInfoToReceipt(info) {
  const status = info.receipt?.result === "SUCCESS" ? "success" : "reverted";
  const logs = (info.log ?? []).map((l) => ({
    address: tronHexToEvmAddress(l.address),
    topics: (l.topics ?? []).map(with0x),
    data: with0x(l.data ?? "")
  }));
  return {
    status,
    blockNumber: BigInt(info.blockNumber ?? 0),
    logs
  };
}
function httpTronReader(cfg) {
  async function post(path, body) {
    let lastErr;
    for (const base of cfg.apiUrls) {
      try {
        const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...cfg.apiKey ? { "TRON-PRO-API-KEY": cfg.apiKey } : {}
          },
          body: JSON.stringify(body)
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
      return await post("/walletsolidity/gettransactioninfobyid", {
        value: txId
      });
    },
    async getNowBlockNumber() {
      const block = await post("/walletsolidity/getnowblock", {});
      const n = block?.block_header?.raw_data?.number;
      if (typeof n !== "number") {
        throw new Error("TronGrid getnowblock: missing block number");
      }
      return n;
    }
  };
}
function createTronValidator(cfg, reader) {
  if (!reader && cfg.apiUrls.length === 0) {
    throw new Error("crypto-pay/tron: at least one apiUrl is required.");
  }
  const chain = reader ?? httpTronReader(cfg);
  const tokenAddress = tronBase58ToEvmAddress(cfg.token.addressBase58);
  const receiveAddress = tronBase58ToEvmAddress(cfg.receiveAddressBase58);
  async function validatePayment(input) {
    if (typeof input.txHash !== "string" || !isTronTxId(input.txHash)) {
      return { ok: false, reason: "bad_tx_hash" };
    }
    const txId = normalizeTronTxId(input.txHash);
    let info;
    try {
      info = await chain.getTransactionInfoById(txId);
    } catch {
      return { ok: false, reason: "not_found" };
    }
    if (!info || info.blockNumber === void 0 || info.blockNumber === null) {
      return { ok: false, reason: "not_found" };
    }
    const headBlockNumber = BigInt(await chain.getNowBlockNumber());
    let sender;
    if (input.sender) {
      sender = input.sender.startsWith("0x") ? input.sender : tronBase58ToEvmAddress(input.sender);
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
      txHash: with0x(txId)
    });
  }
  return { validatePayment };
}

export { createTronValidator, evmAddressToTronBase58, isTronTxId, normalizeTronTxId, tronBase58ToEvmAddress, tronHexToEvmAddress, tronInfoToReceipt };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map