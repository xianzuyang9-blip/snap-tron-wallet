import { remove0x } from '@metamask/utils';
import { AbiCoder } from 'ethers';
import { TronWeb, Types } from 'tronweb';

import { TransactionDecodingError } from './errors';
import {
  DecodedTransactionType,
  DecodedTriggerSmartContractOperationType,
  type DecodedTransactionSpendDetails,
  type DecodedTransaction,
  type TransactionRawData,
} from './types';
import type { Network } from '../../constants';
import { Networks } from '../../constants';

const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';

const SELECTORS = {
  approve: {
    selector: '095ea7b3',
    inputs: ['address', 'uint256'],
  },
  transfer: {
    selector: 'a9059cbb',
    inputs: ['address', 'uint256'],
  },
  rangoOnChainSwaps: {
    selector: '14d08fca',
    inputs: [
      'tuple(address requestId,address fromToken,address toToken,uint256 amountIn,uint256 platformFee,uint256 destinationExecutorFee,uint256 affiliateFee,address affiliatorAddress,uint256 minimumAmountExpected,bool feeFromInputToken,uint16 dAppTag,string dAppName)',
      'tuple(address spender,address target,address swapFromToken,address swapToToken,bool needsTransferFromUser,uint256 amount,bytes callData)[]',
      'address',
    ],
  },
} as const;

export class TransactionDecoder {
  readonly #abiCoder = AbiCoder.defaultAbiCoder();

  isValidationSkipped(decodedTransaction: DecodedTransaction): boolean {
    return (
      decodedTransaction.type === DecodedTransactionType.Unknown ||
      (decodedTransaction.type ===
        DecodedTransactionType.TriggerSmartContract &&
        decodedTransaction.operation.type ===
          DecodedTriggerSmartContractOperationType.UnknownContractCall)
    );
  }

  isFeeOnlyOperation(decodedTransaction: DecodedTransaction): boolean {
    return (
      decodedTransaction.type === DecodedTransactionType.TriggerSmartContract &&
      decodedTransaction.operation.type ===
        DecodedTriggerSmartContractOperationType.Trc20Approval
    );
  }

  getSpendDetails({
    decodedTransaction,
    scope,
  }: {
    decodedTransaction: DecodedTransaction;
    scope: Network;
  }): DecodedTransactionSpendDetails | undefined {
    if (
      decodedTransaction.type !== DecodedTransactionType.TriggerSmartContract
    ) {
      return undefined;
    }

    const { operation } = decodedTransaction;

    if (
      operation.type === DecodedTriggerSmartContractOperationType.Trc20Transfer
    ) {
      return {
        assetId: `${scope}/trc20:${operation.contractAddress}`,
        rawAmount: operation.rawAmount,
      };
    }

    if (operation.type === DecodedTriggerSmartContractOperationType.RangoSwap) {
      return {
        assetId:
          operation.fromTokenAddress === 'native'
            ? Networks[scope].nativeToken.id
            : `${scope}/trc20:${operation.fromTokenAddress}`,
        rawAmount: operation.rawAmountIn,
      };
    }

    return undefined;
  }

  decode(rawData: TransactionRawData): DecodedTransaction {
    const [contract] = rawData.contract;

    if (contract?.type !== Types.ContractType.TriggerSmartContract) {
      return { type: DecodedTransactionType.Unknown };
    }

    const value = contract.parameter.value as Types.TriggerSmartContract;
    const { contract_address: contractAddress, data } = value;

    if (!data) {
      return { type: DecodedTransactionType.Unknown };
    }

    const hexData = remove0x(data.toLowerCase());
    if (hexData.length < 8) {
      throw new TransactionDecodingError('MalformedKnownSelectorData');
    }

    const selector = hexData.slice(0, 8);
    const dataToDecode = `0x${hexData.slice(8)}`;

    try {
      if (selector === SELECTORS.transfer.selector) {
        const [receiver, amount] = this.#abiCoder.decode(
          SELECTORS.transfer.inputs,
          dataToDecode,
        ) as unknown as [string, bigint];

        return {
          type: DecodedTransactionType.TriggerSmartContract,
          operation: {
            type: DecodedTriggerSmartContractOperationType.Trc20Transfer,
            selector,
            contractAddress: TronWeb.address.fromHex(contractAddress),
            receiverAddress: this.#evmAddressToTronAddress(receiver),
            rawAmount: amount,
          },
        };
      }

      if (selector === SELECTORS.approve.selector) {
        const [spender, amount] = this.#abiCoder.decode(
          SELECTORS.approve.inputs,
          dataToDecode,
        ) as unknown as [string, bigint];

        return {
          type: DecodedTransactionType.TriggerSmartContract,
          operation: {
            type: DecodedTriggerSmartContractOperationType.Trc20Approval,
            selector,
            contractAddress: TronWeb.address.fromHex(contractAddress),
            spenderAddress: this.#evmAddressToTronAddress(spender),
            rawAmount: amount,
          },
        };
      }

      if (selector === SELECTORS.rangoOnChainSwaps.selector) {
        const [txRequest, , receiver] = this.#abiCoder.decode(
          SELECTORS.rangoOnChainSwaps.inputs,
          dataToDecode,
        ) as unknown as [
          {
            fromToken: string;
            amountIn: bigint;
          },
          object[],
          string,
        ];

        return {
          type: DecodedTransactionType.TriggerSmartContract,
          operation: {
            type: DecodedTriggerSmartContractOperationType.RangoSwap,
            selector,
            fromTokenAddress:
              txRequest.fromToken.toLowerCase() === ZERO_EVM_ADDRESS
                ? 'native'
                : this.#evmAddressToTronAddress(txRequest.fromToken),
            receiverAddress: this.#evmAddressToTronAddress(receiver),
            rawAmountIn: txRequest.amountIn,
          },
        };
      }
    } catch {
      throw new TransactionDecodingError('MalformedKnownSelectorData');
    }

    return {
      type: DecodedTransactionType.TriggerSmartContract,
      operation: {
        type: DecodedTriggerSmartContractOperationType.UnknownContractCall,
        selector,
      },
    };
  }

  #evmAddressToTronAddress(hex20Address: string): string {
    const normalizedHex20 = remove0x(hex20Address.toLowerCase());
    return TronWeb.address.fromHex(`41${normalizedHex20}`);
  }
}
