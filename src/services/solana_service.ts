import { Connection, PublicKey, AccountInfo, ParsedAccountData, LAMPORTS_PER_SOL, Commitment } from '@solana/web3.js';
import { appConfig } from '../config/app_config';
import { logger } from '../utils/logger';

let currentConnection: Connection | null = null;
let currentRpcIndex = 0;
const rpcCommitment: Commitment = 'confirmed'; // Default commitment level

function createConnection(rpcUrl: string): Connection {
  logger.info(`SolanaService: Attempting to connect to Solana RPC: ${rpcUrl}`);
  return new Connection(rpcUrl, {
    commitment: rpcCommitment,
    disableRetryOnRateLimit: true, // We will handle retries and failover manually
  });
}

export function getSolanaConnection(): Connection {
  if (!currentConnection) {
    if (appConfig.rpcEndpoints.length === 0) {
      logger.error("SolanaService: No RPC endpoints configured. Cannot establish Solana connection.");
      throw new Error("No RPC endpoints configured.");
    }
    currentConnection = createConnection(appConfig.rpcEndpoints[currentRpcIndex]);
    logger.info(`SolanaService: Initial connection established with ${appConfig.rpcEndpoints[currentRpcIndex]}`);
  }
  return currentConnection;
}

export function switchToNextRpc(): Connection {
  currentRpcIndex = (currentRpcIndex + 1) % appConfig.rpcEndpoints.length;
  const nextRpcUrl = appConfig.rpcEndpoints[currentRpcIndex];
  logger.warn(`SolanaService: Switching to next RPC endpoint: ${nextRpcUrl} (index: ${currentRpcIndex})`);
  currentConnection = createConnection(nextRpcUrl);
  return currentConnection;
}

// More specific error checker for RPC issues that warrant a switch/retry
const isRpcFailoverError = (error: any): boolean => {
  const errorMessage = error.message?.toLowerCase() || "";
  // Common network or RPC availability errors
  if (errorMessage.includes('failed to fetch') || 
      errorMessage.includes('network request failed') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('econnrefused') ||
      errorMessage.includes('econnreset') ||
      errorMessage.includes('enotfound') ||
      errorMessage.includes('esockettimedout') ||
      errorMessage.includes('service unavailable') || // For 503 errors
      (error.code && (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ESOCKETTIMEDOUT'))
     ) {
    return true;
  }
  // Solana specific RPC errors (less common for simple getAccountInfo, more for sendTransaction)
  // Example: error.code === -32000 to -32099 (JSON RPC server errors)
  // For now, focusing on network-level issues for get* calls.
  return false;
};

async function executeRpcCall<T>(
  action: (conn: Connection) => Promise<T>,
  isFailoverErrorCheck: (error: any) => boolean = isRpcFailoverError
): Promise<T> {
  let totalAttemptsAcrossRpcs = 0;
  // const maxTotalAttempts = appConfig.rpcRetryAttempts * appConfig.rpcEndpoints.length; // Unused variable

  for (let cycle = 0; cycle < appConfig.rpcEndpoints.length; cycle++) {
    let conn = getSolanaConnection(); // Gets current or initializes first
    logger.debug(`SolanaService: Attempting RPC call with ${conn.rpcEndpoint} (Cycle: ${cycle + 1})`);

    for (let attempt = 0; attempt < appConfig.rpcRetryAttempts; attempt++) {
      totalAttemptsAcrossRpcs++;
      try {
        return await action(conn);
      } catch (error: any) {
        logger.warn(`SolanaService: RPC call attempt ${attempt + 1}/${appConfig.rpcRetryAttempts} on ${conn.rpcEndpoint} failed. Error: ${error.message}`);
        
        if (attempt < appConfig.rpcRetryAttempts - 1) { // If more retries on current RPC
          if (isFailoverErrorCheck(error)) { // If it's an error that might resolve by waiting
             await new Promise(resolve => setTimeout(resolve, appConfig.rpcRetryDelayMs));
          } else {
            throw error; // Non-retriable error for this specific RPC, rethrow
          }
        } else if (isFailoverErrorCheck(error) && cycle < appConfig.rpcEndpoints.length - 1) {
          // Last attempt on this RPC failed with a potentially recoverable RPC error, and more RPCs are available
          logger.warn(`SolanaService: All attempts on ${conn.rpcEndpoint} failed. Switching RPC.`);
          break; // Break inner loop to switch RPC in outer loop
        } else {
          // Last attempt on this RPC, or non-failover error on last attempt
          logger.error(`SolanaService: All attempts on ${conn.rpcEndpoint} failed or non-retriable error. Last error: ${error.message}`);
          throw error; // Re-throw the last error
        }
      }
    }
    // If we broke from inner loop to switch RPC
    if (cycle < appConfig.rpcEndpoints.length - 1) {
      conn = switchToNextRpc();
    } else {
      // This means all attempts on all RPCs in the cycle are exhausted
      logger.error(`SolanaService: All RPC endpoints tried and failed after ${totalAttemptsAcrossRpcs} total attempts.`);
      // The last error would have been thrown by the inner loop's else condition.
      // This part should ideally not be reached if an error is always thrown.
    }
  }
  throw new Error('SolanaService: Exhausted all RPC failover attempts.'); // Fallback, should be caught by prior throws
}


export async function getAccountInfo(publicKey: PublicKey): Promise<AccountInfo<Buffer | ParsedAccountData> | null> {
  try {
    return await executeRpcCall(
        async (conn) => {
            const accountInfo = await conn.getAccountInfo(publicKey);
            return accountInfo; // Returns null if account not found, this is not an RPC error.
        }
        // Default isRpcFailoverError is fine here
    );
  } catch (error) {
    logger.error(`SolanaService: Failed to get account info for ${publicKey.toBase58()} after all retries:`, error);
    return null;
  }
}

export async function getParsedAccountInfo(publicKey: PublicKey): Promise<AccountInfo<ParsedAccountData> | null> {
  try {
    const rpcResult = await executeRpcCall(
        async (conn) => conn.getParsedAccountInfo(publicKey)
        // Default isRpcFailoverError is fine here
    );
    // getParsedAccountInfo returns RpcResponseAndContext<AccountInfo<ParsedAccountData> | null>
    // So rpcResult.value is AccountInfo<ParsedAccountData> | null
    if (rpcResult.value === null) return null; 
    const accountData = rpcResult.value;
    
    // Basic check for parsed data structure (though type system should mostly handle this)
    if (!accountData.data || typeof accountData.data === 'string' || !('parsed' in accountData.data)) {
        logger.warn(`SolanaService: Account data for ${publicKey.toBase58()} does not appear to be standard ParsedAccountData.`);
    }
    return accountData as AccountInfo<ParsedAccountData>; // Cast is okay due to checks and typical API behavior
  } catch (error) {
    logger.error(`SolanaService: Failed to get parsed account info for ${publicKey.toBase58()} after all retries:`, error);
    return null;
  }
}

export async function getTokenSupply(mintPublicKey: PublicKey): Promise<number | null> {
  try {
    const supplyInfo = await executeRpcCall(
        async (conn) => conn.getTokenSupply(mintPublicKey)
    );
    return supplyInfo.value.uiAmount;
  } catch (error) {
    logger.error(`SolanaService: Failed to get token supply for ${mintPublicKey.toBase58()} after all retries:`, error);
    return null;
  }
}

export async function getTokenAccountBalance(tokenAccountPublicKey: PublicKey): Promise<number | null> {
  try {
    const balanceInfo = await executeRpcCall(
        async (conn) => conn.getTokenAccountBalance(tokenAccountPublicKey)
    );
    return balanceInfo.value.uiAmount;
  } catch (error) {
    logger.error(`SolanaService: Failed to get token account balance for ${tokenAccountPublicKey.toBase58()} after all retries:`, error);
    return null;
  }
}

export async function getSolBalance(walletPublicKey: PublicKey): Promise<number | null> {
  try {
    const lamports = await executeRpcCall(
        async (conn) => conn.getBalance(walletPublicKey)
    );
    return lamports / LAMPORTS_PER_SOL;
  } catch (error) {
    logger.error(`SolanaService: Failed to get SOL balance for ${walletPublicKey.toBase58()} after all retries:`, error);
    return null;
  }
}

export interface TokenAccount {
  pubkey: PublicKey;
  mint: PublicKey;
  uiAmount: number | null;
  decimals: number;
}

export async function getTokenAccountsByOwner(ownerPublicKey: PublicKey): Promise<TokenAccount[]> {
  try {
    const result = await executeRpcCall(async (conn) => 
      conn.getParsedTokenAccountsByOwner(ownerPublicKey, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') })
    );
    
    const accounts: TokenAccount[] = [];
    if (result && result.value) {
      for (const acc of result.value) {
        if (acc.account.data?.parsed?.info?.tokenAmount?.uiAmount > 0) {
          accounts.push({
            pubkey: acc.pubkey,
            mint: new PublicKey(acc.account.data.parsed.info.mint),
            uiAmount: acc.account.data.parsed.info.tokenAmount.uiAmount,
            decimals: acc.account.data.parsed.info.tokenAmount.decimals,
          });
        }
      }
    }
    logger.debug(`SolanaService: Found ${accounts.length} token accounts with balance for owner ${ownerPublicKey.toBase58()}`);
    return accounts;
  } catch (error) {
    logger.error(`SolanaService: Failed to get token accounts for owner ${ownerPublicKey.toBase58()} after all retries:`, error);
    return [];
  }
}
