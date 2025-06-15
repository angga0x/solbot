import dotenv from 'dotenv';

dotenv.config();

const primaryRpc = 'https://mainnet.helius-rpc.com/?api-key=767f42d9-06c2-46f8-8031-9869035d6ce4'; // Default primary
const rpcEndpointsEnv = process.env.SOLANA_RPC_ENDPOINTS;

let rpcEndpointsList: string[];
if (rpcEndpointsEnv && rpcEndpointsEnv.trim() !== '') {
  rpcEndpointsList = rpcEndpointsEnv.split(',').map(url => url.trim()).filter(url => url);
} else {
  rpcEndpointsList = [primaryRpc];
}
if (rpcEndpointsList.length === 0) { // Fallback if parsing results in empty
    rpcEndpointsList = [primaryRpc];
}


export const appConfig = {
  // RPC Configuration
  rpcEndpoints: rpcEndpointsList,
  rpcRetryAttempts: parseInt(process.env.RPC_RETRY_ATTEMPTS || '3', 10),
  rpcRetryDelayMs: parseInt(process.env.RPC_RETRY_DELAY_MS || '1000', 10),
  
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || '',
  pumpFunWebsocketUrl: process.env.PUMPFUN_WEBSOCKET_URL || '',
  jupiterApiEndpoint: process.env.JUPITER_API_ENDPOINT || 'https://quote-api.jup.ag/v6', // Jupiter V6 Quote API

  // Telegram Notifier
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatIds: (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(id => id.trim()).filter(id => id), // Parses comma-separated string into an array

  // External APIs
  rugCheckApiBaseUrl: process.env.RUGCHECK_API_BASE_URL || 'https://api.rugcheck.xyz/v1/tokens',
  exchangeRateApiUrl: process.env.EXCHANGE_RATE_API_URL || 'https://api.exchangerate-api.com/v4/latest/USD', // For USD to IDR

  // Redis Configuration
  redisHost: process.env.REDIS_HOST || '134.209.96.110',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  redisPassword: process.env.REDIS_PASSWORD || 'Lupa1233@@@', // undefined if not set
  redisDb: parseInt(process.env.REDIS_DB || '0', 10),
  
  // On-chain analysis criteria
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '4000'),
  minHolders: parseInt(process.env.MIN_HOLDERS || '10', 10),
  maxTop10HolderPercentage: parseFloat(process.env.MAX_TOP_10_HOLDER_PERCENTAGE || '0.80'), // 30%

  // Risk Management
  takeProfitPercentage: parseFloat(process.env.TAKE_PROFIT_PERCENTAGE || '1.00'), // 100%
  stopLossPercentage: parseFloat(process.env.STOP_LOSS_PERCENTAGE || '0.20'),     // 20%

  // Trading
  solAmountPerTrade: parseFloat(process.env.SOL_AMOUNT_PER_TRADE || '0.01'), // Default to 0.1 SOL
  defaultPriorityFeeMicroLamports: parseInt(process.env.DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS || '100000', 10), // Fallback if dynamic fees are disabled or fail
  enableDynamicPriorityFees: (process.env.ENABLE_DYNAMIC_PRIORITY_FEES || 'true').toLowerCase() === 'true',
  dynamicPriorityFeePercentile: parseFloat(process.env.DYNAMIC_PRIORITY_FEE_PERCENTILE || '0.75'), // Use 75th percentile of recent fees
  maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES || '2', 10), // Maximum concurrent open trades
  buySlippageBps: parseInt(process.env.BUY_SLIPPAGE_BPS || '250', 10), // Default 2.5% (250 bps) for buys - Increased
  sellSlippageBps: parseInt(process.env.SELL_SLIPPAGE_BPS || '100', 10), // Default 1% (100 bps) for sells (used by RiskManager)

  // Balance Statistics
  balanceCheckIntervalMs: parseInt(process.env.BALANCE_CHECK_INTERVAL_MS || (60 * 60 * 1000).toString(), 10), // Default to 1 hour
  enableTelegramBalanceUpdates: (process.env.ENABLE_TELEGRAM_BALANCE_UPDATES || 'true').toLowerCase() === 'true',
  fallbackSolToUsdRate: parseFloat(process.env.FALLBACK_SOL_TO_USD_RATE || '150'), // Fallback SOL/USD if API fails
  fallbackUsdToIdrRate: parseFloat(process.env.FALLBACK_USD_TO_IDR_RATE || '16000'), // Fallback if API fails
};

if (appConfig.rpcEndpoints.length === 0) {
    // This case should ideally be handled by the fallback logic above, but as a safeguard:
    console.error("CRITICAL: No RPC endpoints configured. Bot cannot operate. Please set SOLANA_RPC_ENDPOINTS in .env");
    // process.exit(1); // Or handle more gracefully
} else {
    console.info(`Using RPC Endpoints: ${appConfig.rpcEndpoints.join(', ')}`);
}

if (!appConfig.walletPrivateKey) {
  console.warn('WARNING: WALLET_PRIVATE_KEY is not set in the .env file. Trading will not be possible.');
}

if (!appConfig.pumpFunWebsocketUrl) {
  console.warn('WARNING: PUMPFUN_WEBSOCKET_URL is not set in the .env file. Pump.fun listener will not work.');
}

if (!appConfig.telegramBotToken || appConfig.telegramChatIds.length === 0) {
  console.warn('WARNING: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_IDS is not set (or empty) in the .env file. Telegram notifications will be disabled.');
}
