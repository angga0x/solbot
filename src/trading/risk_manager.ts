import { appConfig } from '../config/app_config';
import { JupiterTrader } from './jupiter_trader';
import * as redisService from '../services/redis_service';
import { StorableMonitoredPosition } from '../services/redis_service'; // Import Storable type
import { logger } from '../utils/logger';

export interface MonitoredPosition {
  tokenMintAddress: string;
  entryPriceSol: number;
  amountTokenLamports: number;
  initialSolInvested: number;
  monitoringIntervalId?: NodeJS.Timeout;
  trader: JupiterTrader;
  tokenDecimals: number;
}

export class RiskManager {
  private monitoredPositions: Map<string, MonitoredPosition> = new Map();
  private checkIntervalMs: number = 15000; // Check prices every 15 seconds
  private traderInstanceForLoadedPositions: JupiterTrader | null = null;

  constructor() {
    logger.info('RiskManager initialized.');
    // Note: Loading positions from Redis will be called explicitly from main.ts after trader is available
  }

  public setTraderInstance(trader: JupiterTrader): void {
    // Used by main.ts to provide the trader instance for rehydrating positions from Redis
    this.traderInstanceForLoadedPositions = trader;
  }

  public async loadPositionsFromRedis(): Promise<void> {
    if (!this.traderInstanceForLoadedPositions) {
        logger.error('RiskManager: Trader instance not set. Cannot load positions from Redis.');
        return;
    }
    const storablePositions = await redisService.loadActivePositions();
    logger.info(`RiskManager: Attempting to load ${storablePositions.length} positions from Redis.`);
    for (const sp of storablePositions) {
      if (!this.monitoredPositions.has(sp.tokenMintAddress)) {
        const position: MonitoredPosition = {
          tokenMintAddress: sp.tokenMintAddress,
          entryPriceSol: sp.entryPriceSol,
          amountTokenLamports: sp.amountTokenLamports,
          initialSolInvested: sp.initialSolInvested,
          tokenDecimals: sp.tokenDecimals,
          trader: this.traderInstanceForLoadedPositions, // Use the provided trader instance
          // monitoringIntervalId will be set by startMonitoringForPosition
        };
        this.startMonitoringForPosition(position, true); // true indicates it's a loaded position
      }
    }
  }
  
  private startMonitoringForPosition(position: MonitoredPosition, isLoadedFromRedis: boolean = false): void {
    if (this.monitoredPositions.has(position.tokenMintAddress) && !isLoadedFromRedis) {
      logger.warn(`RiskManager: Position for ${position.tokenMintAddress} is already being monitored (addPosition call).`);
      return;
    }

    // Ensure no duplicate interval if somehow called again for an existing in-memory position
    const existingPosition = this.monitoredPositions.get(position.tokenMintAddress);
    if (existingPosition?.monitoringIntervalId) {
        clearInterval(existingPosition.monitoringIntervalId);
    }

    const newPosition = { ...position }; // Create a new object to store in map if it's a new add
    newPosition.monitoringIntervalId = setInterval(() => {
      this.checkPosition(newPosition.tokenMintAddress).catch(error => {
        logger.error(`RiskManager: Error checking position ${newPosition.tokenMintAddress}:`, error);
      });
    }, this.checkIntervalMs);

    this.monitoredPositions.set(newPosition.tokenMintAddress, newPosition);
    if (isLoadedFromRedis) {
        logger.info(`RiskManager: Resumed monitoring for loaded position ${newPosition.tokenMintAddress}.`);
    } else {
        logger.info(`RiskManager: Started monitoring new position for ${newPosition.tokenMintAddress}. Entry: ${newPosition.entryPriceSol}, Amount: ${newPosition.amountTokenLamports / (10**newPosition.tokenDecimals)}`);
    }
  }

  public async addPosition(
    tokenMintAddress: string,
    entryPriceSol: number,
    amountTokenLamports: number,
    initialSolInvested: number,
    tokenDecimals: number,
    trader: JupiterTrader
  ): Promise<void> { // Make async
    const position: MonitoredPosition = {
      tokenMintAddress,
      entryPriceSol,
      amountTokenLamports,
      initialSolInvested,
      trader,
      tokenDecimals,
    };
    this.startMonitoringForPosition(position);
    await redisService.saveActivePosition(position); // Save to Redis
  }

  private async checkPosition(tokenMintAddress: string): Promise<void> {
    const position = this.monitoredPositions.get(tokenMintAddress);
    if (!position) return;

    const solMintAddress = 'So11111111111111111111111111111111111111112';
    const quoteResponse = await position.trader.getQuote(
      position.tokenMintAddress,
      solMintAddress, 
      position.amountTokenLamports,
      50 // Slippage for price check quote
    );

    if (!quoteResponse || !quoteResponse.outAmount) {
      logger.warn(`RiskManager: Could not get current price quote for ${tokenMintAddress}. Skipping check.`);
      return;
    }

    const currentSolValueIfSoldLamports = Number(quoteResponse.outAmount);
    const currentPriceSolPerToken = (currentSolValueIfSoldLamports / 1e9) / (position.amountTokenLamports / (10**position.tokenDecimals));
    
    logger.info(`RiskManager: ${tokenMintAddress} | Entry: ${position.entryPriceSol.toFixed(10)} | Current: ${currentPriceSolPerToken.toFixed(10)} | Value: ${(currentSolValueIfSoldLamports / 1e9).toFixed(4)} SOL`);

    const initialSolInvestedLamports = position.initialSolInvested * 1e9;
    const currentProfitPercentage = ((currentSolValueIfSoldLamports / 1e9) - position.initialSolInvested) / position.initialSolInvested;

    if (currentSolValueIfSoldLamports >= initialSolInvestedLamports * (1 + appConfig.takeProfitPercentage)) {
      logger.info(`RiskManager: TAKE PROFIT for ${tokenMintAddress}. Value: ${currentSolValueIfSoldLamports/1e9} SOL vs Initial: ${position.initialSolInvested} SOL. P/L: ${currentProfitPercentage*100}%`);
      await this.executeSell(position, 'Take Profit');
    } else if (currentSolValueIfSoldLamports <= initialSolInvestedLamports * (1 - appConfig.stopLossPercentage)) {
      logger.info(`RiskManager: STOP LOSS for ${tokenMintAddress}. Value: ${currentSolValueIfSoldLamports/1e9} SOL vs Initial: ${position.initialSolInvested} SOL. P/L: ${currentProfitPercentage*100}%`);
      await this.executeSell(position, 'Stop Loss');
    }
  }

  private async executeSell(position: MonitoredPosition, reason: string): Promise<void> {
    logger.info(`RiskManager: Executing ${reason} sell for ${position.tokenMintAddress}, amount lamports: ${position.amountTokenLamports}`);
    
    const txid = await position.trader.sellToken(
      position.tokenMintAddress,
      position.amountTokenLamports,
      appConfig.sellSlippageBps
    );

    if (txid) {
      logger.info(`RiskManager: ${reason} sell successful for ${position.tokenMintAddress}. TXID: ${txid}`);
      await this.removePosition(position.tokenMintAddress); // Ensure Redis is updated
    } else {
      logger.error(`RiskManager: ${reason} sell FAILED for ${position.tokenMintAddress}.`);
      logger.info(`RiskManager: Monitoring will continue for ${position.tokenMintAddress} after failed ${reason} sell.`);
    }
  }

  public async removePosition(tokenMintAddress: string): Promise<void> {
    const position = this.monitoredPositions.get(tokenMintAddress);
    if (position?.monitoringIntervalId) {
      clearInterval(position.monitoringIntervalId);
    }
    this.monitoredPositions.delete(tokenMintAddress);
    logger.info(`RiskManager: Stopped monitoring, removed ${tokenMintAddress} from memory.`);
    await redisService.removeActivePosition(tokenMintAddress);
  }

  public async stopAllMonitoring(): Promise<void> {
    logger.info('RiskManager: Stopping all position monitoring...');
    const removalPromises: Promise<void>[] = [];
    this.monitoredPositions.forEach(position => {
      if (position.monitoringIntervalId) {
        clearInterval(position.monitoringIntervalId);
      }
      // For a full stop, we might not need to remove each from Redis,
      // as loadPositionsFromRedis would re-evaluate. But for cleaner state:
      // removalPromises.push(redisService.removeActivePosition(position.tokenMintAddress));
    });
    // await Promise.all(removalPromises); // If clearing Redis on stop
    this.monitoredPositions.clear();
    logger.info('RiskManager: All monitoring stopped and in-memory positions cleared.');
  }

  public getActivePositionCount(): number {
    return this.monitoredPositions.size;
  }
}
