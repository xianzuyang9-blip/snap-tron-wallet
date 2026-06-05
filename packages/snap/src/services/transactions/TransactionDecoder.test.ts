/* eslint-disable @typescript-eslint/naming-convention */
import { AbiCoder } from 'ethers';
import { Types, TronWeb } from 'tronweb';

import { TransactionDecodingError } from './errors';
import { TransactionDecoder } from './TransactionDecoder';
import {
  DecodedTransactionType,
  DecodedTriggerSmartContractOperationType,
  type TransactionRawData,
} from './types';
import { Network, Networks } from '../../constants';

const decoder = new TransactionDecoder();
const abiCoder = AbiCoder.defaultAbiCoder();
const scope = Network.Mainnet;

const USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';
const RECEIVER_HEX = '411111111111111111111111111111111111111111';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const toEvmAddress = (tronHexAddress: string): string =>
  `0x${tronHexAddress.replace(/^41/u, '')}`;

const triggerRawData = (data?: string): TransactionRawData => ({
  contract: [
    {
      type: Types.ContractType.TriggerSmartContract,
      parameter: {
        type_url: 'type.googleapis.com/protocol.TriggerSmartContract',
        value: {
          owner_address: RECEIVER_HEX,
          contract_address: USDT_HEX,
          ...(data ? { data } : {}),
        },
      },
    },
  ],
  ref_block_bytes: '',
  ref_block_hash: '',
  expiration: 0,
  timestamp: 0,
});

const rangoSwapRawData = ({
  fromToken,
  amountIn,
}: {
  fromToken: string;
  amountIn: bigint;
}): TransactionRawData => {
  const request = [
    ZERO_ADDRESS,
    fromToken,
    toEvmAddress(USDT_HEX),
    amountIn,
    0n,
    0n,
    0n,
    ZERO_ADDRESS,
    0n,
    false,
    0,
    'MetaMask',
  ];

  const data = `14d08fca${abiCoder
    .encode(
      [
        'tuple(address requestId,address fromToken,address toToken,uint256 amountIn,uint256 platformFee,uint256 destinationExecutorFee,uint256 affiliateFee,address affiliatorAddress,uint256 minimumAmountExpected,bool feeFromInputToken,uint16 dAppTag,string dAppName)',
        'tuple(address spender,address target,address swapFromToken,address swapToToken,bool needsTransferFromUser,uint256 amount,bytes callData)[]',
        'address',
      ],
      [request, [], toEvmAddress(RECEIVER_HEX)],
    )
    .slice(2)}`;

  return triggerRawData(data);
};

describe('TransactionDecoder types', () => {
  it('creates explicit transaction decoding errors', () => {
    const error = new TransactionDecodingError('MalformedKnownSelectorData');

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('MalformedKnownSelectorData');
  });

  it('exposes stable decoded transaction discriminants', () => {
    expect(DecodedTransactionType.Unknown).toBe('unknown');
    expect(DecodedTransactionType.TriggerSmartContract).toBe(
      'trigger-smart-contract',
    );
    expect(DecodedTriggerSmartContractOperationType.Trc20Approval).toBe(
      'trc20-approval',
    );
    expect(DecodedTriggerSmartContractOperationType.Trc20Transfer).toBe(
      'trc20-transfer',
    );
    expect(DecodedTriggerSmartContractOperationType.RangoSwap).toBe(
      'rango-swap',
    );
    expect(DecodedTriggerSmartContractOperationType.UnknownContractCall).toBe(
      'unknown-contract-call',
    );
  });
});

describe('TransactionDecoder', () => {
  it('returns unknown for non-trigger transactions', () => {
    const rawData = {
      ...triggerRawData(),
      contract: [
        {
          type: Types.ContractType.TransferContract,
          parameter: {
            type_url: 'type.googleapis.com/protocol.TransferContract',
            value: {
              owner_address: RECEIVER_HEX,
              to_address: RECEIVER_HEX,
              amount: 1,
            },
          },
        },
      ],
    } as TransactionRawData;

    expect(decoder.decode(rawData)).toStrictEqual({
      type: DecodedTransactionType.Unknown,
    });
  });

  it('returns unknown for trigger transactions without calldata', () => {
    expect(decoder.decode(triggerRawData())).toStrictEqual({
      type: DecodedTransactionType.Unknown,
    });
  });

  it('returns true for unknown transactions that skip validation', () => {
    expect(decoder.isValidationSkipped(decoder.decode(triggerRawData()))).toBe(
      true,
    );
  });

  it('returns true for unknown contract calls that skip validation', () => {
    const decodedTransaction = decoder.decode(triggerRawData('ffffffff'));

    expect(decoder.isValidationSkipped(decodedTransaction)).toBe(true);
  });

  it('decodes TRC20 transfer calldata', () => {
    const data = `a9059cbb${abiCoder
      .encode(['address', 'uint256'], [toEvmAddress(RECEIVER_HEX), 123n])
      .slice(2)}`;

    expect(decoder.decode(triggerRawData(data))).toStrictEqual({
      type: DecodedTransactionType.TriggerSmartContract,
      operation: {
        type: DecodedTriggerSmartContractOperationType.Trc20Transfer,
        selector: 'a9059cbb',
        contractAddress: TronWeb.address.fromHex(USDT_HEX),
        receiverAddress: TronWeb.address.fromHex(RECEIVER_HEX),
        rawAmount: 123n,
      },
    });
  });

  it('returns TRC20 transfer spend details', () => {
    const decodedTransaction = decoder.decode(
      triggerRawData(
        `a9059cbb${abiCoder
          .encode(['address', 'uint256'], [toEvmAddress(RECEIVER_HEX), 123n])
          .slice(2)}`,
      ),
    );

    expect(
      decoder.getSpendDetails({ decodedTransaction, scope }),
    ).toStrictEqual({
      assetId: `${scope}/trc20:${TronWeb.address.fromHex(USDT_HEX)}`,
      rawAmount: 123n,
    });
  });

  it('decodes TRC20 approval calldata', () => {
    const data = `095ea7b3${abiCoder
      .encode(['address', 'uint256'], [toEvmAddress(RECEIVER_HEX), 456n])
      .slice(2)}`;

    expect(decoder.decode(triggerRawData(data))).toStrictEqual({
      type: DecodedTransactionType.TriggerSmartContract,
      operation: {
        type: DecodedTriggerSmartContractOperationType.Trc20Approval,
        selector: '095ea7b3',
        contractAddress: TronWeb.address.fromHex(USDT_HEX),
        spenderAddress: TronWeb.address.fromHex(RECEIVER_HEX),
        rawAmount: 456n,
      },
    });
  });

  it('returns true for approval fee-only operations', () => {
    const decodedTransaction = decoder.decode(
      triggerRawData(
        `095ea7b3${abiCoder
          .encode(['address', 'uint256'], [toEvmAddress(RECEIVER_HEX), 456n])
          .slice(2)}`,
      ),
    );

    expect(decoder.isFeeOnlyOperation(decodedTransaction)).toBe(true);
  });

  it('returns undefined spend details for approval operations', () => {
    const decodedTransaction = decoder.decode(
      triggerRawData(
        `095ea7b3${abiCoder
          .encode(['address', 'uint256'], [toEvmAddress(RECEIVER_HEX), 456n])
          .slice(2)}`,
      ),
    );

    expect(
      decoder.getSpendDetails({ decodedTransaction, scope }),
    ).toBeUndefined();
  });

  it('decodes Rango native-token swap calldata', () => {
    expect(
      decoder.decode(
        rangoSwapRawData({ fromToken: ZERO_ADDRESS, amountIn: 789n }),
      ),
    ).toStrictEqual({
      type: DecodedTransactionType.TriggerSmartContract,
      operation: {
        type: DecodedTriggerSmartContractOperationType.RangoSwap,
        selector: '14d08fca',
        fromTokenAddress: 'native',
        receiverAddress: TronWeb.address.fromHex(RECEIVER_HEX),
        rawAmountIn: 789n,
      },
    });
  });

  it('returns native token spend details for Rango swaps with native input', () => {
    const decodedTransaction = decoder.decode(
      rangoSwapRawData({ fromToken: ZERO_ADDRESS, amountIn: 789n }),
    );

    expect(
      decoder.getSpendDetails({ decodedTransaction, scope }),
    ).toStrictEqual({
      assetId: Networks[scope].nativeToken.id,
      rawAmount: 789n,
    });
  });

  it('returns token spend details for Rango swaps with token input', () => {
    const decodedTransaction = decoder.decode(
      rangoSwapRawData({
        fromToken: toEvmAddress(USDT_HEX),
        amountIn: 789n,
      }),
    );

    expect(
      decoder.getSpendDetails({ decodedTransaction, scope }),
    ).toStrictEqual({
      assetId: `${scope}/trc20:${TronWeb.address.fromHex(USDT_HEX)}`,
      rawAmount: 789n,
    });
  });

  it('returns unknown contract call for unmapped selectors', () => {
    expect(decoder.decode(triggerRawData('ffffffff'))).toStrictEqual({
      type: DecodedTransactionType.TriggerSmartContract,
      operation: {
        type: DecodedTriggerSmartContractOperationType.UnknownContractCall,
        selector: 'ffffffff',
      },
    });
  });

  it('returns undefined spend details for skipped and unmapped operations', () => {
    const unknownTransaction = decoder.decode({
      ...triggerRawData(),
      contract: [
        {
          type: Types.ContractType.TransferContract,
          parameter: {
            type_url: 'type.googleapis.com/protocol.TransferContract',
            value: {
              owner_address: RECEIVER_HEX,
              to_address: RECEIVER_HEX,
              amount: 1,
            },
          },
        },
      ],
    } as TransactionRawData);
    const unknownContractCall = decoder.decode(triggerRawData('ffffffff'));

    expect(
      decoder.getSpendDetails({
        decodedTransaction: unknownTransaction,
        scope,
      }),
    ).toBeUndefined();
    expect(
      decoder.getSpendDetails({
        decodedTransaction: unknownContractCall,
        scope,
      }),
    ).toBeUndefined();
  });

  it('throws a unique decoding error for too-short calldata', () => {
    expect(() => decoder.decode(triggerRawData('abc'))).toThrow(
      TransactionDecodingError,
    );
  });

  it.each(['a9059cbb', '095ea7b3', '14d08fca'])(
    'throws a unique decoding error for malformed known selector %s',
    (selector) => {
      expect(() => decoder.decode(triggerRawData(`${selector}00`))).toThrow(
        TransactionDecodingError,
      );
    },
  );
});
