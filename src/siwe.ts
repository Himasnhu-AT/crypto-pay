import { getAddress, recoverMessageAddress } from "viem";
import { parseSiweMessage } from "viem/siwe";

export type VerifySiweParams = {
  /** The full EIP-4361 message the user signed. */
  message: string;
  /** The signature returned by the wallet (personal_sign). */
  signature: `0x${string}`;
  /** The wallet address the user claims to control. */
  address: `0x${string}`;
  /** Expected domain (the site host) — anti cross-site replay. */
  domain: string;
  /** The single-use nonce WE issued for this uid. */
  nonce: string;
  /** Chain id the message must be scoped to. */
  chainId: number;
  /**
   * Optional current time (ms) to enforce the message's own
   * expirationTime / notBefore. Omit to skip time checks — the server's
   * single-use nonce TTL is the primary freshness guarantee.
   */
  now?: number;
};

/**
 * Verify a SIWE (EIP-4361) message + signature for an EOA wallet (MetaMask).
 *
 * Pure: recovers the signer locally with no RPC call. Returns true only if the
 * signature is valid AND the message's address / domain / nonce / chainId match
 * exactly what we issued. Binding all four is what prevents a signature minted
 * for another site, another user, or another chain from being replayed here.
 *
 * Smart-contract (ERC-1271 / ERC-6492) wallets are out of scope — EOA only.
 */
export async function verifySiwe(params: VerifySiweParams): Promise<boolean> {
  const { message, signature } = params;

  let fields;
  try {
    fields = parseSiweMessage(message);
  } catch {
    return false;
  }

  if (!fields.address) return false;

  let claimed: string;
  let msgAddress: string;
  try {
    claimed = getAddress(params.address);
    msgAddress = getAddress(fields.address);
  } catch {
    return false;
  }

  // The message body must bind to exactly what we issued.
  if (msgAddress !== claimed) return false;
  if (fields.domain !== params.domain) return false;
  if (fields.nonce !== params.nonce) return false;
  if (fields.chainId !== params.chainId) return false;

  // Optional time-window enforcement (defence in depth; nonce TTL is primary).
  if (params.now !== undefined) {
    if (fields.expirationTime && fields.expirationTime.getTime() <= params.now) {
      return false;
    }
    if (fields.notBefore && fields.notBefore.getTime() > params.now) {
      return false;
    }
  }

  // Recover the EOA signer and require it to equal the claimed address.
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    return getAddress(recovered) === claimed;
  } catch {
    return false;
  }
}
