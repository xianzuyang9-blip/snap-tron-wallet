import { parseCaipAssetType } from '@metamask/utils';
import { BigNumber } from 'bignumber.js';
import { formatUnits } from 'ethers';
import type { TronWeb } from 'tronweb';
import type {
  BroadcastReturn,
  Transaction,
  Transaction as TronTransaction,
  TransferAssetContract,
  TransferContract,
  TriggerSmartContract,
} from 'tronweb/lib/esm/types';

import { SendValidationError } from './errors';
import type { FeeCalculatorService } from './FeeCalculatorService';
import type { SendValidationResult } from './types';
import type { SnapClient } from '../../clients/snap/SnapClient';
import type { TronWebFactory } from '../../clients/tronweb/TronWebFactory';
import type { Network } from '../../constants';
import { Networks, ZERO } from '../../constants';
import type { AssetEntity } from '../../entities/assets';
import { SendErrorCodes } from '../../handlers/clientRequest/types';
import { BackgroundEventMethod } from '../../handlers/cronjob';
import { toRawAmount, trxToSun } from '../../utils/conversion';
import { createPrefixedLogger, type ILogger } from '../../utils/logger';
import { assertTransactionSignerConsistency } from '../../validation/transaction';
import type { AccountsService } from '../accounts/AccountsService';
import type { AssetsService } from '../assets/AssetsService';
import type { TransactionExpirationRefresherService } from '../transaction-expiration-refresher/TransactionExpirationRefresherService';
import type { TransactionDecoder } from '../transactions/TransactionDecoder';
import type {
  DecodedTransaction,
  TransactionRawData,
} from '../transactions/types';

type TransactionAffordabilitySpend = {
  asset: AssetEntity;
  amount: BigNumber;
};

export class SendService {
  readonly #accountsService: AccountsService;

  readonly #assetsService: AssetsService;

  readonly #tronWebFactory: TronWebFactory;

  readonly #feeCalculatorService: FeeCalculatorService;

  readonly #logger: ILogger;

  readonly #snapClient: SnapClient;

  readonly #transactionDecoder: TransactionDecoder;

  readonly #transactionExpirationRefresherService: TransactionExpirationRefresherService;

  constructor({
    accountsService,
    assetsService,
    tronWebFactory,
    feeCalculatorService,
    logger,
    snapClient,
    transactionDecoder,
    transactionExpirationRefresherService,
  }: {
    accountsService: AccountsService;
    assetsService: AssetsService;
    tronWebFactory: TronWebFactory;
    feeCalculatorService: FeeCalculatorService;
    logger: ILogger;
    snapClient: SnapClient;
    transactionDecoder: TransactionDecoder;
    transactionExpirationRefresherService: TransactionExpirationRefresherService;
  }) {
    this.#accountsService = accountsService;
    this.#assetsService = assetsService;
    this.#tronWebFactory = tronWebFactory;
    this.#feeCalculatorService = feeCalculatorService;
    this.#logger = createPrefixedLogger(logger, '[💸 SendService]');
    this.#snapClient = snapClient;
    this.#transactionDecoder = transactionDecoder;
    this.#transactionExpirationRefresherService =
      transactionExpirationRefresherService;
  }

  /**
   * Validates that the user has enough funds to complete the send operation.
   * This includes both the amount being sent and all associated fees
   * (bandwidth, energy overages, and account activation if applicable).
   *
   * @param params - The validation parameters.
   * @param params.scope - The network scope.
   * @param params.fromAccountId - The account ID to send from.
   * @param params.toAddress - The recipient address.
   * @param params.asset - The asset being sent.
   * @param params.amount - The amount to send (in UI units, e.g., TRX not SUN).
   * @param params.feeLimit - The feeLimit to set for the built transaction
   * @returns A validation result indicating if the send can proceed.
   */
  async validateSendAffordability({
    scope,
    fromAccountId,
    toAddress,
    asset,
    amount,
    feeLimit,
  }: {
    scope: Network;
    fromAccountId: string;
    toAddress: string;
    asset: AssetEntity;
    amount: BigNumber;
    feeLimit?: number;
  }): Promise<SendValidationResult> {
    this.#logger.log('Validating send', {
      scope,
      fromAccountId,
      toAddress,
      assetType: asset.assetType,
      amount: amount.toString(),
    });

    const nativeTokenId = Networks[scope].nativeToken.id;
    const isNativeToken = asset.assetType === nativeTokenId;

    /**
     * Get the user's current balances for the asset being sent and TRX (for fees).
     */
    const [assetBalance, nativeTokenAsset, bandwidthAsset, energyAsset] =
      await this.#assetsService.getAssetsByAccountId(fromAccountId, [
        asset.assetType,
        nativeTokenId,
        Networks[scope].bandwidth.id,
        Networks[scope].energy.id,
      ]);

    const assetToSendBalance = assetBalance
      ? new BigNumber(assetBalance.uiAmount)
      : ZERO;
    const nativeTokenBalance = nativeTokenAsset
      ? new BigNumber(nativeTokenAsset.uiAmount)
      : ZERO;
    const availableBandwidth = bandwidthAsset
      ? new BigNumber(bandwidthAsset.rawAmount)
      : ZERO;
    const availableEnergy = energyAsset
      ? new BigNumber(energyAsset.rawAmount)
      : ZERO;

    /**
     * First check: Does the user have enough of the asset they want to send?
     */
    if (amount.isGreaterThan(assetToSendBalance)) {
      this.#logger.log('Insufficient balance for asset being sent', {
        amount: amount.toString(),
        assetBalance: assetToSendBalance.toString(),
      });
      return {
        valid: false,
        errorCode: SendErrorCodes.InsufficientBalance,
      };
    }

    /**
     * Build the transaction with the ACTUAL toAddress to properly calculate
     * account activation fees if the recipient is not yet activated.
     */
    const transaction = await this.buildTransaction({
      fromAccountId,
      toAddress,
      asset,
      amount,
      feeLimit,
    });

    /**
     * Calculate the fees including:
     * - Bandwidth costs (or TRX if insufficient bandwidth)
     * - Energy costs (or TRX if insufficient energy)
     * - Account activation fee (1 TRX if recipient is not activated)
     */
    const fees = await this.#feeCalculatorService.computeFee({
      scope,
      transaction,
      availableEnergy,
      availableBandwidth,
      feeLimit,
    });

    /**
     * Extract the TRX fee from the computed fees.
     * The fee calculation already accounts for bandwidth/energy consumption,
     * so we only need to check the TRX overage cost.
     */
    const trxFee = new BigNumber(
      fees.find((fee) => fee.asset.type === nativeTokenId)?.asset.amount ?? '0',
    );

    /**
     * Calculate total TRX needed:
     * - If sending TRX: amount + fees
     * - If sending a token: just fees (but we still need TRX to pay them)
     */
    const totalTrxNeeded = isNativeToken ? amount.plus(trxFee) : trxFee;

    this.#logger.log('Validation calculation', {
      isNativeToken,
      amount: amount.toString(),
      trxFee: trxFee.toString(),
      totalTrxNeeded: totalTrxNeeded.toString(),
      nativeTokenBalance: nativeTokenBalance.toString(),
    });

    /**
     * Second check: Does the user have enough TRX to cover the total cost?
     */
    if (totalTrxNeeded.isGreaterThan(nativeTokenBalance)) {
      this.#logger.log('Insufficient TRX balance to cover fees', {
        totalTrxNeeded: totalTrxNeeded.toString(),
        nativeTokenBalance: nativeTokenBalance.toString(),
      });
      return {
        valid: false,
        errorCode: SendErrorCodes.InsufficientBalanceToCoverFee,
      };
    }

    return { valid: true };
  }

  async validateTransactionAffordability({
    scope,
    fromAccountId,
    transaction,
  }: {
    scope: Network;
    fromAccountId: string;
    transaction: TronTransaction;
  }): Promise<void> {
    const rawData = transaction.raw_data as TransactionRawData;
    const decodedTransaction = this.#transactionDecoder.decode(rawData);

    /**
     * Some dapp-submitted transactions are opaque to this validator, such as
     * non-trigger contracts, trigger contracts without calldata, or unknown
     * contract selectors. In those cases we avoid making a partial balance
     * assertion that could incorrectly block a transaction.
     */
    if (this.#transactionDecoder.isValidationSkipped(decodedTransaction)) {
      return;
    }

    const feeLimit = this.#getTransactionFeeLimit(rawData);

    /**
     * Approvals authorize future token movement but do not spend the token in
     * this transaction, so affordability only needs to cover the TRX fee.
     */
    if (this.#transactionDecoder.isFeeOnlyOperation(decodedTransaction)) {
      await this.#assertTransactionAffordability({
        scope,
        fromAccountId,
        transaction,
        feeLimit,
      });
      return;
    }

    const spend = await this.#getTrackedTransactionSpend({
      scope,
      fromAccountId,
      decodedTransaction,
    });

    await this.#assertTransactionAffordability({
      scope,
      fromAccountId,
      transaction,
      feeLimit,
      spend,
    });
  }

  async buildTransaction({
    fromAccountId,
    toAddress,
    asset,
    amount,
    feeLimit,
  }: {
    fromAccountId: string;
    toAddress: string;
    asset: AssetEntity;
    amount: BigNumber;
    feeLimit?: number;
  }): Promise<
    | Transaction<TransferContract>
    | Transaction<TransferAssetContract>
    | Transaction<TriggerSmartContract>
  > {
    const { chainId, assetNamespace, assetReference } = parseCaipAssetType(
      asset.assetType,
    );

    try {
      switch (assetNamespace) {
        case 'slip44':
          this.#logger.log('Sending TRX transaction');
          return this.buildSendTrxTransaction({
            scope: chainId as Network,
            fromAccountId,
            toAddress,
            amount,
            feeLimit,
          });

        case 'trc10':
          this.#logger.log(`Sending TRC10 token: ${assetReference}`);
          return this.buildSendTrc10Transaction({
            scope: chainId as Network,
            fromAccountId,
            toAddress,
            amount,
            tokenId: assetReference,
            decimals: asset.decimals,
            feeLimit,
          });

        case 'trc20':
          this.#logger.log(`Sending TRC20 token: ${assetReference}`);
          return this.buildSendTrc20Transaction({
            scope: chainId as Network,
            fromAccountId,
            toAddress,
            contractAddress: assetReference,
            amount,
            decimals: asset.decimals,
            feeLimit,
          });

        default:
          throw new Error(`Unsupported asset namespace: ${assetNamespace}`);
      }
    } catch (error) {
      this.#logger.error({ error }, 'Failed to send asset');
      throw new Error(
        `Failed to send asset: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async buildSendTrxTransaction({
    scope,
    fromAccountId,
    toAddress,
    amount,
    feeLimit,
  }: {
    scope: Network;
    fromAccountId: string;
    toAddress: string;
    amount: BigNumber;
    feeLimit?: number;
  }): Promise<Transaction<TransferContract>> {
    const account = await this.#accountsService.findByIdOrThrow(fromAccountId);

    const tronWeb = this.#tronWebFactory.createClient(scope);

    const amountInSun = Number(trxToSun(amount));
    const transaction = await tronWeb.transactionBuilder.sendTrx(
      toAddress,
      amountInSun,
      account.address,
    );
    this.#setFeeLimit(tronWeb, transaction, feeLimit);
    return transaction;
  }

  async buildSendTrc10Transaction({
    scope,
    fromAccountId,
    toAddress,
    amount,
    tokenId,
    decimals,
    feeLimit,
  }: {
    scope: Network;
    fromAccountId: string;
    toAddress: string;
    amount: BigNumber;
    tokenId: string;
    decimals: number;
    feeLimit?: number;
  }): Promise<Transaction<TransferAssetContract>> {
    const account = await this.#accountsService.findByIdOrThrow(fromAccountId);

    const tronWeb = this.#tronWebFactory.createClient(scope);

    const rawAmount = Number(toRawAmount(amount, decimals));

    const transaction = await tronWeb.transactionBuilder.sendToken(
      toAddress,
      rawAmount,
      tokenId,
      account.address,
    );
    this.#setFeeLimit(tronWeb, transaction, feeLimit);
    return transaction;
  }

  async buildSendTrc20Transaction({
    scope,
    fromAccountId,
    toAddress,
    contractAddress,
    amount,
    decimals,
    feeLimit,
  }: {
    scope: Network;
    fromAccountId: string;
    toAddress: string;
    contractAddress: string;
    amount: BigNumber;
    decimals: number;
    feeLimit?: number;
  }): Promise<Transaction<TriggerSmartContract>> {
    const account = await this.#accountsService.findByIdOrThrow(fromAccountId);

    const tronWeb = this.#tronWebFactory.createClient(scope);

    const functionSelector = 'transfer(address,uint256)';
    const decimalsAdjustedAmount = toRawAmount(amount, decimals);
    const parameter = [
      { type: 'address', value: toAddress },
      { type: 'uint256', value: decimalsAdjustedAmount },
    ];

    const contractResult =
      await tronWeb.transactionBuilder.triggerSmartContract(
        contractAddress,
        functionSelector,
        feeLimit ? { feeLimit } : {},
        parameter,
        account.address,
      );

    return contractResult.transaction;
  }

  async signAndSendTransaction({
    scope,
    fromAccountId,
    transaction,
    origin = 'MetaMask',
  }: {
    scope: Network;
    fromAccountId: string;
    transaction:
      | Transaction<TransferContract>
      | Transaction<TransferAssetContract>
      | Transaction<TriggerSmartContract>;
    origin?: string;
    // TODO: Replace `any` with type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<BroadcastReturn<any>> {
    const account = await this.#accountsService.findByIdOrThrow(fromAccountId);

    /**
     * Derive the private key for signing
     */
    const { privateKeyHex, address: signerAddress } =
      await this.#accountsService.deriveTronKeypair({
        entropySource: account.entropySource,
        derivationPath: account.derivationPath,
      });

    assertTransactionSignerConsistency(transaction.raw_data, signerAddress);

    const tronWeb = this.#tronWebFactory.createClient(scope, privateKeyHex);

    const freshTransaction =
      await this.#transactionExpirationRefresherService.ensureFreshMetadata({
        scope,
        transaction,
      });

    /**
     * Sign and send the transaction atomically after user confirmation
     */
    const signedTransaction = await tronWeb.trx.sign(freshTransaction);
    const result = await tronWeb.trx.sendRawTransaction(signedTransaction);

    if (!result.result) {
      throw new Error(`Failed to send transaction: ${result.message}`);
    }

    await this.#snapClient.trackTransactionSubmitted({
      origin,
      accountType: account.type,
      chainIdCaip: scope,
    });

    await this.#snapClient.scheduleBackgroundEvent({
      method: BackgroundEventMethod.TrackTransaction,
      params: {
        txId: result.txid,
        scope,
        accountIds: [fromAccountId],
        attempt: 0,
      },
      duration: 'PT1S',
    });

    return result;
  }

  /**
   * Asserts that the account can pay a custom dapp-submitted transaction.
   *
   * When `spend` is provided, this checks both the decoded asset amount and the
   * TRX fee. Without `spend`, it treats the transaction as fee-only, which is
   * used for approvals and decoded spends whose asset is not tracked locally.
   *
   * @param options0 - The transaction affordability assertion parameters.
   * @param options0.scope - The network scope.
   * @param options0.fromAccountId - The account ID paying for the transaction.
   * @param options0.transaction - The transaction to inspect for fee costs.
   * @param options0.feeLimit - The transaction fee limit, if present.
   * @param options0.spend - The decoded tracked asset spend, if known.
   */
  async #assertTransactionAffordability({
    scope,
    fromAccountId,
    transaction,
    feeLimit,
    spend,
  }: {
    scope: Network;
    fromAccountId: string;
    transaction: TronTransaction;
    feeLimit?: number;
    spend?: TransactionAffordabilitySpend;
  }): Promise<void> {
    const nativeTokenId = Networks[scope].nativeToken.id;
    const bandwidthId = Networks[scope].bandwidth.id;
    const energyId = Networks[scope].energy.id;
    const assetTypes = spend
      ? [spend.asset.assetType, nativeTokenId, bandwidthId, energyId]
      : [nativeTokenId, bandwidthId, energyId];

    const assets = await this.#assetsService.getAssetsByAccountId(
      fromAccountId,
      assetTypes,
    );

    const [spendAsset, nativeTokenAsset, bandwidthAsset, energyAsset] = spend
      ? assets
      : [null, ...assets];

    if (spend) {
      const spendAssetBalance = spendAsset
        ? new BigNumber(spendAsset.uiAmount)
        : ZERO;

      if (spend.amount.isGreaterThan(spendAssetBalance)) {
        throw new SendValidationError(SendErrorCodes.InsufficientBalance);
      }
    }

    const nativeTokenBalance = nativeTokenAsset
      ? new BigNumber(nativeTokenAsset.uiAmount)
      : ZERO;
    const availableBandwidth = bandwidthAsset
      ? new BigNumber(bandwidthAsset.rawAmount)
      : ZERO;
    const availableEnergy = energyAsset
      ? new BigNumber(energyAsset.rawAmount)
      : ZERO;

    const fees = await this.#feeCalculatorService.computeFee({
      scope,
      transaction,
      availableEnergy,
      availableBandwidth,
      feeLimit,
    });

    const trxFee = new BigNumber(
      fees.find((fee) => fee.asset.type === nativeTokenId)?.asset.amount ?? '0',
    );
    const requiredTrx =
      spend?.asset.assetType === nativeTokenId
        ? spend.amount.plus(trxFee)
        : trxFee;

    if (requiredTrx.isGreaterThan(nativeTokenBalance)) {
      throw new SendValidationError(
        SendErrorCodes.InsufficientBalanceToCoverFee,
      );
    }
  }

  /**
   * Returns the spend details for decoded transaction types we can map to a
   * tracked asset balance, such as TRC20 transfers and supported swap calls.
   *
   * Returns `undefined` when the transaction has no immediate asset spend or
   * when the token exists on-chain but is not tracked by this account.
   *
   * @param options0 - The spend lookup parameters.
   * @param options0.scope - The network scope.
   * @param options0.fromAccountId - The account ID whose tracked assets are used.
   * @param options0.decodedTransaction - The decoded transaction to inspect.
   * @returns The tracked asset spend details, or `undefined` for fee-only validation.
   */
  async #getTrackedTransactionSpend({
    scope,
    fromAccountId,
    decodedTransaction,
  }: {
    scope: Network;
    fromAccountId: string;
    decodedTransaction: DecodedTransaction;
  }): Promise<TransactionAffordabilitySpend | undefined> {
    const spendDetails = this.#transactionDecoder.getSpendDetails({
      decodedTransaction,
      scope,
    });

    if (!spendDetails) {
      return undefined;
    }

    const asset = await this.#assetsService.getAssetByAccountId(
      fromAccountId,
      spendDetails.assetId,
    );

    /**
     * Dapps can submit transactions for valid on-chain tokens that are not yet
     * tracked in this account's local asset list. In that case we cannot compare
     * the token amount against a known balance, but we can still assert the user
     * has enough TRX to pay the transaction fees.
     */
    if (!asset) {
      return undefined;
    }

    return {
      asset,
      amount: new BigNumber(
        formatUnits(spendDetails.rawAmount, asset.decimals),
      ),
    };
  }

  #getTransactionFeeLimit(rawData: TransactionRawData): number | undefined {
    return typeof rawData.fee_limit === 'number'
      ? rawData.fee_limit
      : undefined;
  }

  /**
   * Applies a fee limit to a TRON transaction and rebuilds its derived fields.
   *
   * When `feeLimit` is provided, this method:
   * - sets `transaction.raw_data.fee_limit`
   * - regenerates `raw_data_hex`
   * - recalculates `txID`
   *
   * @param tronWeb - TronWeb instance used to convert the transaction JSON into protobuf form and regenerate transaction metadata.
   * @param transaction - The TRX or TRC10 transfer transaction to update.
   * @param feeLimit - The fee limit to assign to the transaction in SUN (1 TRX = 1,000,000 SUN).
   * If `undefined` or falsy, the transaction is left unchanged.
   */
  #setFeeLimit(
    tronWeb: TronWeb,
    transaction:
      | Transaction<TransferContract>
      | Transaction<TransferAssetContract>,
    feeLimit: number | undefined,
  ): void {
    if (feeLimit !== undefined) {
      transaction.raw_data.fee_limit = feeLimit;

      const transactionPb = tronWeb.utils.transaction.txJsonToPb(transaction);

      transaction.raw_data_hex =
        tronWeb.utils.transaction.txPbToRawDataHex(transactionPb);
      transaction.txID = tronWeb.utils.transaction
        .txPbToTxID(transactionPb)
        .slice(2);
    }
  }
}
