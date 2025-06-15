import { appConfig } from './config/app_config';
import { PumpFunListener, NewTokenCallback } from './listeners/pumpfun_listener';
import { OnchainAnalyzer } from './analysis/onchain_analyzer';
import { JupiterTrader } from './trading/jupiter_trader';
import { RiskManager } from './trading/risk_manager';
import { TelegramNotifier } from './services/telegram_notifier';
import { logger } from './utils/logger';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getSolanaConnection, getSolBalance, getTokenAccountsByOwner, TokenAccount } from './services/solana_service'; 
import { getTraderKeypair } from './utils/wallet_utils'; 
import { getSolUsdPrice, getUsdToIdrRate, getMultipleTokenPricesUsd } from './services/price_service';
import * as redisService from './services/redis_service'; 

const SOL_MINT_ADDRESS_MAINNET = 'So11111111111111111111111111111111111111112'; // Define SOL mint address

let initialSolBalanceAtFirstEverRun: number | null = null; 
let historicalInitialTotalUsdValue: number = 0; 
let historicalInitialTotalIdrValue: number = 0; 

let balanceCheckIntervalId: NodeJS.Timeout | null = null;

async function main() {
  logger.info("----------------------------------------------------");
  logger.info("--- Solana Sniper Bot Starting ---");
  logger.info("----------------------------------------------------");

  if (!appConfig.walletPrivateKey) {
    logger.error("CRITICAL: WALLET_PRIVATE_KEY is not set. Bot cannot operate.");
    return;
  }
  if (!appConfig.pumpFunWebsocketUrl) {
    logger.error("CRITICAL: PUMPFUN_WEBSOCKET_URL is not set. Bot cannot listen.");
    return; 
  }
  
  getSolanaConnection(); 
  redisService.getRedisClient(); 

  const trader = new JupiterTrader();
  await new Promise(resolve => setTimeout(resolve, 3000)); 

  const analyzer = new OnchainAnalyzer();
  const riskManager = new RiskManager();
  riskManager.setTraderInstance(trader); 
  await riskManager.loadPositionsFromRedis(); 

  const pumpListener = new PumpFunListener();
  const notifier = new TelegramNotifier(); 
  const walletKeypair = getTraderKeypair();

  const getFormattedTimestamp = () => {
    return new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Jakarta', hour12: false, year: 'numeric', month: '2-digit', 
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  };

  if (walletKeypair) {
    const latestSnapshot = await redisService.loadLatestPortfolioSnapshot();
    initialSolBalanceAtFirstEverRun = await getSolBalance(walletKeypair.publicKey);

    if (latestSnapshot) {
      historicalInitialTotalUsdValue = latestSnapshot.initialTotalUsdValue; 
      historicalInitialTotalIdrValue = latestSnapshot.initialTotalIdrValue;
      logger.info(`Loaded latest portfolio snapshot. Historical Initial USD: $${historicalInitialTotalUsdValue.toFixed(2)}, Historical Initial IDR: Rp${historicalInitialTotalIdrValue.toLocaleString('id-ID')}`);
      logger.info(`Current SOL balance at startup: ${initialSolBalanceAtFirstEverRun?.toFixed(4) ?? 'N/A'} SOL`);

    } else if (initialSolBalanceAtFirstEverRun !== null) {
      const solToUsdRate = await getSolUsdPrice();
      const usdToIdrRate = await getUsdToIdrRate();
      historicalInitialTotalUsdValue = initialSolBalanceAtFirstEverRun * solToUsdRate;
      historicalInitialTotalIdrValue = historicalInitialTotalUsdValue * usdToIdrRate;
      
      const timestamp = getFormattedTimestamp();
      logger.info(`No previous portfolio snapshot. Initializing with current: ${initialSolBalanceAtFirstEverRun.toFixed(4)} SOL | $${historicalInitialTotalUsdValue.toFixed(2)} USD | Rp${historicalInitialTotalIdrValue.toLocaleString('id-ID')} IDR at ${timestamp}`);
      
      const firstSnapshot: redisService.PortfolioSnapshot = {
        timestamp,
        initialSolBalance: initialSolBalanceAtFirstEverRun,
        currentSolBalance: initialSolBalanceAtFirstEverRun,
        initialTotalUsdValue: historicalInitialTotalUsdValue,
        currentTotalUsdPortfolioValue: historicalInitialTotalUsdValue,
        initialTotalIdrValue: historicalInitialTotalIdrValue,
        currentTotalIdrPortfolioValue: historicalInitialTotalIdrValue,
        heldTokensBreakdown: ""
      };
      await redisService.savePortfolioSnapshot(firstSnapshot);
      if (appConfig.enableTelegramBalanceUpdates) {
        await notifier.sendMessage(notifier.formatBalanceUpdateMessage(
            initialSolBalanceAtFirstEverRun, initialSolBalanceAtFirstEverRun,
            historicalInitialTotalUsdValue, historicalInitialTotalUsdValue,
            historicalInitialTotalIdrValue, historicalInitialTotalIdrValue,
            "", timestamp
        ));
      }
    } else {
      logger.warn("Could not fetch initial SOL balance to create first portfolio snapshot.");
    }
  } else {
    logger.error("CRITICAL: Could not load trader keypair for balance operations.");
  }

  if (appConfig.balanceCheckIntervalMs > 0 && walletKeypair) {
    balanceCheckIntervalId = setInterval(async () => {
      const currentSolBalance = await getSolBalance(walletKeypair.publicKey);
      if (currentSolBalance !== null && initialSolBalanceAtFirstEverRun !== null) {
        const solToUsdRate = await getSolUsdPrice();
        const usdToIdrRate = await getUsdToIdrRate();
        
        let currentTotalUsdPortfolioValue = currentSolBalance * solToUsdRate;
        let heldTokensBreakdown = "";
        const heldTokenAccounts = await getTokenAccountsByOwner(walletKeypair.publicKey);
        if (heldTokenAccounts.length > 0) {
            const heldTokenMints = heldTokenAccounts.map(acc => acc.mint.toBase58());
            const tokenPricesUsd = await getMultipleTokenPricesUsd(heldTokenMints);
            for (const acc of heldTokenAccounts) {
                const price = tokenPricesUsd.get(acc.mint.toBase58()) || 0;
                const valueUsd = (acc.uiAmount || 0) * price;
                currentTotalUsdPortfolioValue += valueUsd;
                const tokenSymbol = trader.getTokenSymbol(acc.mint.toBase58()) || acc.mint.toBase58().substring(0,6)+'...';
                heldTokensBreakdown += `    - ${tokenSymbol}: ${(acc.uiAmount || 0).toFixed(4)} ($${valueUsd.toFixed(2)})\n`;
            }
        }
        
        const currentTotalIdrPortfolioValue = currentTotalUsdPortfolioValue * usdToIdrRate;
        const timestamp = getFormattedTimestamp();

        const snapshot: redisService.PortfolioSnapshot = {
            timestamp, initialSolBalance: initialSolBalanceAtFirstEverRun, currentSolBalance,
            initialTotalUsdValue: historicalInitialTotalUsdValue, currentTotalUsdPortfolioValue,
            initialTotalIdrValue: historicalInitialTotalIdrValue, currentTotalIdrPortfolioValue,
            heldTokensBreakdown: heldTokensBreakdown.trim()
        };
        await redisService.savePortfolioSnapshot(snapshot);

        logger.info(`Portfolio Update: Initial Total USD: $${historicalInitialTotalUsdValue.toFixed(2)}, Current Total USD: $${currentTotalUsdPortfolioValue.toFixed(2)}, P/L USD: $${(currentTotalUsdPortfolioValue - historicalInitialTotalUsdValue).toFixed(2)} at ${timestamp}`);
        
        if (appConfig.enableTelegramBalanceUpdates) {
          await notifier.sendMessage(notifier.formatBalanceUpdateMessage(
            initialSolBalanceAtFirstEverRun, currentSolBalance,
            historicalInitialTotalUsdValue, currentTotalUsdPortfolioValue,
            historicalInitialTotalIdrValue, currentTotalIdrPortfolioValue,
            heldTokensBreakdown.trim(), timestamp
          ));
        }
      } else {
        logger.warn("Could not fetch current SOL balance for periodic update.");
      }
    }, appConfig.balanceCheckIntervalMs);
    logger.info(`Started periodic portfolio value check every ${appConfig.balanceCheckIntervalMs / 1000} seconds.`);
  }

  const handleNewToken: NewTokenCallback = async (tokenAddress: string, tokenData: any) => {
    logger.info(`handleNewToken: ENTERED for mint: ${tokenAddress}. Raw tokenData name: ${tokenData?.name}, symbol: ${tokenData?.symbol}`);
    try {
      logger.info(`handleNewToken: Analyzing mint: ${tokenAddress}`);
      const analysisResult = await analyzer.analyzeToken(tokenAddress, tokenData); 
      logger.info(`Analysis for ${tokenAddress} completed. Passed: ${analysisResult.passed}. Details: ${JSON.stringify(analysisResult.details)}`);

      if (analysisResult.passed) {
        const activeTrades = riskManager.getActivePositionCount();
        if (activeTrades >= appConfig.maxOpenTrades) {
          logger.info(`Token ${tokenAddress} PASSED analysis, SKIPPING buy. Max open trades (${appConfig.maxOpenTrades}) reached.`);
          const skippedMessage = `⚠️ Token ${tokenAddress} passed analysis but was SKIPPED.\nReason: Max open trades limit (${appConfig.maxOpenTrades}) reached.`;
          await notifier.sendMessage(skippedMessage, { inline_keyboard: [[{ text: 'View on Pump.fun', url: `https://pump.fun/${tokenAddress}` }]] });
          return;
        }

        logger.info(`Token ${tokenAddress} PASSED analysis. Preparing to buy. Active trades: ${activeTrades}/${appConfig.maxOpenTrades}`);
        const preBuyMessageText = notifier.formatTokenMessage(tokenAddress, tokenData, analysisResult);
        await notifier.sendMessage(preBuyMessageText, { inline_keyboard: [[{ text: 'View on Pump.fun', url: `https://pump.fun/${tokenAddress}` }]] });
        
        const solAmountToSpendLamports = appConfig.solAmountPerTrade * LAMPORTS_PER_SOL;
        logger.info(`handleNewToken: Preparing to trade. Using mint: ${tokenAddress} for decimals and buy.`);
        const tokenInfo = await trader.getTokenDecimals(tokenAddress); 
        const decimals = typeof tokenInfo === 'number' ? tokenInfo : 9; 
        logger.info(`Attempting to buy ${appConfig.solAmountPerTrade} SOL worth of ${tokenAddress} (decimals: ${decimals}, slippage: ${appConfig.buySlippageBps}bps).`);
        const buyTxid = await trader.buyToken(tokenAddress, solAmountToSpendLamports);

        if (buyTxid) {
          logger.info(`Successfully bought ${tokenAddress}. TXID: ${buyTxid}`);
          const postBuyMessageText = notifier.formatTokenMessage(tokenAddress, tokenData, analysisResult, buyTxid);
          await notifier.sendMessage(postBuyMessageText, { inline_keyboard: [
              [{ text: 'View on Pump.fun', url: `https://pump.fun/${tokenAddress}` }],
              [{ text: 'View TX on Solscan', url: `https://solscan.io/tx/${buyTxid}` }]
          ]});
          
          const quoteForEntry = await trader.getQuote(SOL_MINT_ADDRESS_MAINNET, tokenAddress, solAmountToSpendLamports, 50);
          if (quoteForEntry?.outAmount) {
            const amountTokenBoughtLamports = Number(quoteForEntry.outAmount);
            const entryPriceSolPerToken = (solAmountToSpendLamports / LAMPORTS_PER_SOL) / (amountTokenBoughtLamports / (10**decimals));
            logger.info(`Adding ${tokenAddress} to RiskManager. Entry: ${entryPriceSolPerToken.toFixed(10)} SOL/Token, Amount Lamports: ${amountTokenBoughtLamports}`);
            await riskManager.addPosition(tokenAddress, entryPriceSolPerToken, amountTokenBoughtLamports, appConfig.solAmountPerTrade, decimals, trader);
          } else {
            logger.warn(`Could not get post-buy quote for ${tokenAddress} for RiskManager.`);
          }
        } else {
          logger.warn(`Failed to buy ${tokenAddress}.`);
        }
      } else {
        logger.info(`Token ${tokenAddress} FAILED analysis. Reasons: ${analysisResult.reasons.join(', ')}`);
        const failedAnalysisMessageText = notifier.formatTokenMessage(tokenAddress, tokenData, analysisResult);
        await notifier.sendMessage(failedAnalysisMessageText, { inline_keyboard: [[{ text: 'View on Pump.fun', url: `https://pump.fun/${tokenAddress}` }]] });
      }
    } catch (e: any) {
      logger.error(`Error processing token ${tokenAddress}: ${e.message}`, e.stack);
    }
    logger.info("----------------------------------------------------");
  };

  pumpListener.addTokenCallback(handleNewToken);
  pumpListener.start();

  logger.info("Bot is now running and listening for new tokens...");
  logger.info("Press Ctrl+C to stop.");

  const performShutdownTasks = async () => {
    logger.info("Performing shutdown tasks...");
    if (balanceCheckIntervalId) clearInterval(balanceCheckIntervalId);
    pumpListener.stop();
    await riskManager.stopAllMonitoring(); 

    if (walletKeypair && initialSolBalanceAtFirstEverRun !== null) {
      const finalSolBalance = await getSolBalance(walletKeypair.publicKey);
      if (finalSolBalance !== null) {
        const solToUsdRate = await getSolUsdPrice();
        const usdToIdrRate = await getUsdToIdrRate();
        let finalTotalUsdPortfolioValue = finalSolBalance * solToUsdRate;
        let heldTokensBreakdown = "";
        const heldTokenAccounts = await getTokenAccountsByOwner(walletKeypair.publicKey);
         if (heldTokenAccounts.length > 0) {
            const heldTokenMints = heldTokenAccounts.map(acc => acc.mint.toBase58());
            const tokenPricesUsd = await getMultipleTokenPricesUsd(heldTokenMints);
            for (const acc of heldTokenAccounts) {
                const price = tokenPricesUsd.get(acc.mint.toBase58()) || 0;
                const valueUsd = (acc.uiAmount || 0) * price;
                finalTotalUsdPortfolioValue += valueUsd;
                const tokenSymbol = trader.getTokenSymbol(acc.mint.toBase58()) || acc.mint.toBase58().substring(0,6)+'...';
                heldTokensBreakdown += `    - ${tokenSymbol}: ${(acc.uiAmount || 0).toFixed(4)} ($${valueUsd.toFixed(2)})\n`;
            }
        }
        const finalTotalIdrPortfolioValue = finalTotalUsdPortfolioValue * usdToIdrRate;
        const timestamp = getFormattedTimestamp();

        const finalSnapshot: redisService.PortfolioSnapshot = {
            timestamp, initialSolBalance: initialSolBalanceAtFirstEverRun, currentSolBalance: finalSolBalance,
            initialTotalUsdValue: historicalInitialTotalUsdValue, currentTotalUsdPortfolioValue: finalTotalUsdPortfolioValue,
            initialTotalIdrValue: historicalInitialTotalIdrValue, currentTotalIdrPortfolioValue: finalTotalIdrPortfolioValue,
            heldTokensBreakdown: heldTokensBreakdown.trim()
        };
        await redisService.savePortfolioSnapshot(finalSnapshot);
        
        logger.info(`FINAL Portfolio Value: Initial Total USD: $${historicalInitialTotalUsdValue.toFixed(2)}, Final Total USD: $${finalTotalUsdPortfolioValue.toFixed(2)}, P/L USD: $${(finalTotalUsdPortfolioValue - historicalInitialTotalUsdValue).toFixed(2)} at ${timestamp}`);
        
        if (appConfig.enableTelegramBalanceUpdates) {
          const finalMsg = `🚨 *Bot Shutting Down - Final Portfolio Report* 🚨\n\n` +
            notifier.formatBalanceUpdateMessage(
              initialSolBalanceAtFirstEverRun, finalSolBalance,
              historicalInitialTotalUsdValue, finalTotalUsdPortfolioValue,
              historicalInitialTotalIdrValue, finalTotalIdrPortfolioValue,
              heldTokensBreakdown.trim(), timestamp
            );
          await notifier.sendMessage(finalMsg);
        }
      } else {
        logger.warn("Could not fetch final SOL balance on shutdown.");
      }
    }
    const client = redisService.getRedisClient();
    if (client) {
        await client.quit();
        logger.info("Redis client disconnected.");
    }
    logger.info("Bot shutdown complete.");
  };

  process.on('SIGINT', async () => {
    logger.info("SIGINT received. Shutting down bot...");
    await performShutdownTasks();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    logger.info("SIGTERM received. Shutting down bot...");
    await performShutdownTasks();
    process.exit(0);
  });
}

main().catch(err => {
  logger.error("Unhandled error in main function:", err);
  const client = redisService.getRedisClient();
  if (client) {
      client.quit().then(() => process.exit(1)).catch(() => process.exit(1));
  } else {
    process.exit(1);
  }
});
