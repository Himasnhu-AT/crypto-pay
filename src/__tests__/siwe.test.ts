import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { arbitrum } from "viem/chains";
import { verifySiwe } from "../siwe";

const account = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`);
const stranger = privateKeyToAccount(("0x" + "22".repeat(32)) as `0x${string}`);

const DOMAIN = "qubitquant.example";
const NONCE = "abcdef1234567890";
const CHAIN_ID = arbitrum.id;
const URI = `https://${DOMAIN}/dashboard`;

type MsgOverrides = Parameters<typeof createSiweMessage>[0];

async function sign(
  signer: typeof account,
  over: Partial<MsgOverrides> = {},
): Promise<{ message: string; signature: `0x${string}` }> {
  const message = createSiweMessage({
    address: account.address,
    chainId: CHAIN_ID,
    domain: DOMAIN,
    nonce: NONCE,
    uri: URI,
    version: "1",
    ...over,
  });
  const signature = await signer.signMessage({ message });
  return { message, signature };
}

const base = {
  address: account.address,
  domain: DOMAIN,
  nonce: NONCE,
  chainId: CHAIN_ID,
} as const;

describe("verifySiwe", () => {
  it("accepts a correctly signed, correctly bound message", async () => {
    const { message, signature } = await sign(account);
    expect(await verifySiwe({ ...base, message, signature })).toBe(true);
  });

  it("rejects when the verifier expects a different nonce", async () => {
    const { message, signature } = await sign(account);
    expect(
      await verifySiwe({ ...base, nonce: "deadbeef99887766", message, signature }),
    ).toBe(false);
  });

  it("rejects a domain mismatch (cross-site replay)", async () => {
    const { message, signature } = await sign(account);
    expect(
      await verifySiwe({ ...base, domain: "evil.example", message, signature }),
    ).toBe(false);
  });

  it("rejects a chainId mismatch", async () => {
    const { message, signature } = await sign(account);
    expect(await verifySiwe({ ...base, chainId: 1, message, signature })).toBe(
      false,
    );
  });

  it("rejects a signature from a different wallet", async () => {
    // Message claims `account`, but `stranger` actually signed it.
    const { message, signature } = await sign(stranger);
    expect(await verifySiwe({ ...base, message, signature })).toBe(false);
  });

  it("rejects when the claimed address doesn't match the message", async () => {
    const { message, signature } = await sign(account);
    expect(
      await verifySiwe({ ...base, address: stranger.address, message, signature }),
    ).toBe(false);
  });

  it("rejects an expired message when `now` is supplied", async () => {
    const { message, signature } = await sign(account, {
      expirationTime: new Date(1_000),
    });
    expect(
      await verifySiwe({ ...base, now: 2_000, message, signature }),
    ).toBe(false);
  });

  it("rejects a not-yet-valid message when `now` is supplied", async () => {
    const { message, signature } = await sign(account, {
      notBefore: new Date(10_000),
    });
    expect(await verifySiwe({ ...base, now: 5_000, message, signature })).toBe(
      false,
    );
  });

  it("accepts an unexpired message when `now` is within the window", async () => {
    const { message, signature } = await sign(account, {
      expirationTime: new Date(10_000),
    });
    expect(await verifySiwe({ ...base, now: 5_000, message, signature })).toBe(
      true,
    );
  });

  it("rejects garbage that isn't a SIWE message", async () => {
    expect(
      await verifySiwe({
        ...base,
        message: "not a siwe message",
        signature: ("0x" + "00".repeat(65)) as `0x${string}`,
      }),
    ).toBe(false);
  });
});
