# Solana Sniper Bot

This is a TypeScript-based bot designed to snipe newly graduated tokens from Pump.fun on the Solana blockchain. It features automated analysis, trading via Jupiter, risk management (take profit/stop loss), Telegram notifications, and portfolio tracking with Redis persistence.

## Features

-   **Pump.fun Listener**: Monitors Pump.fun's NATS stream for `advancedCoinGraduated` events.
-   **Token Analysis**:
    -   On-chain checks: Mint authority, freeze authority, liquidity, holder count, top holder distribution.
    -   RugCheck.xyz API integration for additional risk assessment.
-   **Automated Trading**: Uses Jupiter API for swapping SOL for new tokens.
    -   Configurable slippage for buys and sells.
    -   Dynamic priority fee calculation to improve transaction confirmation.
-   **Risk Management**:
    -   Monitors open positions for take profit and stop loss targets.
    -   Configurable TP/SL percentages.
    -   Limit on maximum concurrent open trades.
-   **Telegram Notifications**:
    -   Alerts for new tokens (passed/failed analysis).
    *   Alerts for successful buys, including Pump.fun and Solscan links as buttons.
    *   Periodic portfolio balance updates (SOL, USD, IDR values, breakdown of holdings).
    *   Initial and final portfolio reports on bot start/stop.
    *   Support for multiple Telegram chat IDs.
-   **Portfolio Tracking & Persistence**:
    *   Tracks SOL balance and total portfolio value (including other held tokens) in SOL, USD, and IDR.
    *   Uses Redis to persist active trading positions and portfolio snapshots, allowing state to be recovered after restarts.
-   **Resilient RPC Handling**: Supports multiple RPC endpoints with failover and retry logic.
-   **Configuration**: Highly configurable via a `.env` file.

## Prerequisites

-   Node.js (v18 or higher recommended)
-   npm
-   A Solana wallet with SOL for trading and transaction fees.
-   A Telegram Bot Token and Chat ID(s) for notifications.
-   Access to a Redis server (local or remote).
-   (Optional but Recommended) API keys for RPC services like Helius for better reliability.

## Setup

1.  **Clone the Repository (if applicable)**
    ```bash
    # git clone <repository-url>
    # cd <repository-directory>
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Create `.env` File**:
    Copy the `.env.example` (if one exists) or create a new `.env` file in the root of the project and populate it with your configuration. See the "Configuration" section below for details on the required and optional variables.

    **Minimal `.env` example:**
    ```env
    # Solana Wallet
    WALLET_PRIVATE_KEY=YOUR_WALLET_PRIVATE_KEY_HERE_IN_BYTE_ARRAY_FORMAT

    # Pump.fun
    PUMPFUN_WEBSOCKET_URL=wss://prod-advanced.nats.realtime.pump.fun # Or your specific NATS endpoint

    # Telegram
    TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
    TELEGRAM_CHAT_IDS=YOUR_CHAT_ID_1,YOUR_CHAT_ID_2 # Comma-separated

    # RPC (replace with your preferred, comma-separated for backups)
    SOLANA_RPC_ENDPOINTS=https://api.mainnet-beta.solana.com 
    # Example with Helius: SOLANA_RPC_ENDPOINTS=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY

    # Redis (if not using localhost:6379 default)
    # REDIS_HOST=your_redis_host
    # REDIS_PORT=your_redis_port
    # REDIS_PASSWORD=your_redis_password
    # REDIS_DB=0 
    ```

4.  **Build (Optional, if you prefer running from dist)**
    ```bash
    npm run build
    ```

## Running the Bot

```bash
npm start
```
This will run the bot using `ts-node`. If you've built the project, you can run `node dist/main.js`.

## Configuration (`.env` variables)

### Required:
-   `WALLET_PRIVATE_KEY`: Your Solana wallet's private key (usually as a byte array string, e.g., `[1,2,3,...]`).
-   `PUMPFUN_WEBSOCKET_URL`: WebSocket URL for the Pump.fun NATS stream.
-   `TELEGRAM_BOT_TOKEN`: Your Telegram bot token.
-   `TELEGRAM_CHAT_IDS`: Comma-separated list of Telegram chat IDs to send notifications to.
-   `SOLANA_RPC_ENDPOINTS`: Comma-separated list of Solana RPC URLs. The first is primary, others are backups.

### Trading & Risk Management:
-   `SOL_AMOUNT_PER_TRADE`: Amount of SOL to spend per trade (e.g., `0.01`). Default: `0.01`.
-   `TAKE_PROFIT_PERCENTAGE`: Take profit target as a decimal (e.g., `1.00` for 100%). Default: `1.00`.
-   `STOP_LOSS_PERCENTAGE`: Stop loss target as a decimal (e.g., `0.20` for 20%). Default: `0.20`.
-   `MAX_OPEN_TRADES`: Maximum number of concurrent open trades. Default: `2`.
-   `BUY_SLIPPAGE_BPS`: Slippage tolerance for buy orders in basis points (e.g., `250` for 2.5%). Default: `250`.
-   `SELL_SLIPPAGE_BPS`: Slippage tolerance for sell orders in basis points. Default: `100`.
-   `DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS`: Default priority fee if dynamic fees are disabled or fail. Default: `100000`.
-   `ENABLE_DYNAMIC_PRIORITY_FEES`: `true` or `false` to enable/disable dynamic priority fees. Default: `true`.
-   `DYNAMIC_PRIORITY_FEE_PERCENTILE`: Percentile for dynamic fee calculation (e.g., `0.75` for 75th). Default: `0.75`.

### Analysis Criteria:
-   `MIN_LIQUIDITY_USD`: Minimum USD liquidity for a token to pass analysis. Default: `4000`.
-   `MIN_HOLDERS`: Minimum number of holders. Default: `10`.
-   `MAX_TOP_10_HOLDER_PERCENTAGE`: Maximum supply percentage held by top 10 holders (e.g., `0.80` for 80%). Default: `0.80`.

### External APIs:
-   `RUGCHECK_API_BASE_URL`: Base URL for RugCheck API. Default: `https://api.rugcheck.xyz/v1/tokens`.
-   `EXCHANGE_RATE_API_URL`: API URL for USD to other currency rates (used for IDR). Default: `https://api.exchangerate-api.com/v4/latest/USD`.

### Balance Statistics:
-   `BALANCE_CHECK_INTERVAL_MS`: How often to check and report portfolio balance, in milliseconds. Default: `3600000` (1 hour).
-   `ENABLE_TELEGRAM_BALANCE_UPDATES`: `true` or `false` to send balance updates to Telegram. Default: `true`.
-   `FALLBACK_SOL_TO_USD_RATE`: Fallback SOL/USD price if API fails. Default: `150`.
-   `FALLBACK_USD_TO_IDR_RATE`: Fallback USD/IDR rate if API fails. Default: `16000`.

### RPC Retries:
-   `RPC_RETRY_ATTEMPTS`: Number of retries per RPC endpoint. Default: `3`.
-   `RPC_RETRY_DELAY_MS`: Delay between retries on the same RPC, in milliseconds. Default: `1000`.

### Redis:
-   `REDIS_HOST`: Redis server host. Default: `127.0.0.1`.
-   `REDIS_PORT`: Redis server port. Default: `6379`.
-   `REDIS_PASSWORD`: Redis password (if any). Default: `undefined`.
-   `REDIS_DB`: Redis database number. Default: `0`.

## Disclaimer

This bot interacts with decentralized exchanges and involves financial risk. Use it at your own risk. Ensure you understand the code and the risks involved before deploying or using it with real funds. The authors are not responsible for any financial losses.
