import { Keypair } from '@solana/web3.js';
import { appConfig } from '../config/app_config';
import bs58 from 'bs58';

let traderKeypair: Keypair | null = null;

export function getTraderKeypair(): Keypair {
  if (traderKeypair) {
    return traderKeypair;
  }

  if (!appConfig.walletPrivateKey) {
    throw new Error('WALLET_PRIVATE_KEY is not set in the .env file. Cannot create Keypair.');
  }

  try {
    let secretKeyBytes: Uint8Array;
    const pkString = appConfig.walletPrivateKey.trim();

    // Attempt to parse as JSON array (common for Phantom/Solflare exports)
    if (pkString.startsWith('[') && pkString.endsWith(']')) {
      try {
        const parsedArray = JSON.parse(pkString);
        if (Array.isArray(parsedArray) && parsedArray.every(n => typeof n === 'number')) {
          secretKeyBytes = Uint8Array.from(parsedArray);
        } else {
          throw new Error('Private key string looks like an array but failed to parse as a byte array.');
        }
      } catch (e) {
        // If JSON.parse fails, it's not a JSON array string, try bs58 decoding next.
        console.warn('Private key is not a valid JSON array string, attempting bs58 decode.', e);
        secretKeyBytes = bs58.decode(pkString);
      }
    } else {
      // Assume it's a base58 encoded string
      secretKeyBytes = bs58.decode(pkString);
    }

    // At this point, secretKeyBytes should be the actual byte array.
    console.log(`DEBUG: secretKeyBytes type: ${Object.prototype.toString.call(secretKeyBytes)}, length: ${secretKeyBytes.length}`);
    // console.log(`DEBUG: secretKeyBytes content (first few bytes): ${secretKeyBytes.slice(0, 5)}`);


    // Keypair.fromSecretKey expects the 32-byte secret key.
    // Per user's suggestion, we will test passing 64 bytes directly to fromSecretKey
    // and using fromSeed for 32 bytes.
    if (secretKeyBytes.length === 64) {
      console.log('DEBUG: Detected 64-byte key. Per user suggestion, passing full 64 bytes to Keypair.fromSecretKey().');
      // This is expected to fail as fromSecretKey typically expects 32 bytes.
      traderKeypair = Keypair.fromSecretKey(secretKeyBytes); 
    } else if (secretKeyBytes.length === 32) {
      console.log('DEBUG: Detected 32-byte key. Per user suggestion, using Keypair.fromSeed().');
      traderKeypair = Keypair.fromSeed(secretKeyBytes);
    } else {
      throw new Error(`Decoded private key has an invalid length: ${secretKeyBytes.length} bytes. Expected 32 or 64 bytes.`);
    }
    
    // console.log(`DEBUG: finalSecretKeyForSolana type: ${Object.prototype.toString.call(finalSecretKeyForSolana)}, length: ${finalSecretKeyForSolana.length}`); // No longer have finalSecretKeyForSolana
    
    console.log(`Trader wallet loaded: ${traderKeypair.publicKey.toBase58()}`);
    return traderKeypair;
  } catch (error: any) {
    console.error('Failed to load trader keypair from private key:', error.message);
    throw new Error(`Could not initialize trader Keypair. Ensure WALLET_PRIVATE_KEY in .env is a valid secret key (either base58 encoded or a JSON byte array string). Error: ${error.message}`);
  }
}

// Example of how it might be if the .env stores a JSON string array of bytes for the secret key
/*
export function getTraderKeypairFromJsonString(): Keypair {
  if (!appConfig.walletPrivateKey) {
    throw new Error('WALLET_PRIVATE_KEY (JSON string format) is not set.');
  }
  try {
    const secretKeyUint8Array = Uint8Array.from(JSON.parse(appConfig.walletPrivateKey));
    traderKeypair = Keypair.fromSecretKey(secretKeyUint8Array);
    console.log(`Trader wallet loaded: ${traderKeypair.publicKey.toBase58()}`);
    return traderKeypair;
  } catch (error) {
    console.error('Failed to load trader keypair from JSON string private key:', error);
    throw new Error('Could not initialize trader Keypair from JSON string.');
  }
}
*/
