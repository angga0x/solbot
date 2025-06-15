import axios from 'axios';
import { appConfig } from '../config/app_config';
import { logger } from '../utils/logger';

/**
 * Fetches the current SOL to USD price from Jupiter API.
 * @returns {Promise<number>} The SOL price in USD.
 */
export async function getSolUsdPrice(): Promise<number> {
  try {
    // Using the correct v2 endpoint: api.jup.ag/price/v2
    // We are fetching SOL price against USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
    // The API returns prices for specified IDs without needing a vsToken in the query if we want direct USD price.
    // However, to get SOL price in USD, we typically query SOL against a stablecoin like USDC.
    // The example response shows prices relative to USD by default if no vsToken is specified for the *output*.
    // Let's assume the API gives USD price directly for SOL if vsToken is omitted or if it's implicitly USD.
    // The example URL `https://api.jup.ag/price/v2?ids=JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN,So11111111111111111111111111111111111111112`
    // implies it gives USD values directly.
    const solMint = 'So11111111111111111111111111111111111111112';
    const jupiterPriceApiUrl = `https://api.jup.ag/price/v2?ids=${solMint}`;
    logger.debug(`PriceService: Fetching SOL/USD price from ${jupiterPriceApiUrl}`);
    const response = await axios.get(jupiterPriceApiUrl);

    // New response structure: { data: { [mint_id]: { id, type, price: string } }, timeTaken }
    if (response.data && response.data.data && response.data.data[solMint] && response.data.data[solMint].price) {
      const priceString = response.data.data[solMint].price;
      const price = parseFloat(priceString);
      if (!isNaN(price)) {
        logger.debug(`PriceService: Fetched SOL/USD price (api.jup.ag/price/v2): ${price}`);
        return price;
      } else {
        logger.warn(`PriceService: Failed to parse SOL/USD price string from API: '${priceString}'. Using fallback: ${appConfig.fallbackSolToUsdRate}`);
      }
    } else {
      logger.warn(`PriceService: Failed to fetch SOL/USD price from api.jup.ag/price/v2, structure unexpected or SOL data missing. Using fallback: ${appConfig.fallbackSolToUsdRate}`);
    }
    return appConfig.fallbackSolToUsdRate;
  } catch (error) {
    logger.error('PriceService: Error fetching SOL/USD price:', error);
    logger.warn(`PriceService: Using fallback SOL/USD rate: ${appConfig.fallbackSolToUsdRate}`);
    return appConfig.fallbackSolToUsdRate;
  }
}

/**
 * Fetches the current USD to IDR exchange rate.
 * @returns {Promise<number>} The USD to IDR exchange rate.
 */
export async function getUsdToIdrRate(): Promise<number> {
  try {
    const response = await axios.get(appConfig.exchangeRateApiUrl);
    if (response.data && response.data.rates && response.data.rates.IDR) {
      logger.debug(`PriceService: Fetched USD/IDR rate: ${response.data.rates.IDR}`);
      return response.data.rates.IDR;
    }
    logger.warn(`PriceService: Failed to fetch USD/IDR rate from API (${appConfig.exchangeRateApiUrl}), structure unexpected. Using fallback rate: ${appConfig.fallbackUsdToIdrRate}`);
    return appConfig.fallbackUsdToIdrRate;
  } catch (error) {
    logger.error(`PriceService: Error fetching USD/IDR rate from ${appConfig.exchangeRateApiUrl}:`, error);
    logger.warn(`PriceService: Using fallback USD/IDR rate: ${appConfig.fallbackUsdToIdrRate}`);
    return appConfig.fallbackUsdToIdrRate;
  }
}

/**
 * Fetches the current USD prices for multiple token mints from Jupiter API.
 * @param {string[]} mintAddresses - An array of token mint addresses.
 * @returns {Promise<Map<string, number>>} A map where keys are mint addresses and values are their USD prices.
 */
export async function getMultipleTokenPricesUsd(mintAddresses: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (!mintAddresses || mintAddresses.length === 0) {
    return prices;
  }

  const ids = mintAddresses.join(',');
  const jupiterPriceApiUrl = `https://api.jup.ag/price/v2?ids=${ids}`;
  logger.debug(`PriceService: Fetching USD prices for ${mintAddresses.length} tokens from ${jupiterPriceApiUrl}`);

  try {
    const response = await axios.get(jupiterPriceApiUrl);
    if (response.data && response.data.data) {
      for (const mint of mintAddresses) {
        if (response.data.data[mint] && response.data.data[mint].price) {
          const priceString = response.data.data[mint].price;
          const price = parseFloat(priceString);
          if (!isNaN(price)) {
            prices.set(mint, price);
            logger.debug(`PriceService: Fetched price for ${mint}: $${price}`);
          } else {
            logger.warn(`PriceService: Failed to parse price string for mint ${mint}: '${priceString}'.`);
            prices.set(mint, 0); // Default to 0 if parsing fails for a specific token
          }
        } else {
          logger.warn(`PriceService: Price data not found for mint ${mint} in API response.`);
          prices.set(mint, 0); // Default to 0 if not found
        }
      }
    } else {
      logger.warn(`PriceService: Failed to fetch token prices from api.jup.ag/price/v2, structure unexpected. All tokens will have 0 price.`);
      mintAddresses.forEach(mint => prices.set(mint, 0));
    }
  } catch (error) {
    logger.error('PriceService: Error fetching multiple token prices:', error);
    mintAddresses.forEach(mint => prices.set(mint, 0)); // Default all to 0 on error
  }
  return prices;
}
