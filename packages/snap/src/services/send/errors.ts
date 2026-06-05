import type { SendValidationErrorCode } from './types';

/**
 * Thrown when a send operation does not meet the minimum pre-flight validation requirements.
 * - InsufficientBalance
 * - InsufficientBalanceToCoverFee
 */
export class SendValidationError extends Error {
  readonly code: SendValidationErrorCode;

  constructor(code: SendValidationErrorCode) {
    super(code);
    this.name = 'SendValidationError';
    this.code = code;
  }
}
