// src/solana/base58.ts
var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
var BASE = 58n;
var ALPHABET_MAP = (() => {
  const m = {};
  for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET[i]] = i;
  return m;
})();
function base58Decode(str) {
  if (str.length === 0) return new Uint8Array(0);
  let num = 0n;
  for (const ch of str) {
    const v = ALPHABET_MAP[ch];
    if (v === void 0) {
      throw new Error(`crypto-pay/solana: invalid base58 character "${ch}".`);
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

// src/solana/validator.ts
var SIGNATURE_BYTES = 64;
var PUBKEY_BYTES = 32;
function isValidSolanaSignature(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0) return false;
  try {
    return base58Decode(v).length === SIGNATURE_BYTES;
  } catch {
    return false;
  }
}
function normalizeSolanaSignature(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!isValidSolanaSignature(v)) {
    throw new Error("crypto-pay/solana: bad Solana signature.");
  }
  return v;
}
function isValidSolanaAddress(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0) return false;
  try {
    return base58Decode(v).length === PUBKEY_BYTES;
  } catch {
    return false;
  }
}
function assertAddress(value, label) {
  if (!isValidSolanaAddress(value)) {
    throw new Error(
      `crypto-pay/solana: ${label} is not a valid base58 32-byte address.`
    );
  }
  return value.trim();
}
function netTokenDelta(pre, post, mint, owner) {
  const indexes = /* @__PURE__ */ new Set();
  for (const b of post) {
    if (b.mint === mint && b.owner === owner) indexes.add(b.accountIndex);
  }
  for (const b of pre) {
    if (b.mint === mint && b.owner === owner) indexes.add(b.accountIndex);
  }
  if (indexes.size === 0) return null;
  const amountAt = (arr, idx) => {
    const hit = arr.find((b) => b.accountIndex === idx);
    if (!hit) return 0n;
    try {
      return BigInt(hit.uiTokenAmount.amount);
    } catch {
      return 0n;
    }
  };
  let total = 0n;
  for (const idx of indexes) total += amountAt(post, idx) - amountAt(pre, idx);
  return total;
}
function httpSolanaReader(cfg) {
  async function rpc(method, params) {
    let lastErr;
    for (const base of cfg.rpcUrls) {
      try {
        const res = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
        });
        if (!res.ok) throw new Error(`Solana RPC ${method} HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) {
          throw new Error(`Solana RPC ${method} error: ${JSON.stringify(json.error)}`);
        }
        return json.result;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`Solana RPC ${method} failed`);
  }
  return {
    async getTransaction(signature) {
      const result = await rpc("getTransaction", [
        signature,
        {
          encoding: "jsonParsed",
          commitment: "finalized",
          maxSupportedTransactionVersion: 0
        }
      ]);
      if (result === null || result === void 0) return null;
      return result;
    },
    async getSlot() {
      const result = await rpc("getSlot", [{ commitment: "finalized" }]);
      if (typeof result !== "number") {
        throw new Error("Solana RPC getSlot: missing slot number");
      }
      return result;
    }
  };
}
function createSolanaValidator(cfg, reader) {
  if (!reader && cfg.rpcUrls.length === 0) {
    throw new Error("crypto-pay/solana: at least one rpcUrl is required.");
  }
  const chain = reader ?? httpSolanaReader(cfg);
  const mint = assertAddress(cfg.mint, "mint");
  const receiveOwner = assertAddress(cfg.receiveOwner, "receiveOwner");
  async function validatePayment(input) {
    if (typeof input.txHash !== "string" || !isValidSolanaSignature(input.txHash)) {
      return { ok: false, reason: "bad_tx_hash" };
    }
    const signature = normalizeSolanaSignature(input.txHash);
    let info;
    try {
      info = await chain.getTransaction(signature);
    } catch {
      return { ok: false, reason: "not_found" };
    }
    if (!info || !info.meta) {
      return { ok: false, reason: "not_found" };
    }
    if (info.meta.err !== null && info.meta.err !== void 0) {
      return { ok: false, reason: "reverted" };
    }
    const pre = info.meta.preTokenBalances ?? [];
    const post = info.meta.postTokenBalances ?? [];
    const received = netTokenDelta(pre, post, mint, receiveOwner);
    if (received === null || received < input.expectedAmount) {
      return { ok: false, reason: "no_matching_transfer" };
    }
    const requireSender = input.requireSender ?? true;
    if (requireSender) {
      if (!input.sender) return { ok: false, reason: "no_matching_transfer" };
      const sent = netTokenDelta(pre, post, mint, input.sender);
      if (sent === null || sent >= 0n) {
        return { ok: false, reason: "no_matching_transfer" };
      }
    }
    let headSlot;
    try {
      headSlot = await chain.getSlot();
    } catch {
      headSlot = info.slot;
    }
    const confirmations = Math.max(1, headSlot - info.slot + 1);
    if (confirmations < cfg.minConfirmations) {
      return { ok: false, reason: "insufficient_confirmations", confirmations };
    }
    return {
      ok: true,
      amount: received,
      confirmations,
      blockNumber: BigInt(info.slot),
      // Solana signatures are base58, not `0x`-hex; the field is typed for EVM
      // but carries the canonical signature at runtime (as Tron does its tx-id).
      txHash: signature
    };
  }
  return { validatePayment };
}

export { base58Decode, base58Encode, createSolanaValidator, isValidSolanaAddress, isValidSolanaSignature, normalizeSolanaSignature };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map