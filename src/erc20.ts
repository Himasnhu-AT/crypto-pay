import { parseAbiItem } from "viem";

/**
 * The canonical ERC-20 `Transfer` event. Every compliant token — including
 * USDT and USDC on every chain — emits exactly this on a transfer. Validation
 * keys off this event, not off the token's `transfer()` return value (USDT on
 * Ethereum mainnet famously returns no bool), so it works uniformly everywhere.
 */
export const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/**
 * `keccak256("Transfer(address,address,uint256)")` — the topic0 of a Transfer
 * log. Hardcoded (not computed at runtime) so it is auditable at a glance and
 * costs nothing on the hot path. Used as a cheap pre-filter before decoding.
 */
export const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
