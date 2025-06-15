import WebSocket from 'ws';
import { appConfig } from '../config/app_config';
import { logger } from '../utils/logger';

// Define a callback type for when a new token is detected
// The `tokenData` will be the JSON payload from the NATS message.
export type NewTokenCallback = (tokenAddress: string, tokenData: any) => void;

// NATS Subscription IDs (as requested by user)
const SID_COIN_IMAGE_UPDATED = '1';
const SID_ADVANCED_COIN_GRADUATED = '2';
const SID_ADVANCED_NEW_COIN_CREATED = '3';

enum NatsState {
  DISCONNECTED,
  CONNECTING,
  CONNECTED_WAITING_FOR_INFO_OR_PING,
  CONNECTED_AWAITING_PONG,
  SUBSCRIBING,
  OPERATIONAL,
}

export class PumpFunListener {
  private ws: WebSocket | null = null;
  private reconnectInterval: number = 5000; // 5 seconds
  private newTokenCallbacks: NewTokenCallback[] = [];
  private natsState: NatsState = NatsState.DISCONNECTED;
  private pingIntervalId?: NodeJS.Timeout;
  private serverPingInterval: number = 20000; // Expect PING from server roughly every 20s, send PONG
  private clientKeepAliveIntervalId?: NodeJS.Timeout; // To send PING from client if server is quiet
  private clientKeepAliveIntervalMs: number = 15000; // Send PING from client every 15s

  constructor() {
    if (!appConfig.pumpFunWebsocketUrl) {
      logger.warn('PumpFunListener: PUMPFUN_WEBSOCKET_URL is not set. Listener will not start.');
      return;
    }
  }

  public addTokenCallback(callback: NewTokenCallback): void {
    this.newTokenCallbacks.push(callback);
  }

  private sendNatsCommand(command: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.debug(`PumpFunListener: Sending NATS command: ${command.trim()}`);
      this.ws.send(`${command}\r\n`);
    } else {
      logger.warn('PumpFunListener: WebSocket not open, cannot send NATS command.');
    }
  }

  private connect(): void {
    if (!appConfig.pumpFunWebsocketUrl) {
      logger.error('PumpFunListener: Cannot connect, PUMPFUN_WEBSOCKET_URL is not configured.');
      this.natsState = NatsState.DISCONNECTED;
      return;
    }
    // Allow connect() to be called if disconnected, or if a retry is being initiated (which would set state to DISCONNECTED first)
    // The main guard against multiple calls to start() is in the start() method itself.
    // if (this.natsState !== NatsState.DISCONNECTED) { 
    //     logger.warn(`PumpFunListener: connect() called while not in DISCONNECTED state: ${this.natsState}. This might be part of a retry.`);
    // }

    logger.info(`PumpFunListener: Connecting to ${appConfig.pumpFunWebsocketUrl}...`);
    this.natsState = NatsState.CONNECTING;
    this.ws = new WebSocket(appConfig.pumpFunWebsocketUrl);

    this.ws.on('open', () => {
      logger.info('PumpFunListener: WebSocket connection established.');
      this.natsState = NatsState.CONNECTED_WAITING_FOR_INFO_OR_PING;
      const connectMsg = JSON.stringify({
        no_responders: true,
        protocol: 1,
        verbose: false,
        pedantic: false,
        user: "subscriber", // As per user's info
        pass: "OktDhmZ2D3CtYUiM", // As per user's info
        lang: "nats.ws",
        version: "1.29.2", // As per user's info
        headers: true
      });
      this.sendNatsCommand(`CONNECT ${connectMsg}`);
      // Start client-side keep-alive PINGs
      this.startClientKeepAlive();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      const messageStr = data.toString().trim();
      logger.debug(`PumpFunListener: Received raw NATS message: ${messageStr}`);

      if (messageStr.startsWith('INFO')) {
        logger.info(`PumpFunListener: Received NATS INFO: ${messageStr}`);
        // INFO message usually comes first, after CONNECT. We can proceed to subscribe.
        if (this.natsState === NatsState.CONNECTED_WAITING_FOR_INFO_OR_PING) {
            this.subscribeToTopics();
        }
      } else if (messageStr === 'PING') {
        logger.debug('PumpFunListener: Received PING from server.');
        this.sendNatsCommand('PONG');
        if (this.natsState === NatsState.CONNECTED_WAITING_FOR_INFO_OR_PING) {
            // If PING is the first substantial message after CONNECT (before INFO)
            this.natsState = NatsState.CONNECTED_AWAITING_PONG; // Or directly subscribe
            this.subscribeToTopics(); // Assuming PING implies server is ready
        }
      } else if (messageStr.startsWith('MSG')) {
        this.handleNatsMsg(messageStr);
      } else if (messageStr === '+OK') {
        logger.debug('PumpFunListener: Received +OK (e.g., after SUB or PONG).');
        if (this.natsState === NatsState.SUBSCRIBING) {
            this.natsState = NatsState.OPERATIONAL;
            logger.info("PumpFunListener: Subscriptions confirmed. Operational.");
        }
      } else if (messageStr === 'PONG') {
        logger.debug('PumpFunListener: Received PONG from server.');
        // No action needed, this is just the server acknowledging our client-side PING.
      } else if (messageStr.startsWith('-ERR')) {
        logger.error(`PumpFunListener: Received NATS Error: ${messageStr}`);
      } else {
        logger.warn(`PumpFunListener: Received unhandled NATS message: ${messageStr}`);
      }
    });

    this.ws.on('error', (error: Error) => {
      logger.error('PumpFunListener: WebSocket error:', error.message);
      this.natsState = NatsState.DISCONNECTED; // Will trigger reconnect via 'close'
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      logger.info(`PumpFunListener: WebSocket disconnected. Code: ${code}, Reason: ${reason.toString()}.`);
      this.natsState = NatsState.DISCONNECTED;
      this.stopClientKeepAlive();
      if (this.pingIntervalId) clearInterval(this.pingIntervalId);
      
      logger.info(`Attempting to reconnect in ${this.reconnectInterval / 1000}s...`);
      setTimeout(() => this.connect(), this.reconnectInterval);
    });
  }

  private subscribeToTopics(): void {
    logger.info('PumpFunListener: Subscribing to NATS topics as per user specification...');
    this.natsState = NatsState.SUBSCRIBING;
    
    this.sendNatsCommand(`SUB coinImageUpdated.> ${SID_COIN_IMAGE_UPDATED}`);
    this.sendNatsCommand(`SUB advancedCoinGraduated ${SID_ADVANCED_COIN_GRADUATED}`);
    this.sendNatsCommand(`SUB advancedNewCoinCreated ${SID_ADVANCED_NEW_COIN_CREATED}`);
    
    logger.info(`Subscribed to: coinImageUpdated.> (SID: ${SID_COIN_IMAGE_UPDATED}), advancedCoinGraduated (SID: ${SID_ADVANCED_COIN_GRADUATED}), advancedNewCoinCreated (SID: ${SID_ADVANCED_NEW_COIN_CREATED})`);
  }
  
  private startClientKeepAlive(): void {
    this.stopClientKeepAlive(); // Clear existing interval if any
    this.clientKeepAliveIntervalId = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && 
          (this.natsState === NatsState.OPERATIONAL || this.natsState === NatsState.SUBSCRIBING || this.natsState === NatsState.CONNECTED_AWAITING_PONG )) {
        logger.debug("PumpFunListener: Sending client PING for keep-alive.");
        this.sendNatsCommand('PING');
      }
    }, this.clientKeepAliveIntervalMs);
  }

  private stopClientKeepAlive(): void {
    if (this.clientKeepAliveIntervalId) {
      clearInterval(this.clientKeepAliveIntervalId);
      this.clientKeepAliveIntervalId = undefined;
    }
  }

  private handleNatsMsg(messageStr: string): void {
    // Example NATS MSG format: MSG <subject> <sid> [<reply-to>] <#bytes>\r\n<payload>\r\n
    const parts = messageStr.split(/\s+/);
    if (parts.length < 4) {
      logger.warn(`PumpFunListener: Malformed NATS MSG: ${messageStr}`);
      return;
    }
    const subject = parts[1];
    const sid = parts[2];
    // const replyTo = parts.length === 5 ? parts[3] : undefined; (if reply-to is present)
    // const numBytes = parseInt(parts[parts.length -1], 10); // Last part before payload is byte count

    const payloadIndex = messageStr.indexOf('\r\n');
    if (payloadIndex === -1) {
      logger.warn(`PumpFunListener: NATS MSG missing payload separator: ${messageStr}`);
      return;
    }
    const payloadStr = messageStr.substring(payloadIndex + 2); // +2 for \r\n

    logger.debug(`PumpFunListener: NATS MSG | Subject: ${subject} | SID: ${sid} | Payload: ${payloadStr}`);

    if (sid === SID_ADVANCED_COIN_GRADUATED && subject === 'advancedCoinGraduated') {
      try {
        let parsedPayload = JSON.parse(payloadStr);
        // If the NATS message payload is a JSON string that itself contains another JSON string,
        // the first parse will yield a string. We need to parse that string again.
        if (typeof parsedPayload === 'string') {
          logger.debug("PumpFunListener: Payload was a string, attempting second JSON.parse().");
          parsedPayload = JSON.parse(parsedPayload);
        }
        const tokenData = parsedPayload; // Now tokenData should be the actual object.

        // Prioritize 'coinMint' based on user-provided sample payload for advancedCoinGraduated
        const tokenAddress = tokenData.coinMint || tokenData.mint || tokenData.token_address || tokenData.address; 
        
        if (tokenAddress) {
          logger.info(`PumpFunListener: New 'advancedCoinGraduated' token: ${tokenAddress}`);
          this.newTokenCallbacks.forEach(cb => cb(tokenAddress, tokenData));
        } else {
          logger.warn(`PumpFunListener: 'advancedCoinGraduated' message missing token address. Data:`, tokenData);
        }
      } catch (error) {
        logger.error('PumpFunListener: Error parsing JSON payload for advancedCoinGraduated:', error, payloadStr);
      }
    }
    // Handle other SIDs/subjects if subscribed
  }

  public start(): void {
    if (!appConfig.pumpFunWebsocketUrl) {
      logger.warn('PumpFunListener: PUMPFUN_WEBSOCKET_URL is not set. Cannot start listener.');
      return;
    }
    if (this.natsState !== NatsState.DISCONNECTED) {
        logger.warn(`PumpFunListener: Already started or in a connecting state (${this.natsState}).`);
        return;
    }
    this.connect();
  }

  public stop(): void {
    logger.info('PumpFunListener: Stopping WebSocket connection...');
    this.natsState = NatsState.DISCONNECTED; // Prevent automatic reconnection attempts by setting state
    this.stopClientKeepAlive();
    if (this.pingIntervalId) clearInterval(this.pingIntervalId);

    if (this.ws) {
      // Remove listeners to prevent immediate reconnect on explicit stop
      this.ws.removeAllListeners('close'); 
      this.ws.removeAllListeners('error');
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    logger.info('PumpFunListener: Stopped.');
  }
}
