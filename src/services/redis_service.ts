import Redis, { RedisOptions } from 'ioredis'; // Import RedisOptions
import { appConfig } from '../config/app_config';
import { logger } from '../utils/logger';
import { MonitoredPosition } from '../trading/risk_manager'; 

// Define a more specific type for what's stored in Redis, excluding non-serializable parts
export interface StorableMonitoredPosition {
  tokenMintAddress: string;
  entryPriceSol: number;
  amountTokenLamports: number;
  initialSolInvested: number;
  tokenDecimals: number;
}

export interface PortfolioSnapshot {
  timestamp: string; 
  initialSolBalance: number; 
  currentSolBalance: number;
  initialTotalUsdValue: number;
  currentTotalUsdPortfolioValue: number;
  initialTotalIdrValue: number;
  currentTotalIdrPortfolioValue: number;
  heldTokensBreakdown: string; 
}

const ACTIVE_POSITION_KEY_PREFIX = 'solabot:active_position:';
const LATEST_PORTFOLIO_SNAPSHOT_KEY = 'solabot:portfolio_snapshot:latest';
const PORTFOLIO_HISTORY_LIST_KEY = 'solabot:portfolio_history'; 
const MAX_PORTFOLIO_HISTORY = 100; 

let redisClient: Redis | null = null;

export function getRedisClient(): Redis | null {
  if (!redisClient) {
    if (!appConfig.redisHost || !appConfig.redisPort) {
      logger.warn('RedisService: Host or Port not configured. Redis disabled.');
      return null;
    }
    try {
      const options: RedisOptions = { // Corrected type to RedisOptions
        host: appConfig.redisHost,
        port: appConfig.redisPort,
        db: appConfig.redisDb,
        ...(appConfig.redisPassword && { password: appConfig.redisPassword }),
        retryStrategy: (times: number) => { // Added type for times
          const delay = Math.min(times * 50, 2000); 
          logger.warn(`RedisService: Retrying connection (attempt ${times}), delay ${delay}ms`);
          return delay;
        },
        maxRetriesPerRequest: 3, 
      };
      redisClient = new Redis(options);

      redisClient.on('connect', () => logger.info('RedisService: Connected to Redis server.'));
      redisClient.on('error', (err) => logger.error('RedisService: Redis connection error:', err));
      redisClient.on('reconnecting', () => logger.warn('RedisService: Reconnecting to Redis...'));
      
    } catch (error) {
        logger.error('RedisService: Failed to create Redis client:', error);
        return null;
    }
  }
  return redisClient;
}

export async function saveActivePosition(position: MonitoredPosition): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  const storablePosition: StorableMonitoredPosition = {
    tokenMintAddress: position.tokenMintAddress,
    entryPriceSol: position.entryPriceSol,
    amountTokenLamports: position.amountTokenLamports,
    initialSolInvested: position.initialSolInvested,
    tokenDecimals: position.tokenDecimals,
  };
  const key = `${ACTIVE_POSITION_KEY_PREFIX}${position.tokenMintAddress}`;
  try {
    await client.set(key, JSON.stringify(storablePosition));
    logger.debug(`RedisService: Saved active position for ${position.tokenMintAddress} to Redis.`);
  } catch (error) {
    logger.error(`RedisService: Error saving active position ${position.tokenMintAddress} to Redis:`, error);
  }
}

export async function loadActivePositions(): Promise<StorableMonitoredPosition[]> {
  const client = getRedisClient();
  if (!client) return [];

  const positions: StorableMonitoredPosition[] = [];
  try {
    const keys = await client.keys(`${ACTIVE_POSITION_KEY_PREFIX}*`);
    if (keys.length > 0) {
      const values = await client.mget(...keys); // Pass keys as separate arguments
      values.forEach(val => {
        if (val) {
          try {
            positions.push(JSON.parse(val) as StorableMonitoredPosition);
          } catch (parseError) {
            logger.error('RedisService: Error parsing position data from Redis:', parseError, val);
          }
        }
      });
    }
    logger.info(`RedisService: Loaded ${positions.length} active positions from Redis.`);
  } catch (error) {
    logger.error('RedisService: Error loading active positions from Redis:', error);
  }
  return positions;
}

export async function removeActivePosition(tokenMintAddress: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  const key = `${ACTIVE_POSITION_KEY_PREFIX}${tokenMintAddress}`;
  try {
    await client.del(key);
    logger.debug(`RedisService: Removed active position for ${tokenMintAddress} from Redis.`);
  } catch (error) {
    logger.error(`RedisService: Error removing active position ${tokenMintAddress} from Redis:`, error);
  }
}

export async function savePortfolioSnapshot(snapshot: PortfolioSnapshot): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    const snapshotJson = JSON.stringify(snapshot);
    await client.set(LATEST_PORTFOLIO_SNAPSHOT_KEY, snapshotJson);
    await client.lpush(PORTFOLIO_HISTORY_LIST_KEY, snapshotJson);
    await client.ltrim(PORTFOLIO_HISTORY_LIST_KEY, 0, MAX_PORTFOLIO_HISTORY - 1);
    logger.debug('RedisService: Saved portfolio snapshot to Redis.');
  } catch (error) {
    logger.error('RedisService: Error saving portfolio snapshot to Redis:', error);
  }
}

export async function loadLatestPortfolioSnapshot(): Promise<PortfolioSnapshot | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const snapshotJson = await client.get(LATEST_PORTFOLIO_SNAPSHOT_KEY);
    if (snapshotJson) {
      logger.debug('RedisService: Loaded latest portfolio snapshot from Redis.');
      return JSON.parse(snapshotJson) as PortfolioSnapshot;
    }
  } catch (error) {
    logger.error('RedisService: Error loading latest portfolio snapshot from Redis:', error);
  }
  return null;
}

export async function getPortfolioHistory(limit: number = MAX_PORTFOLIO_HISTORY): Promise<PortfolioSnapshot[]> {
    const client = getRedisClient();
    if (!client) return [];
    try {
        const historyJson = await client.lrange(PORTFOLIO_HISTORY_LIST_KEY, 0, limit - 1);
        return historyJson.map(json => JSON.parse(json) as PortfolioSnapshot);
    } catch (error) {
        logger.error('RedisService: Error fetching portfolio history from Redis:', error);
        return [];
    }
}
