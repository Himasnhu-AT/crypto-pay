export { TRANSFER_EVENT, TRANSFER_TOPIC0, createValidator, evaluateReceipt } from './chunk-UHO3ONJG.js';
import { parseUnits, formatUnits } from 'viem';

function toSmallestUnit(human, decimals) {
  return parseUnits(human, decimals);
}
function fromSmallestUnit(value, decimals) {
  return formatUnits(value, decimals);
}

export { fromSmallestUnit, toSmallestUnit };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map