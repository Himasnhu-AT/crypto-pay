export {
  createValidator,
  evaluateReceipt,
  type Validator,
  type ChainReader,
  type MinimalReceipt,
  type ReceiptLog,
  type EvaluateParams,
} from "./validator";
export {
  type PaymentConfig,
  type TokenSpec,
  type ValidateInput,
  type ValidateResult,
  type ValidateReason,
} from "./config";
export { verifySiwe, type VerifySiweParams } from "./siwe";
export { toSmallestUnit, fromSmallestUnit } from "./amounts";
export { TRANSFER_EVENT, TRANSFER_TOPIC0 } from "./erc20";

// Convenience re-exports so consumers build SIWE messages / nonces without a
// direct `viem/siwe` import. `generateSiweNonce` is for the server (mint a
// nonce), `createSiweMessage` for the client (build the message to sign).
export {
  createSiweMessage,
  generateSiweNonce,
  parseSiweMessage,
} from "viem/siwe";
