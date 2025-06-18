"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PumpFunListener = void 0;
const ws_1 = __importDefault(require("ws"));
const app_config_1 = require("../config/app_config");
const logger_1 = require("../utils/logger");
// NATS Subscription IDs (as requested by user)
const SID_COIN_IMAGE_UPDATED = '1';
const SID_ADVANCED_COIN_GRADUATED = '2';
const SID_ADVANCED_NEW_COIN_CREATED = '3';
var NatsState;
(function (NatsState) {
    NatsState[NatsState["DISCONNECTED"] = 0] = "DISCONNECTED";
    NatsState[NatsState["CONNECTING"] = 1] = "CONNECTING";
    NatsState[NatsState["CONNECTED_WAITING_FOR_INFO_OR_PING"] = 2] = "CONNECTED_WAITING_FOR_INFO_OR_PING";
    NatsState[NatsState["CONNECTED_AWAITING_PONG"] = 3] = "CONNECTED_AWAITING_PONG";
    NatsState[NatsState["SUBSCRIBING"] = 4] = "SUBSCRIBING";
    NatsState[NatsState["OPERATIONAL"] = 5] = "OPERATIONAL";
})(NatsState || (NatsState = {}));
class PumpFunListener {
    constructor() {
        this.ws = null;
        this.reconnectInterval = 5000; // 5 seconds
        this.newTokenCallbacks = [];
        this.natsState = NatsState.DISCONNECTED;
        this.serverPingInterval = 20000; // Expect PING from server roughly every 20s, send PONG
        this.clientKeepAliveIntervalMs = 15000; // Send PING from client every 15s
        if (!app_config_1.appConfig.pumpFunWebsocketUrl) {
            logger_1.logger.warn('PumpFunListener: PUMPFUN_WEBSOCKET_URL is not set. Listener will not start.');
            return;
        }
    }
    addTokenCallback(callback) {
        this.newTokenCallbacks.push(callback);
    }
    sendNatsCommand(command) {
        if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
            logger_1.logger.debug(`PumpFunListener: Sending NATS command: ${command.trim()}`);
            this.ws.send(`${command}\r\n`);
        }
        else {
            logger_1.logger.warn('PumpFunListener: WebSocket not open, cannot send NATS command.');
        }
    }
    connect() {
        if (!app_config_1.appConfig.pumpFunWebsocketUrl) {
            logger_1.logger.error('PumpFunListener: Cannot connect, PUMPFUN_WEBSOCKET_URL is not configured.');
            this.natsState = NatsState.DISCONNECTED;
            return;
        }
        // Allow connect() to be called if disconnected, or if a retry is being initiated (which would set state to DISCONNECTED first)
        // The main guard against multiple calls to start() is in the start() method itself.
        // if (this.natsState !== NatsState.DISCONNECTED) { 
        //     logger.warn(`PumpFunListener: connect() called while not in DISCONNECTED state: ${this.natsState}. This might be part of a retry.`);
        // }
        logger_1.logger.info(`PumpFunListener: Connecting to ${app_config_1.appConfig.pumpFunWebsocketUrl}...`);
        this.natsState = NatsState.CONNECTING;
        this.ws = new ws_1.default(app_config_1.appConfig.pumpFunWebsocketUrl);
        this.ws.on('open', () => {
            logger_1.logger.info('PumpFunListener: WebSocket connection established.');
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
        this.ws.on('message', (data) => {
            const messageStr = data.toString().trim();
            logger_1.logger.debug(`PumpFunListener: Received raw NATS message: ${messageStr}`);
            if (messageStr.startsWith('INFO')) {
                logger_1.logger.info(`PumpFunListener: Received NATS INFO: ${messageStr}`);
                // INFO message usually comes first, after CONNECT. We can proceed to subscribe.
                if (this.natsState === NatsState.CONNECTED_WAITING_FOR_INFO_OR_PING) {
                    this.subscribeToTopics();
                }
            }
            else if (messageStr === 'PING') {
                logger_1.logger.debug('PumpFunListener: Received PING from server.');
                this.sendNatsCommand('PONG');
                if (this.natsState === NatsState.CONNECTED_WAITING_FOR_INFO_OR_PING) {
                    // If PING is the first substantial message after CONNECT (before INFO)
                    this.natsState = NatsState.CONNECTED_AWAITING_PONG; // Or directly subscribe
                    this.subscribeToTopics(); // Assuming PING implies server is ready
                }
            }
            else if (messageStr.startsWith('MSG')) {
                this.handleNatsMsg(messageStr);
            }
            else if (messageStr === '+OK') {
                logger_1.logger.debug('PumpFunListener: Received +OK (e.g., after SUB or PONG).');
                if (this.natsState === NatsState.SUBSCRIBING) {
                    this.natsState = NatsState.OPERATIONAL;
                    logger_1.logger.info("PumpFunListener: Subscriptions confirmed. Operational.");
                }
            }
            else if (messageStr === 'PONG') {
                logger_1.logger.debug('PumpFunListener: Received PONG from server.');
                // No action needed, this is just the server acknowledging our client-side PING.
            }
            else if (messageStr.startsWith('-ERR')) {
                logger_1.logger.error(`PumpFunListener: Received NATS Error: ${messageStr}`);
            }
            else {
                logger_1.logger.warn(`PumpFunListener: Received unhandled NATS message: ${messageStr}`);
            }
        });
        this.ws.on('error', (error) => {
            logger_1.logger.error('PumpFunListener: WebSocket error:', error.message);
            this.natsState = NatsState.DISCONNECTED; // Will trigger reconnect via 'close'
        });
        this.ws.on('close', (code, reason) => {
            logger_1.logger.info(`PumpFunListener: WebSocket disconnected. Code: ${code}, Reason: ${reason.toString()}.`);
            this.natsState = NatsState.DISCONNECTED;
            this.stopClientKeepAlive();
            if (this.pingIntervalId)
                clearInterval(this.pingIntervalId);
            logger_1.logger.info(`Attempting to reconnect in ${this.reconnectInterval / 1000}s...`);
            setTimeout(() => this.connect(), this.reconnectInterval);
        });
    }
    subscribeToTopics() {
        logger_1.logger.info('PumpFunListener: Subscribing to NATS topics as per user specification...');
        this.natsState = NatsState.SUBSCRIBING;
        this.sendNatsCommand(`SUB coinImageUpdated.> ${SID_COIN_IMAGE_UPDATED}`);
        this.sendNatsCommand(`SUB advancedCoinGraduated ${SID_ADVANCED_COIN_GRADUATED}`);
        this.sendNatsCommand(`SUB advancedNewCoinCreated ${SID_ADVANCED_NEW_COIN_CREATED}`);
        logger_1.logger.info(`Subscribed to: coinImageUpdated.> (SID: ${SID_COIN_IMAGE_UPDATED}), advancedCoinGraduated (SID: ${SID_ADVANCED_COIN_GRADUATED}), advancedNewCoinCreated (SID: ${SID_ADVANCED_NEW_COIN_CREATED})`);
    }
    startClientKeepAlive() {
        this.stopClientKeepAlive(); // Clear existing interval if any
        this.clientKeepAliveIntervalId = setInterval(() => {
            if (this.ws && this.ws.readyState === ws_1.default.OPEN &&
                (this.natsState === NatsState.OPERATIONAL || this.natsState === NatsState.SUBSCRIBING || this.natsState === NatsState.CONNECTED_AWAITING_PONG)) {
                logger_1.logger.debug("PumpFunListener: Sending client PING for keep-alive.");
                this.sendNatsCommand('PING');
            }
        }, this.clientKeepAliveIntervalMs);
    }
    stopClientKeepAlive() {
        if (this.clientKeepAliveIntervalId) {
            clearInterval(this.clientKeepAliveIntervalId);
            this.clientKeepAliveIntervalId = undefined;
        }
    }
    handleNatsMsg(messageStr) {
        // Example NATS MSG format: MSG <subject> <sid> [<reply-to>] <#bytes>\r\n<payload>\r\n
        const parts = messageStr.split(/\s+/);
        if (parts.length < 4) {
            logger_1.logger.warn(`PumpFunListener: Malformed NATS MSG: ${messageStr}`);
            return;
        }
        const subject = parts[1];
        const sid = parts[2];
        // const replyTo = parts.length === 5 ? parts[3] : undefined; (if reply-to is present)
        // const numBytes = parseInt(parts[parts.length -1], 10); // Last part before payload is byte count
        const payloadIndex = messageStr.indexOf('\r\n');
        if (payloadIndex === -1) {
            logger_1.logger.warn(`PumpFunListener: NATS MSG missing payload separator: ${messageStr}`);
            return;
        }
        const payloadStr = messageStr.substring(payloadIndex + 2); // +2 for \r\n
        logger_1.logger.debug(`PumpFunListener: NATS MSG | Subject: ${subject} | SID: ${sid} | Payload: ${payloadStr}`);
        if (sid === SID_ADVANCED_COIN_GRADUATED && subject === 'advancedCoinGraduated') {
            try {
                let parsedPayload = JSON.parse(payloadStr);
                // If the NATS message payload is a JSON string that itself contains another JSON string,
                // the first parse will yield a string. We need to parse that string again.
                if (typeof parsedPayload === 'string') {
                    logger_1.logger.debug("PumpFunListener: Payload was a string, attempting second JSON.parse().");
                    parsedPayload = JSON.parse(parsedPayload);
                }
                const tokenData = parsedPayload; // Now tokenData should be the actual object.
                // Prioritize 'coinMint' based on user-provided sample payload for advancedCoinGraduated
                const tokenAddress = tokenData.coinMint || tokenData.mint || tokenData.token_address || tokenData.address;
                if (tokenAddress) {
                    logger_1.logger.info(`PumpFunListener: New 'advancedCoinGraduated' token: ${tokenAddress}`);
                    this.newTokenCallbacks.forEach(cb => cb(tokenAddress, tokenData));
                }
                else {
                    logger_1.logger.warn(`PumpFunListener: 'advancedCoinGraduated' message missing token address. Data:`, tokenData);
                }
            }
            catch (error) {
                logger_1.logger.error('PumpFunListener: Error parsing JSON payload for advancedCoinGraduated:', error, payloadStr);
            }
        }
        // Handle other SIDs/subjects if subscribed
    }
    start() {
        if (!app_config_1.appConfig.pumpFunWebsocketUrl) {
            logger_1.logger.warn('PumpFunListener: PUMPFUN_WEBSOCKET_URL is not set. Cannot start listener.');
            return;
        }
        if (this.natsState !== NatsState.DISCONNECTED) {
            logger_1.logger.warn(`PumpFunListener: Already started or in a connecting state (${this.natsState}).`);
            return;
        }
        this.connect();
    }
    stop() {
        logger_1.logger.info('PumpFunListener: Stopping WebSocket connection...');
        this.natsState = NatsState.DISCONNECTED; // Prevent automatic reconnection attempts by setting state
        this.stopClientKeepAlive();
        if (this.pingIntervalId)
            clearInterval(this.pingIntervalId);
        if (this.ws) {
            // Remove listeners to prevent immediate reconnect on explicit stop
            this.ws.removeAllListeners('close');
            this.ws.removeAllListeners('error');
            if (this.ws.readyState === ws_1.default.OPEN || this.ws.readyState === ws_1.default.CONNECTING) {
                this.ws.close();
            }
            this.ws = null;
        }
        logger_1.logger.info('PumpFunListener: Stopped.');
    }
}
exports.PumpFunListener = PumpFunListener;
