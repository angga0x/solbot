import { PublicKey, ParsedAccountData, AccountInfo, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, MintLayout, AccountLayout, NATIVE_MINT } from '@solana/spl-token';
import { Liquidity, LIQUIDITY_STATE_LAYOUT_V4, MAINNET_PROGRAM_ID } from '@raydium-io/raydium-sdk'; // Import MAINNET_PROGRAM_ID
import { appConfig } from '../config/app_config';
import { logger } from '../utils/logger'; 
import * as solanaService from '../services/solana_service';
import { getSolUsdPrice } from '../services/price_service'; // Import from price_service
import axios from 'axios'; 

interface TokenAnalysisResult {
  passed: boolean;
  reasons: string[];
  details: {
    liquidityUsd?: number;
    holderCount?: number;
    top10HoldersPercentage?: number;
    mintAuthorityRenounced?: boolean; // On-chain check
    freezeAuthorityRenounced?: boolean; // On-chain check
    // RugCheck specific details
    rugCheckScore?: number;
    rugCheckOverallRiskLevel?: string; // Derived from rugCheckReport.risks array or .rugged status
    rugCheckIndividualRisks?: { name: string; level: string; description: string; score?: number }[];
    rugCheckIsMutableMetadata?: boolean; // From rugCheckReport.tokenMeta.mutable
    rugCheckMintAuthorityEnabledRC?: boolean; // From rugCheckReport.token.mintAuthority (true if not null)
    rugCheckFreezeAuthorityEnabledRC?: boolean; // From rugCheckReport.token.freezeAuthority (true if not null)
    rugCheckLpLockedPct?: number; // From rugCheckReport.markets[0]?.lp?.lpLockedPct
    rugCheckPriceRC?: number; // From rugCheckReport.price
    rugCheckIsRugged?: boolean; // From rugCheckReport.rugged
    rugCheckTotalMarketLiquidityRC?: number; // From rugCheckReport.totalMarketLiquidity
    // Fields for basic token info from RugCheck
    rugCheckTokenName?: string;
    rugCheckTokenSymbol?: string;
    rugCheckTokenDescription?: string;
    rugCheckCreator?: string;
  };
}

export class OnchainAnalyzer {
  constructor() {}

  private async fetchRugCheckReport(tokenMintAddress: string): Promise<any | null> {
    const url = `${appConfig.rugCheckApiBaseUrl}/${tokenMintAddress}/report`;
    try {
      logger.debug(`OnchainAnalyzer: Fetching RugCheck report for ${tokenMintAddress} from ${url}`);
      const response = await axios.get(url);
      if (response.status === 200 && response.data) {
        // Using a general log for success, specific risk details will be processed in analyzeToken
        logger.info(`OnchainAnalyzer: RugCheck report fetched successfully for ${tokenMintAddress}.`);
        return response.data;
      }
      logger.warn(`OnchainAnalyzer: Failed to fetch RugCheck report for ${tokenMintAddress}. Status: ${response.status}`);
      return null;
    } catch (error: any) {
      if (error.response) {
        logger.error(`OnchainAnalyzer: Error fetching RugCheck report for ${tokenMintAddress}. Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
      } else {
        logger.error(`OnchainAnalyzer: Error fetching RugCheck report for ${tokenMintAddress}: ${error.message}`);
      }
      return null;
    }
  }

  public async analyzeToken(tokenMintAddress: string, eventData: any): Promise<TokenAnalysisResult> {
    const tokenMintPublicKey = new PublicKey(tokenMintAddress);
    const result: TokenAnalysisResult = {
      passed: false,
      reasons: [],
      details: {},
    };

    try {
      // 1. On-chain Mint and Freeze Authority (initial check)
      const mintInfo = await solanaService.getParsedAccountInfo(tokenMintPublicKey);
      if (!mintInfo || !mintInfo.data || !('parsed' in mintInfo.data)) {
        result.reasons.push('Failed to fetch or parse mint account info.');
        return result; 
      }
      const parsedMintInfo = mintInfo.data.parsed.info;
      result.details.mintAuthorityRenounced = !parsedMintInfo.mintAuthority;
      result.details.freezeAuthorityRenounced = !parsedMintInfo.freezeAuthority;

      // 2. Fetch and Process RugCheck Report
      const rugCheckReport = await this.fetchRugCheckReport(tokenMintAddress);
      if (rugCheckReport) {
        result.details.rugCheckScore = rugCheckReport.score;
        result.details.rugCheckIsRugged = rugCheckReport.rugged;
        result.details.rugCheckPriceRC = rugCheckReport.price;
        result.details.rugCheckTotalMarketLiquidityRC = rugCheckReport.totalMarketLiquidity;
        
        // Populate basic token info from RugCheck
        result.details.rugCheckTokenName = rugCheckReport.tokenMeta?.name;
        result.details.rugCheckTokenSymbol = rugCheckReport.tokenMeta?.symbol;
        result.details.rugCheckCreator = rugCheckReport.creator;
        result.details.rugCheckTokenDescription = rugCheckReport.fileMeta?.description; // Or tokenMeta.description if available

        result.details.rugCheckIsMutableMetadata = rugCheckReport.tokenMeta?.mutable === false ? false : true; 
        result.details.rugCheckMintAuthorityEnabledRC = rugCheckReport.token?.mintAuthority !== null;
        result.details.rugCheckFreezeAuthorityEnabledRC = rugCheckReport.token?.freezeAuthority !== null;

        if (rugCheckReport.markets && rugCheckReport.markets.length > 0 && rugCheckReport.markets[0].lp) {
          result.details.rugCheckLpLockedPct = rugCheckReport.markets[0].lp.lpLockedPct;
        }

        result.details.rugCheckIndividualRisks = (rugCheckReport.risks || []).map((r: any) => ({
          name: r.name,
          level: r.level, // e.g., "warn", "high"
          description: r.description,
          score: r.score
        }));
        
        // Determine overall risk level from individual risks if not directly provided or to supplement 'rugged'
        let highestRiskLevel = "NONE";
        if (result.details.rugCheckIsRugged) highestRiskLevel = "CRITICAL";

        (result.details.rugCheckIndividualRisks || []).forEach(risk => {
          const riskLevel = risk.level?.toUpperCase();
          // Treat "DANGER" similar to "HIGH" or "CRITICAL"
          if (riskLevel === "HIGH" || riskLevel === "CRITICAL" || riskLevel === "DANGER") {
            highestRiskLevel = "CRITICAL"; // Elevate to CRITICAL if any of these are present
          } else if (riskLevel === "WARN" && highestRiskLevel !== "CRITICAL") {
            highestRiskLevel = "WARN"; 
          }
        });
        result.details.rugCheckOverallRiskLevel = highestRiskLevel;

        // Add reasons based on RugCheck overall risk level and specific flags
        if (result.details.rugCheckIsRugged) {
          result.reasons.push("RugCheck: Token is marked as rugged (direct flag).");
        }
        // Add reason if overall risk level from individual checks is high
        if (highestRiskLevel === "CRITICAL") {
            result.reasons.push(`RugCheck: Overall risk level determined as CRITICAL/DANGER from individual risks.`);
        } else if (highestRiskLevel === "WARN") {
            result.reasons.push(`RugCheck: Overall risk level determined as WARN/MEDIUM from individual risks.`);
        }

        if (result.details.rugCheckIsMutableMetadata) {
          result.reasons.push("RugCheck: Metadata is mutable.");
        }
        if (result.details.rugCheckMintAuthorityEnabledRC) {
          result.reasons.push("RugCheck: Mint authority is enabled.");
        }
        if (result.details.rugCheckFreezeAuthorityEnabledRC) {
          result.reasons.push("RugCheck: Freeze authority is enabled.");
        }

        // Add reasons for specific individual risks that are high severity
        (result.details.rugCheckIndividualRisks || []).forEach(risk => {
          const riskLevel = risk.level?.toUpperCase();
          if (riskLevel === "HIGH" || riskLevel === "CRITICAL" || riskLevel === "DANGER") {
            result.reasons.push(`RugCheck Risk (${risk.level}): ${risk.name} - ${risk.description || 'No further details'}.`);
          } else if (riskLevel === "WARN") {
            // You might want to be more selective about which WARN level risks cause a failure.
            // For now, let's add a generic warning reason if overall is WARN, handled above.
            // Or add specific warnings like:
            // if (risk.name === "Low amount of LP Providers") {
            //      result.reasons.push(`RugCheck Warning: ${risk.name}.`);
            // }
          }
        });
        
        // Cross-check on-chain with RugCheck for authorities
        if (result.details.mintAuthorityRenounced !== !result.details.rugCheckMintAuthorityEnabledRC) {
            logger.warn(`OnchainAnalyzer: Discrepancy in mint authority for ${tokenMintAddress}. On-chain renounced: ${result.details.mintAuthorityRenounced}, RugCheck enabled: ${result.details.rugCheckMintAuthorityEnabledRC}`);
            // Prioritize RugCheck's finding if it says authority is enabled, or add specific reason for discrepancy
            if (result.details.rugCheckMintAuthorityEnabledRC && !result.reasons.some(r => r.includes("Mint authority is enabled"))) {
                 result.reasons.push("RugCheck indicates mint authority may still be effectively enabled despite on-chain status.");
            }
        }
         if (result.details.freezeAuthorityRenounced !== !result.details.rugCheckFreezeAuthorityEnabledRC) {
            logger.warn(`OnchainAnalyzer: Discrepancy in freeze authority for ${tokenMintAddress}. On-chain renounced: ${result.details.freezeAuthorityRenounced}, RugCheck enabled: ${result.details.rugCheckFreezeAuthorityEnabledRC}`);
             if (result.details.rugCheckFreezeAuthorityEnabledRC && !result.reasons.some(r => r.includes("Freeze authority is enabled"))) {
                 result.reasons.push("RugCheck indicates freeze authority may still be effectively enabled despite on-chain status.");
            }
        }


      } else {
        result.reasons.push('Failed to fetch RugCheck report. Analysis considered incomplete.');
        // Policy: If RugCheck is critical, this should be a hard fail.
      }
      
      // 3. On-chain checks (can be redundant if RugCheck covers them, but good for verification or if RugCheck fails)
      // Ensure these don't add duplicate reasons if already covered by RugCheck processing.
      if (!result.details.mintAuthorityRenounced && !result.reasons.some(r => r.includes("Mint authority is enabled"))) {
        result.reasons.push(`On-chain: Mint authority not renounced (is ${parsedMintInfo.mintAuthority}).`);
      }
      if (!result.details.freezeAuthorityRenounced && !result.reasons.some(r => r.includes("Freeze authority is enabled"))) {
        result.reasons.push(`On-chain: Freeze authority not renounced (is ${parsedMintInfo.freezeAuthority}).`);
      }

      // 4. Liquidity Check
      if (eventData && eventData.poolAddress) {
        // ... (Liquidity check logic - assuming it's largely correct from previous state)
        // For brevity, this part is condensed. Ensure it's correctly placed from the previous version.
        // The key is that it populates result.details.liquidityUsd
        // And adds a reason if liquidity < appConfig.minLiquidityUsd
        logger.debug(`OnchainAnalyzer: Attempting to fetch liquidity from poolAddress: ${eventData.poolAddress}`);
        try {
          const ammPoolAddress = new PublicKey(eventData.poolAddress);
          const connection = solanaService.getSolanaConnection();
          const ammAccountInfo = await connection.getAccountInfo(ammPoolAddress);

          if (ammAccountInfo && ammAccountInfo.data) {
            if (ammAccountInfo.owner.equals(MAINNET_PROGRAM_ID.AmmV4)) {
              const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(ammAccountInfo.data);
              let solVaultPublicKey: PublicKey | null = null;
              if (poolState.quoteMint.equals(NATIVE_MINT)) solVaultPublicKey = poolState.quoteVault;
              else if (poolState.baseMint.equals(NATIVE_MINT)) solVaultPublicKey = poolState.baseVault;

              if (solVaultPublicKey) {
                const solVaultAccountInfo = await connection.getTokenAccountBalance(solVaultPublicKey);
                if (solVaultAccountInfo?.value?.amount) {
                  const solBalance = Number(BigInt(solVaultAccountInfo.value.amount)) / LAMPORTS_PER_SOL;
                  const fetchedSolPriceUsd = await getSolUsdPrice();
                  result.details.liquidityUsd = solBalance * fetchedSolPriceUsd * 2;
                  logger.info(`OnchainAnalyzer: Calculated liquidity from pool ${eventData.poolAddress}: $${result.details.liquidityUsd?.toFixed(2)}`);
                } else { result.details.liquidityUsd = typeof eventData.marketCap === 'number' ? eventData.marketCap : 0; }
              } else { result.details.liquidityUsd = typeof eventData.marketCap === 'number' ? eventData.marketCap : 0; }
            } else { result.details.liquidityUsd = typeof eventData.marketCap === 'number' ? eventData.marketCap : 0; }
          } else { result.details.liquidityUsd = typeof eventData.marketCap === 'number' ? eventData.marketCap : 0; }
        } catch (e: any) {
          logger.error(`OnchainAnalyzer: Error fetching/parsing liquidity for pool ${eventData.poolAddress}: ${e.message}.`);
          result.details.liquidityUsd = typeof eventData.marketCap === 'number' ? eventData.marketCap : 0;
        }
      } else if (eventData && typeof eventData.marketCap === 'number' && eventData.marketCap > 0) {
        result.details.liquidityUsd = eventData.marketCap;
      } else {
        result.details.liquidityUsd = 0;
      }
      
      const currentLiquidityUsd = result.details.liquidityUsd || 0;
      if (currentLiquidityUsd < appConfig.minLiquidityUsd) {
        result.reasons.push(`Insufficient liquidity: $${currentLiquidityUsd.toFixed(2)} < $${appConfig.minLiquidityUsd}.`);
      }
      result.details.liquidityUsd = currentLiquidityUsd;


      // 5. Holder Count & Distribution
      const connection = solanaService.getSolanaConnection();
      const tokenAccountsResponse = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
        filters: [ { dataSize: AccountLayout.span }, { memcmp: { offset: 0, bytes: tokenMintPublicKey.toBase58() } } ],
      });

      const holders: { owner: string, amount: number }[] = [];
      const supplyNumber = typeof parsedMintInfo.supply === 'bigint' ? Number(parsedMintInfo.supply) : parsedMintInfo.supply;
      const decimalsNumber = parsedMintInfo.decimals;
      let totalSupplyUi = supplyNumber / (10 ** decimalsNumber);

      if (!tokenAccountsResponse || tokenAccountsResponse.length === 0) {
        result.reasons.push('No token accounts found for the mint.');
        result.details.holderCount = 0;
      } else {
        tokenAccountsResponse.forEach(accInfo => {
          const accountData = AccountLayout.decode(accInfo.account.data);
          const tokenAmount = typeof accountData.amount === 'bigint' ? Number(accountData.amount) : accountData.amount;
          if (tokenAmount / (10 ** decimalsNumber) > 0) { // Only count actual holders
            holders.push({ owner: new PublicKey(accountData.owner).toBase58(), amount: tokenAmount / (10 ** decimalsNumber) });
          }
        });
        result.details.holderCount = holders.length;
      }
      
      if (result.details.holderCount < appConfig.minHolders) {
        result.reasons.push(`Insufficient holders: ${result.details.holderCount || 0} < ${appConfig.minHolders}.`);
      }

      if (holders.length > 0 && totalSupplyUi > 0) {
        holders.sort((a, b) => b.amount - a.amount);
        const top10Holders = holders.slice(0, 10);
        const top10Supply = top10Holders.reduce((sum, h) => sum + h.amount, 0);
        result.details.top10HoldersPercentage = top10Supply / totalSupplyUi;
        if (result.details.top10HoldersPercentage > appConfig.maxTop10HolderPercentage) {
          result.reasons.push(`Top 10 holders control too much supply: ${(result.details.top10HoldersPercentage * 100).toFixed(2)}% > ${(appConfig.maxTop10HolderPercentage * 100).toFixed(2)}%.`);
        }
      } else if (holders.length > 0 && totalSupplyUi === 0) {
        result.reasons.push('Total supply is zero, cannot calculate holder percentage.');
      }

      // Final determination of 'passed' status
      if (result.reasons.length === 0) {
        result.passed = true;
      } else {
        // Deduplicate reasons before finalizing
        result.reasons = [...new Set(result.reasons)];
        result.passed = false;
      }

    } catch (error: any) {
      logger.error(`Error during token analysis for ${tokenMintAddress}: ${error.message}`, error.stack);
      result.reasons.push(`An unexpected error occurred during analysis: ${error.message}`);
      result.passed = false;
    }
    return result;
  }
}

// Example Usage (will be in main.ts)
/*
async function testAnalyzer() {
  const analyzer = new OnchainAnalyzer();
  // Replace with a real token address for testing (preferably a pump.fun graduated one)
  const testToken = "TEST_MINT_ADDRESS_HERE"; 
  if (testToken === "TEST_MINT_ADDRESS_HERE") {
      console.log("Please replace TEST_MINT_ADDRESS_HERE with an actual token mint address to test.");
      return;
  }
  const analysis = await analyzer.analyzeToken(testToken, {}); // Added empty eventData for standalone testing
  console.log("Analysis Result:", JSON.stringify(analysis, null, 2));
}
// testAnalyzer();
*/
