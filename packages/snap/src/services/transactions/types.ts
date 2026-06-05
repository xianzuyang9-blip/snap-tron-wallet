import type { Types } from 'tronweb';

export type TransactionRawData = Types.Transaction['raw_data'] & {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  fee_limit?: number;
};

export enum DecodedTransactionType {
  Unknown = 'unknown',
  TriggerSmartContract = 'trigger-smart-contract',
}

export enum DecodedTriggerSmartContractOperationType {
  Trc20Approval = 'trc20-approval',
  Trc20Transfer = 'trc20-transfer',
  RangoSwap = 'rango-swap',
  UnknownContractCall = 'unknown-contract-call',
}

export type UnknownDecodedTransaction = {
  type: DecodedTransactionType.Unknown;
};

export type DecodedTrc20Approval = {
  type: DecodedTriggerSmartContractOperationType.Trc20Approval;
  selector: string;
  contractAddress: string;
  spenderAddress: string;
  rawAmount: bigint;
};

export type DecodedTrc20Transfer = {
  type: DecodedTriggerSmartContractOperationType.Trc20Transfer;
  selector: string;
  contractAddress: string;
  receiverAddress: string;
  rawAmount: bigint;
};

export type DecodedRangoSwap = {
  type: DecodedTriggerSmartContractOperationType.RangoSwap;
  selector: string;
  fromTokenAddress: string | 'native';
  receiverAddress: string;
  rawAmountIn: bigint;
};

export type DecodedUnknownContractCall = {
  type: DecodedTriggerSmartContractOperationType.UnknownContractCall;
  selector: string;
};

export type DecodedTransactionSpendDetails = {
  assetId: string;
  rawAmount: bigint;
};

export type DecodedTriggerSmartContractOperation =
  | DecodedTrc20Approval
  | DecodedTrc20Transfer
  | DecodedRangoSwap
  | DecodedUnknownContractCall;

export type DecodedTriggerSmartContractTransaction = {
  type: DecodedTransactionType.TriggerSmartContract;
  operation: DecodedTriggerSmartContractOperation;
};

export type DecodedTransaction =
  | UnknownDecodedTransaction
  | DecodedTriggerSmartContractTransaction;
