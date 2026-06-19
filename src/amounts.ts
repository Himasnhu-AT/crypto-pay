import { formatUnits, parseUnits } from "viem";

/**
 * Human decimal string → smallest-unit bigint, given the token's decimals.
 * e.g. toSmallestUnit("49", 6) === 49_000000n for 6-decimal USDT/USDC.
 * Always work in smallest units when comparing amounts — never floats.
 */
export function toSmallestUnit(human: string, decimals: number): bigint {
  return parseUnits(human, decimals);
}

/**
 * Smallest-unit bigint → human decimal string, given the token's decimals.
 * For display only — never round-trip through this for comparisons.
 */
export function fromSmallestUnit(value: bigint, decimals: number): string {
  return formatUnits(value, decimals);
}
