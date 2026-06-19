import { parseAbiItem, getAddress, decodeEventLog, createPublicClient, http, fallback, recoverMessageAddress, parseUnits, formatUnits } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
export { createSiweMessage, generateSiweNonce, parseSiweMessage } from 'viem/siwe';

// src/validator.ts
var TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);
var TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// src/validator.ts
var TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
function evaluateReceipt(params) {
  const { receipt, headBlockNumber, expectedAmount, minConfirmations, txHash } = params;
  if (receipt.status !== "success") return { ok: false, reason: "reverted" };
  const tokenAddress = getAddress(params.token.address);
  const receiveAddress = getAddress(params.receiveAddress);
  const sender = getAddress(params.sender);
  let matched = null;
  for (const log of receipt.logs) {
    let logAddress;
    try {
      logAddress = getAddress(log.address);
    } catch {
      continue;
    }
    if (logAddress !== tokenAddress) continue;
    const topic0 = log.topics[0];
    if (!topic0 || topic0.toLowerCase() !== TRANSFER_TOPIC0) continue;
    if (log.topics.length !== 3) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        data: log.data,
        topics: log.topics
      });
    } catch {
      continue;
    }
    const args = decoded.args;
    if (!args.from || !args.to || typeof args.value !== "bigint") continue;
    let from;
    let to;
    try {
      from = getAddress(args.from);
      to = getAddress(args.to);
    } catch {
      continue;
    }
    if (to !== receiveAddress) continue;
    if (from !== sender) continue;
    if (args.value < expectedAmount) continue;
    matched = args.value;
    break;
  }
  if (matched === null) return { ok: false, reason: "no_matching_transfer" };
  const confirmations = Math.max(
    0,
    Number(headBlockNumber - receipt.blockNumber + 1n)
  );
  if (confirmations < minConfirmations) {
    return { ok: false, reason: "insufficient_confirmations", confirmations };
  }
  return {
    ok: true,
    amount: matched,
    confirmations,
    blockNumber: receipt.blockNumber,
    txHash
  };
}
function createValidator(cfg, reader) {
  if (!reader && cfg.rpcUrls.length === 0) {
    throw new Error("crypto-pay: at least one rpcUrl is required.");
  }
  const chain = reader ?? (() => {
    const client = createPublicClient({
      chain: cfg.chain,
      transport: cfg.rpcUrls.length === 1 ? http(cfg.rpcUrls[0]) : fallback(cfg.rpcUrls.map((url) => http(url)))
    });
    return {
      getTransactionReceipt: ({ hash }) => client.getTransactionReceipt({ hash }),
      getBlockNumber: () => client.getBlockNumber(),
      getChainId: () => client.getChainId()
    };
  })();
  let chainOk = null;
  async function ensureChain() {
    if (chainOk !== null) return chainOk;
    try {
      chainOk = await chain.getChainId() === cfg.chain.id;
    } catch {
      chainOk = false;
    }
    return chainOk;
  }
  async function validatePayment(input) {
    if (!TX_HASH_RE.test(input.txHash)) {
      return { ok: false, reason: "bad_tx_hash" };
    }
    if (!await ensureChain()) return { ok: false, reason: "wrong_chain" };
    let receipt;
    try {
      receipt = await chain.getTransactionReceipt({ hash: input.txHash });
    } catch {
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
      minConfirmations: cfg.minConfirmations,
      txHash: input.txHash
    });
  }
  return { validatePayment };
}
async function verifySiwe(params) {
  const { message, signature } = params;
  let fields;
  try {
    fields = parseSiweMessage(message);
  } catch {
    return false;
  }
  if (!fields.address) return false;
  let claimed;
  let msgAddress;
  try {
    claimed = getAddress(params.address);
    msgAddress = getAddress(fields.address);
  } catch {
    return false;
  }
  if (msgAddress !== claimed) return false;
  if (fields.domain !== params.domain) return false;
  if (fields.nonce !== params.nonce) return false;
  if (fields.chainId !== params.chainId) return false;
  if (params.now !== void 0) {
    if (fields.expirationTime && fields.expirationTime.getTime() <= params.now) {
      return false;
    }
    if (fields.notBefore && fields.notBefore.getTime() > params.now) {
      return false;
    }
  }
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    return getAddress(recovered) === claimed;
  } catch {
    return false;
  }
}
function toSmallestUnit(human, decimals) {
  return parseUnits(human, decimals);
}
function fromSmallestUnit(value, decimals) {
  return formatUnits(value, decimals);
}

export { TRANSFER_EVENT, TRANSFER_TOPIC0, createValidator, evaluateReceipt, fromSmallestUnit, toSmallestUnit, verifySiwe };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map