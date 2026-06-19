# @qubitquant/crypto-pay

Trustless on-chain **ERC-20 payment validation** (USDT / USDC) and **SIWE wallet
binding** for accepting crypto with no payment processor and no custody. Funds
move wallet-to-wallet directly to your address; this library just **verifies a
transfer from its on-chain receipt**.

It is a pure, framework-agnostic core: it reads the chain (via your RPC) and
returns a verdict. It has **no** database, no secrets, no HTTP, and no opinion
about how you store payments — that side-effect layer is yours.

```bash
pnpm add @qubitquant/crypto-pay viem
```

`viem` is a peer dependency.

## Validate a payment

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
  sender: "0xWalletTheUserProvedTheyOwn",  // from SIWE — see below
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

## Bind a wallet with SIWE

To stop someone claiming a stranger's transaction, require the payer to prove
they control the sending wallet (Sign-In With Ethereum), then pass that wallet
as `sender` above.

```ts
import { generateSiweNonce, verifySiwe } from "@qubitquant/crypto-pay";

// 1. server: mint a single-use nonce, store it against the user, send to client.
const nonce = generateSiweNonce();

// 2. client: createSiweMessage(...) then wallet.signMessage(...).

// 3. server: verify the returned message + signature.
const ok = await verifySiwe({
  message, signature, address,
  domain: "yourhost.com", nonce, chainId: arbitrum.id,
});
// ok === true → bind `address` to the user, consume the nonce.
```

SIWE here is EOA-only (MetaMask). Smart-contract wallets (ERC-1271/6492) are out
of scope.

## What it defends against

| Attack | Defense |
| --- | --- |
| Spoofed/fake token emitting a `Transfer` | `log.address` must equal the canonical token contract |
| Claiming a stranger's txHash | `Transfer.from` must equal the SIWE-bound `sender` |
| Underpayment | transfer `value >= expectedAmount` (BigInt, no floats) |
| Reverted / gas-only tx | `receipt.status === "success"` |
| Reorg after confirmation | `minConfirmations` threshold |
| RPC pointed at the wrong network | one-time `chainId` self-check |
| Cross-site SIWE replay | message `domain` / `nonce` / `chainId` must match |

**Replay across two payments** (reusing one valid txHash twice) is *not* handled
here — that is stateful. Record consumed `txHash`es in your own store and reject
duplicates before crediting.

## API

- `createValidator(config, reader?)` → `{ validatePayment }`. `reader` is an
  optional injected chain-reading stub for tests.
- `evaluateReceipt(params)` — the pure, no-I/O decision core. Hand it a receipt
  and head block; get a verdict. This is where every security check lives.
- `verifySiwe(params)` — verify an EIP-4361 message + signature for an EOA.
- `toSmallestUnit` / `fromSmallestUnit` — decimal-safe amount helpers.
- `createSiweMessage` / `generateSiweNonce` / `parseSiweMessage` — re-exported
  from `viem/siwe` for convenience.

## License

MIT
