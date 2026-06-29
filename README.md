# @qubitquant/crypto-pay

Trustless on-chain **stablecoin payment validation** for accepting crypto with no
payment processor and no custody. Funds move wallet-to-wallet directly to your
address; this library just **verifies a transfer from its on-chain receipt**.

- **EVM (ERC-20)** — USDT / USDC on any EVM chain, via `viem`.
- **Tron (TRC-20)** — via the TronGrid HTTP API, on the `@qubitquant/crypto-pay/tron`
  subpath. TRC-20 emits the identical `Transfer` event as ERC-20, so both rails
  share one pure decision core (`evaluateReceipt`).

It is a pure, framework-agnostic core: it reads the chain and returns a verdict.
It has **no** database, no secrets, no HTTP server, and no opinion about how you
store payments — that side-effect layer is yours.

```bash
pnpm add @qubitquant/crypto-pay viem
```

`viem` is a peer dependency.

## Validate an EVM payment

```ts
import { createValidator, toSmallestUnit } from "@qubitquant/crypto-pay";
import { arbitrum } from "viem/chains";

const validator = createValidator({
  chain: arbitrum,
  rpcUrls: ["https://arb1.arbitrum.io/rpc", "https://arb-mainnet.g.alchemy.com/v2/KEY"],
  token: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, symbol: "USDT" },
  receiveAddress: "0xYourReceivingWallet",
  minConfirmations: 12,
});

const result = await validator.validatePayment({
  txHash: "0x…",
  expectedAmount: toSmallestUnit("49", 6), // 49 USDT
  requireSender: false, // manual / human-reviewed flow — see below
});

if (result.ok) {
  // result.amount, result.confirmations, result.blockNumber — credit the user.
} else {
  // result.reason: bad_tx_hash | not_found | wrong_chain | reverted
  //              | no_matching_transfer | insufficient_confirmations
}
```

> ⚠️ Always pin the **canonical token contract address** for your chain. The
> address is the anti-spoofing pin: only `Transfer` logs emitted by that exact
> contract are counted. Verify it against the token issuer's official docs and a
> block explorer before deploying. Token decimals are per-chain (USDT/USDC are 6
> on most chains, **18 on BSC**).

## Validate a Tron (TRC-20) payment

```ts
import { createTronValidator } from "@qubitquant/crypto-pay/tron";
import { toSmallestUnit } from "@qubitquant/crypto-pay";

const validator = createTronValidator({
  apiUrls: ["https://api.trongrid.io"],
  apiKey: process.env.TRON_PRO_API_KEY, // optional, for rate limits
  token: { addressBase58: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6, symbol: "USDT" },
  receiveAddressBase58: "TYourReceivingWallet…",
  minConfirmations: 1, // reads the solidity node — a hit is already irreversible
});

const result = await validator.validatePayment({
  txHash: "<64-hex tron txid>", // 0x prefix optional
  expectedAmount: toSmallestUnit("49", 6),
  requireSender: false,
});
```

Same `Validator` interface and `ValidateResult` as the EVM path. It reads the
**solidity node** (`/walletsolidity/*`), which only surfaces a transaction once
its block is irreversible, so finality is built in. Node-only (uses `fetch`).

## Sender pinning (optional)

By default `requireSender: true` enforces `Transfer.from === sender` — useful if
you can prove which wallet the payer controls (e.g. a signed message), so a
stranger can't claim someone else's txHash. For a **manual flow** — the user pays
from any wallet or exchange and pastes the tx hash — there is no proven sender, so
set `requireSender: false` and omit `sender`:

```ts
const result = await validator.validatePayment({
  txHash: "0x…",
  expectedAmount: toSmallestUnit("49", 6),
  requireSender: false,
});
// result.ok === true means: this tx paid us >= price, on the right token,
// to the right address, with enough confirmations — but NOT who sent it.
```

With `requireSender: false` the validator still enforces the token contract,
recipient, amount, and confirmation checks; it only drops the sender match.
Attribution is then your responsibility — a human reviewer confirming identity
and/or a single-use-`txHash` guard. (A `requireSender: true` call with no
`sender` is treated as a misconfiguration and rejected, never accepted.)

## What it defends against

| Attack | Defense |
| --- | --- |
| Spoofed/fake token emitting a `Transfer` | `log.address` must equal the canonical token contract |
| Claiming a stranger's txHash | `Transfer.from` must equal `sender` (when `requireSender` is true); in a manual `requireSender: false` flow, a human / single-use-txHash guard provides attribution instead |
| Underpayment | transfer `value >= expectedAmount` (BigInt, no floats) |
| Reverted / gas-only tx | `receipt.status === "success"` (EVM) / `receipt.result === "SUCCESS"` (Tron) |
| Reorg / non-final tx | EVM: `minConfirmations` threshold; Tron: the solidity node only returns irreversible txs |
| RPC pointed at the wrong network | EVM: one-time `chainId` self-check |

**Replay across two payments** (reusing one valid txHash twice) is *not* handled
here — that is stateful. Record consumed `txHash`es in your own store and reject
duplicates before crediting.

## API

- `createValidator(config, reader?)` → `{ validatePayment }` (EVM). `reader` is an
  optional injected chain-reading stub for tests.
- `createTronValidator(config, reader?)` (from `@qubitquant/crypto-pay/tron`) — the
  Tron counterpart, same interface.
- `evaluateReceipt(params)` — the pure, no-I/O decision core shared by both rails.
  Hand it a normalised receipt and head block; get a verdict. Every security check
  lives here.
- `tronBase58ToEvmAddress` / `evmAddressToTronBase58` / `isTronTxId` /
  `normalizeTronTxId` (from `/tron`) — Tron address + tx-id helpers.
- `toSmallestUnit` / `fromSmallestUnit` — decimal-safe amount helpers.

## License

MIT
