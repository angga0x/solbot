import TelegramBot from 'node-telegram-bot-api';
import { appConfig } from '../config/app_config';
import { logger } from '../utils/logger';

export class TelegramNotifier {
  private bot: TelegramBot | null = null;

  constructor() {
    if (appConfig.telegramBotToken && appConfig.telegramChatIds && appConfig.telegramChatIds.length > 0) {
      this.bot = new TelegramBot(appConfig.telegramBotToken);
      logger.info(`TelegramNotifier: Initialized successfully for chat IDs: ${appConfig.telegramChatIds.join(', ')}`);
    } else {
      logger.warn('TelegramNotifier: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_IDS is not set (or empty). Notifier will be disabled.');
    }
  }

  public async sendMessage(message: string, replyMarkup?: TelegramBot.InlineKeyboardMarkup): Promise<void> {
    if (!this.bot || !appConfig.telegramChatIds || appConfig.telegramChatIds.length === 0) {
      logger.debug('TelegramNotifier: Cannot send message, bot not initialized or no chat IDs configured.');
      return;
    }

    const options: TelegramBot.SendMessageOptions = { parse_mode: 'Markdown' };
    if (replyMarkup) {
      options.reply_markup = replyMarkup;
    }

    for (const chatId of appConfig.telegramChatIds) {
      try {
        await this.bot.sendMessage(chatId, message, options);
        logger.info(`TelegramNotifier: Message sent to chat ID ${chatId}`);
      } catch (error: any) {
        logger.error(`TelegramNotifier: Error sending message to chat ID ${chatId}: ${error.message}`, error);
      }
    }
  }

  public formatTokenMessage(
    tokenAddress: string,
    tokenData: any,
    analysisResult: { passed: boolean; details: any; reasons?: string[] },
    buyTxid?: string
  ): string {
    let message = '';
    if (analysisResult.passed) {
      message = `🚀 *New Token Alert & Analysis Passed!* 🚀\n\n`;
    } else {
      message = `⚠️ *New Token Alert & Analysis Failed!* ⚠️\n\n`;
    }

    message += `**Token Address:** \`${tokenAddress}\`\n\n`;
    // Pump.fun link will be an inline button, so removed from here.
    
    // Prioritize info from RugCheck (via analysisResult.details), then fallback to tokenData (from PumpFun event)
    const details = analysisResult.details || {};
    const rcName = details.rugCheckTokenName;
    const rcSymbol = details.rugCheckTokenSymbol;
    const rcDescription = details.rugCheckTokenDescription;
    const rcCreator = details.rugCheckCreator;

    message += `**Name:** ${rcName || tokenData?.name || 'N/A'}\n`;
    message += `**Symbol:** ${rcSymbol || tokenData?.symbol || 'N/A'}\n`;
    message += `**Description:** ${rcDescription || tokenData?.description || 'N/A'}\n`;
    message += `**Creator:** \`${rcCreator || tokenData?.creator || 'N/A'}\`\n`;
    
    // Market Cap: Use from tokenData if available, or from RugCheck if available
    const marketCap = tokenData?.usdMarketCap || details.rugCheckTotalMarketLiquidityRC; // Assuming totalMarketLiquidityRC can serve as marketcap
    if (marketCap) {
        message += `**Market Cap (USD):** $${parseFloat(marketCap).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    }

    if (analysisResult.passed) {
      message += `\n🔍 **Analysis Details (Passed):**\n`;
      if (analysisResult.details && Object.keys(analysisResult.details).length > 0) {
        this.appendAnalysisDetails(message, analysisResult.details);
      } else {
          message += `  - No specific details provided.\n`;
      }

      // Add RugCheck summary if available, even on pass
      message += this.formatRugCheckSummary(analysisResult.details);

      if (buyTxid) {
        message += `\n✅ *Successfully Bought!* ✅\n`;
        message += `**Transaction ID:** \`${buyTxid}\`\n`;
        message += `[View on Solscan](https://solscan.io/tx/${buyTxid})\n`;
      } else {
        // This state is for when analysis passed, but buy hasn't happened or failed.
        // If buyTxid is undefined, it means we are sending notification before buy attempt or buy failed.
        // The message in main.ts will clarify if it's "Attempting to Buy" or "Failed to Buy".
        // For now, we just show analysis passed. The buy status will be in a separate notification if needed or handled in main.ts logic.
      }
    } else {
      message += `\n🚫 **Analysis Details (Failed):**\n`;
      if (analysisResult.reasons && analysisResult.reasons.length > 0) {
        analysisResult.reasons.forEach(reason => {
          message += `  - ${reason}\n`;
        });
      } else {
        message += `  - No specific failure reasons provided.\n`;
      }
      // Also show details that were checked, if available
      if (analysisResult.details && Object.keys(analysisResult.details).length > 0) {
        message += `\n📋 **Checked Criteria (Failed Analysis):**\n`;
        this.appendAnalysisDetails(message, analysisResult.details, true); // Pass true to indicate it's for a failed analysis
      }
       // Add RugCheck summary if available
      message += this.formatRugCheckSummary(analysisResult.details);
    }
    
    message += `\n-----------------------------------\n`;
    return message;
  }

  private formatKey(key: string): string {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
  }

  private formatValue(value: any): string {
    if (typeof value === 'boolean') {
      return value ? 'Yes' : 'No';
    }
    if (typeof value === 'number') {
      return value.toLocaleString();
    }
    if (value === null || value === undefined) {
        return 'N/A';
    }
    if (Array.isArray(value)) {
      return value.length > 0 ? value.join(', ') : 'None';
    }
    return value.toString();
  }

  // Helper to append details, avoiding duplication for RugCheck specific keys if already handled by formatRugCheckSummary
  private appendAnalysisDetails(currentMessage: string, details: any, isFailureContext: boolean = false): string {
    let message = currentMessage; 
    const baseExcludedKeys = [
        'rugCheckScore', 'rugCheckOverallRiskLevel', 'rugCheckIndividualRisks', 
        'rugCheckIsMutableMetadata', 'rugCheckMintAuthorityEnabledRC', 
        'rugCheckFreezeAuthorityEnabledRC', 'rugCheckLpLockedPct', 
        'rugCheckPriceRC', 'rugCheckIsRugged', 'rugCheckTotalMarketLiquidityRC',
        // Also exclude the new direct token info fields if not in failure context, as they are displayed above
        'rugCheckTokenName', 'rugCheckTokenSymbol', 'rugCheckTokenDescription', 'rugCheckCreator'
    ];
    
    for (const [key, value] of Object.entries(details)) {
      // Show all details in failure context, otherwise exclude keys handled by formatRugCheckSummary
      if (isFailureContext || !baseExcludedKeys.includes(key)) {
        message += `  - ${this.formatKey(key)}: ${this.formatValue(value)}\n`;
      }
    }
    return message;
  }

  private formatRugCheckSummary(details: any): string {
    let summary = "";
    // Check if any RugCheck specific details exist before creating the section
    if (
      details.rugCheckScore !== undefined ||
      details.rugCheckOverallRiskLevel !== undefined ||
      details.rugCheckIsRugged !== undefined ||
      details.rugCheckIsMutableMetadata !== undefined ||
      details.rugCheckMintAuthorityEnabledRC !== undefined ||
      details.rugCheckFreezeAuthorityEnabledRC !== undefined ||
      details.rugCheckLpLockedPct !== undefined ||
      details.rugCheckPriceRC !== undefined ||
      (details.rugCheckIndividualRisks && details.rugCheckIndividualRisks.length > 0)
    ) {
      summary += `\n🛡️ **RugCheck Summary:**\n`;
      if (details.rugCheckIsRugged !== undefined) {
        summary += `  - Rugged Status: ${details.rugCheckIsRugged ? '*Marked as Rugged*' : 'Not Marked Rugged'}\n`;
      }
      if (details.rugCheckOverallRiskLevel) {
        summary += `  - Overall Risk Level: ${this.formatValue(details.rugCheckOverallRiskLevel)}\n`;
      }
      if (details.rugCheckScore !== undefined) {
        summary += `  - Score: ${this.formatValue(details.rugCheckScore)}\n`;
      }
       if (details.rugCheckPriceRC !== undefined) {
        summary += `  - Price (RC): ${this.formatValue(details.rugCheckPriceRC)}\n`;
      }
      if (details.rugCheckTotalMarketLiquidityRC !== undefined) {
        summary += `  - Total Liquidity (RC): $${this.formatValue(details.rugCheckTotalMarketLiquidityRC)}\n`;
      }
      if (details.rugCheckLpLockedPct !== undefined) {
        summary += `  - LP Locked Pct (RC): ${this.formatValue(details.rugCheckLpLockedPct)}%\n`;
      }
      if (details.rugCheckIsMutableMetadata !== undefined) {
        summary += `  - Mutable Metadata (RC): ${this.formatValue(details.rugCheckIsMutableMetadata)}\n`;
      }
      if (details.rugCheckMintAuthorityEnabledRC !== undefined) {
        summary += `  - Mint Authority Enabled (RC): ${this.formatValue(details.rugCheckMintAuthorityEnabledRC)}\n`;
      }
      if (details.rugCheckFreezeAuthorityEnabledRC !== undefined) {
        summary += `  - Freeze Authority Enabled (RC): ${this.formatValue(details.rugCheckFreezeAuthorityEnabledRC)}\n`;
      }
      if (details.rugCheckIndividualRisks && details.rugCheckIndividualRisks.length > 0) {
        summary += `  - Specific Risks/Warnings (RC):\n`;
        details.rugCheckIndividualRisks.forEach((risk: {name: string, level: string, description: string, score?: number}) => {
          summary += `    • ${risk.name} (Level: ${risk.level || 'N/A'}${risk.score ? `, Score: ${risk.score}` : ''}): ${risk.description || 'No description'}\n`;
        });
      }
    }
    return summary;
  }

  public formatBalanceUpdateMessage(
    initialSolBalance: number,
    currentSolBalance: number,
    initialTotalUsdValue: number, // Changed from initialUsdBalance (which was just SOL's USD value)
    currentTotalUsdPortfolioValue: number,
    initialTotalIdrValue: number, // Changed from initialIdrBalance
    currentTotalIdrPortfolioValue: number,
    heldTokensBreakdown: string, // Formatted string of held tokens
    timestamp: string
  ): string {
    const profitLossUsd = currentTotalUsdPortfolioValue - initialTotalUsdValue;
    const profitLossUsdPercent = initialTotalUsdValue > 0 ? (profitLossUsd / initialTotalUsdValue) * 100 : 0;
    
    const profitLossIdr = currentTotalIdrPortfolioValue - initialTotalIdrValue;

    const statusEmoji = profitLossUsd >= 0 ? '📈' : '📉';

    let message = `📊 *Portfolio Value Update* ${statusEmoji}\n\n`;
    message += `**Timestamp:** ${timestamp} (Asia/Jakarta)\n\n`;

    message += `--- Initial Portfolio Value ---\n`;
    message += `  SOL: ${initialSolBalance.toFixed(4)}\n`; // Keep initial SOL for reference
    message += `  USD: $${initialTotalUsdValue.toFixed(2)}\n`;
    message += `  IDR: Rp${initialTotalIdrValue.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}\n\n`;

    message += `--- Current Portfolio ---\n`;
    message += `  SOL Balance: ${currentSolBalance.toFixed(4)}\n`;
    if (heldTokensBreakdown) {
      message += `  Other Tokens:\n${heldTokensBreakdown}\n`;
    }
    message += `  *Total Value (USD):* $${currentTotalUsdPortfolioValue.toFixed(2)}\n`;
    message += `  *Total Value (IDR):* Rp${currentTotalIdrPortfolioValue.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}\n\n`;
    
    message += `--- Overall P/L (USD) ---\n`;
    message += `  Value: $${profitLossUsd.toFixed(2)}\n`;
    message += `  Percent: ${profitLossUsdPercent.toFixed(2)}%\n\n`;

    message += `--- Overall P/L (IDR) ---\n`;
    message += `  Value: Rp${profitLossIdr.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}\n`;
    
    message += `\n-----------------------------------\n`;
    return message;
  }
}
