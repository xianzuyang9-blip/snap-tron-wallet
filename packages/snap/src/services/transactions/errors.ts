export type TransactionDecodingErrorCode = 'MalformedKnownSelectorData';

/**
 * Thrown when a transaction decoding operation fails. Very specifically, when
 * a supported smart contract selector but the ABI payload/address conversion fails:
 * - TRC20 `approve` 095ea7b3
 * - TRC20 `transfer` a9059cbb
 * - Rango `onChainSwaps` 14d08fca
 *
 * Worth noting that we don't know how to decode ALL transactions, only some important
 * ones that are relevant for us to try and better validate balances and fees.
 */
export class TransactionDecodingError extends Error {
  public readonly code: TransactionDecodingErrorCode;

  constructor(code: TransactionDecodingErrorCode) {
    super(code);
    this.code = code;
    this.name = 'TransactionDecodingError';
  }
}
