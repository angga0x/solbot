import { createJupiterApiClient, QuoteResponse } from '@jup-ag/api';
import { Connection, Keypair, PublicKey, VersionedTransaction, Transaction, ConfirmedSignatureInfo, ComputeBudgetProgram } from '@solana/web3.js';
import { Wallet } from '@project-serum/anchor';
import { appConfig } from '../config/app_config';
import { getSolanaConnection } from '../services/solana_service';
import { getTraderKeypair } from '../utils/wallet_utils';
import { logger } from '../utils/logger'; // Import logger
import fetch from 'cross-fetch';

const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';
const SOL_MINT = new PublicKey(SOL_MINT_ADDRESS);
const JUPITER_STRICT_TOKEN_LIST_URL = 'https://token.jup.ag/strict';

export interface JupiterToken {
  address: string;
  chainId: number;
  decimals: number;
  name: string;
  symbol: string;
  logoURI?: string;
  tags?: string[];
}

export class JupiterTrader {
  private connection: Connection;
  private wallet: Wallet;
  private keypair: Keypair;
  private jupiterApi: ReturnType<typeof createJupiterApiClient>;
  private tokenMap: Map<string, JupiterToken> = new Map();

  constructor() {
    this.connection = getSolanaConnection();
    this.keypair = getTraderKeypair();
    this.wallet = new Wallet(this.keypair);
    this.jupiterApi = createJupiterApiClient(); // Default factory
    logger.info('JupiterTrader: Jupiter API client configured.');
    this.loadTokenList().catch(error => {
        logger.error("JupiterTrader: Failed to load token list on construction", error);
    });
  }
  
  private async loadTokenList(): Promise<void> {
    try {
      const response = await fetch(JUPITER_STRICT_TOKEN_LIST_URL);
      if (!response.ok) {
        throw new Error(`Failed to fetch token list: ${response.statusText}`);
      }
      const tokens: JupiterToken[] = await response.json();
      tokens.forEach((token) => {
        this.tokenMap.set(token.address, token); 
      });
      logger.info(`JupiterTrader: Loaded ${this.tokenMap.size} tokens from Jupiter strict list.`);
    } catch (error) {
      logger.error('JupiterTrader: Error loading token list:', error);
    }
  }

  public async getQuote(
    inputMintAddress: string,
    outputMintAddress: string,
    amountLamports: number,
    slippageBps: number
  ): Promise<QuoteResponse | null> {
    try {
      const quoteResponse = await this.jupiterApi.quoteGet({
        inputMint: inputMintAddress,
        outputMint: outputMintAddress,
        amount: amountLamports,
        slippageBps,
      });
      return quoteResponse;
    } catch (error) {
      logger.error(`JupiterTrader: Error getting quote for ${inputMintAddress} -> ${outputMintAddress}:`, error);
      return null;
    }
  }
  
  private async submitTransaction(
    swapTransaction: string
  ): Promise<string | null> {
    try {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
      let transaction: VersionedTransaction | Transaction;
      try {
        transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      } catch (e) {
        transaction = Transaction.from(swapTransactionBuf);
      }

      if (transaction instanceof VersionedTransaction) {
        transaction.sign([this.keypair]);
      } else {
        if (!transaction.signature) {
            transaction.partialSign(this.keypair);
        }
      }
      
      const rawTransaction = transaction.serialize();
      const txid = await this.connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
        maxRetries: 5,
      });
      
      logger.info(`JupiterTrader: Transaction sent. TXID: ${txid}. Waiting for confirmation...`);
      
      const confirmationResult = await this.connection.confirmTransaction({
        signature: txid,
        blockhash: blockhash,
        lastValidBlockHeight: lastValidBlockHeight
      }, 'confirmed');

      if (confirmationResult.value.err) {
        logger.error('JupiterTrader: Transaction failed confirmation:', confirmationResult.value.err);
        return null;
      }
      logger.info(`JupiterTrader: Transaction confirmed. TXID: ${txid}`);
      return txid;
    } catch (error) {
      logger.error('JupiterTrader: Error submitting transaction:', error);
      return null;
    }
  }

  private async _getDynamicPriorityFee(): Promise<number> {
    if (!appConfig.enableDynamicPriorityFees) {
      logger.info(`JupiterTrader: Dynamic priority fees disabled, using default: ${appConfig.defaultPriorityFeeMicroLamports} microLamports`);
      return appConfig.defaultPriorityFeeMicroLamports;
    }
    try {
      const fees = await this.connection.getRecentPrioritizationFees(); // Add await here
      if (fees.length === 0) {
        logger.warn("JupiterTrader: No recent prioritization fees found, using default.");
        return appConfig.defaultPriorityFeeMicroLamports;
      }
      const sortedFees = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
      logger.debug(`JupiterTrader: Sorted recent fees (${sortedFees.length} samples): ${JSON.stringify(sortedFees)}`);
      
      const percentileIndex = Math.floor(sortedFees.length * appConfig.dynamicPriorityFeePercentile);
      const dynamicFee = sortedFees[Math.min(percentileIndex, sortedFees.length - 1)];
      logger.debug(`JupiterTrader: Percentile index: ${percentileIndex}, Calculated dynamic fee: ${dynamicFee}`);

      if (dynamicFee > 0) {
        logger.info(`JupiterTrader: Dynamic priority fee calculated: ${dynamicFee} microLamports (using ${appConfig.dynamicPriorityFeePercentile * 100}th percentile of ${sortedFees.length} fee samples)`);
        return dynamicFee;
      } else {
        logger.warn(`JupiterTrader: Calculated dynamic priority fee is 0 or invalid (fees might all be 0). Raw fees: ${JSON.stringify(fees)}. Using default priority fee.`);
        return appConfig.defaultPriorityFeeMicroLamports;
      }
    } catch (error) {
      logger.error("JupiterTrader: Error fetching or calculating dynamic priority fee, using default:", error);
      return appConfig.defaultPriorityFeeMicroLamports;
    }
  }

  public async buyToken(
    outputTokenMintAddress: string,
    inputSolAmountLamports: number,
  ): Promise<string | null> {
    const slippageBpsToUse = appConfig.buySlippageBps;
    logger.info(`JupiterTrader: Attempting to buy ${outputTokenMintAddress} with ${inputSolAmountLamports} SOL lamports. Slippage: ${slippageBpsToUse} bps.`);
    const quoteResponse = await this.getQuote(SOL_MINT_ADDRESS, outputTokenMintAddress, inputSolAmountLamports, slippageBpsToUse);

    if (!quoteResponse) {
      logger.error('JupiterTrader: Could not get quote for buy transaction.');
      return null;
    }
    
    const outputTokenInfo = this.tokenMap.get(outputTokenMintAddress) || {decimals: 9, symbol: 'Unknown'};
    logger.info(`JupiterTrader: Quote received. Expected out: ${Number(quoteResponse.outAmount) / (10 ** outputTokenInfo.decimals)} ${outputTokenInfo.symbol}`);
    
    const priorityFeeToUse = await this._getDynamicPriorityFee();

    try {
      const swapResponse = await this.jupiterApi.swapPost({
        swapRequest: {
          quoteResponse,
          userPublicKey: this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          computeUnitPriceMicroLamports: priorityFeeToUse,
        }
      });
      return this.submitTransaction(swapResponse.swapTransaction);
    } catch (error) {
      logger.error('JupiterTrader: Error executing buy swap:', error);
      return null;
    }
  }

  public async sellToken(
    inputTokenMintAddress: string,
    inputTokenAmountLamports: number,
    slippageBps?: number 
  ): Promise<string | null> {
    const slippageBpsToUse = slippageBps !== undefined ? slippageBps : appConfig.sellSlippageBps;
    logger.info(`JupiterTrader: Attempting to sell ${inputTokenAmountLamports} of ${inputTokenMintAddress}. Slippage: ${slippageBpsToUse} bps.`);
    const quoteResponse = await this.getQuote(inputTokenMintAddress, SOL_MINT_ADDRESS, inputTokenAmountLamports, slippageBpsToUse);

    if (!quoteResponse) {
      logger.error('JupiterTrader: Could not get quote for sell transaction.');
      return null;
    }
    logger.info(`JupiterTrader: Quote received. Expected SOL out: ${Number(quoteResponse.outAmount) / 1e9}`);

    const priorityFeeToUse = await this._getDynamicPriorityFee();

    try {
      const swapResponse = await this.jupiterApi.swapPost({
        swapRequest: {
          quoteResponse,
          userPublicKey: this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          computeUnitPriceMicroLamports: priorityFeeToUse,
        }
      });
      return this.submitTransaction(swapResponse.swapTransaction);
    } catch (error) {
      logger.error('JupiterTrader: Error executing sell swap:', error);
      return null;
    }
  }
  
  public async getTokenDecimals(mintAddress: string): Promise<number> {
    const knownToken = this.tokenMap.get(mintAddress);
    if (knownToken) return knownToken.decimals;

    try {
      const mintPublicKey = new PublicKey(mintAddress);
      const mintInfoAccount = await this.connection.getParsedAccountInfo(mintPublicKey);
      if (mintInfoAccount.value && mintInfoAccount.value.data && 'parsed' in mintInfoAccount.value.data) {
        const data = mintInfoAccount.value.data as any; 
        if (data.program === 'spl-token' && data.parsed.type === 'mint') {
          return data.parsed.info.decimals;
        }
      }
    } catch (e) {
      logger.warn(`Could not fetch decimals for ${mintAddress} from chain:`, e);
    }
    logger.warn(`Decimals for ${mintAddress} not found, defaulting to 9.`);
    return 9; 
  }

  public getTokenSymbol(mintAddress: string): string | undefined {
    return this.tokenMap.get(mintAddress)?.symbol;
  }
}
