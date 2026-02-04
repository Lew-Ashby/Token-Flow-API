import { Helius } from 'helius-sdk';
import { Connection, PublicKey, ParsedTransactionWithMeta, ParsedInstruction } from '@solana/web3.js';
import { ParsedTransaction, Transfer, QueryOptions } from '../types';
import { redis } from '../utils/redis';
import { CircuitBreaker, retryWithBackoff } from '../utils/circuit-breaker';

export class HeliusService {
  private helius: Helius;
  private connection: Connection;
  private circuitBreaker: CircuitBreaker;

  constructor() {
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) {
      throw new Error('HELIUS_API_KEY is required');
    }

    this.helius = new Helius(apiKey, process.env.HELIUS_CLUSTER as any || 'mainnet-beta');
    this.connection = new Connection(
      `https://rpc.helius.xyz/?api-key=${apiKey}`,
      'confirmed'
    );
    this.circuitBreaker = new CircuitBreaker(5, 60000, 2);
  }

  async getTransaction(signature: string): Promise<ParsedTransaction | null> {
    const cacheKey = `tx:${signature}`;
    const cached = await redis.getJson<ParsedTransaction>(cacheKey);

    if (cached) {
      return cached;
    }

    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.blockTime) {
      return null;
    }

    const parsedTx: ParsedTransaction = {
      signature,
      blockTime: tx.blockTime,
      slot: tx.slot,
      fee: tx.meta?.fee || 0,
      success: tx.meta?.err === null,
      accounts: tx.transaction.message.accountKeys.map(key => key.pubkey.toString()),
      instructions: tx.transaction.message.instructions,
    };

    await redis.setJson(cacheKey, parsedTx, 3600);

    return parsedTx;
  }

  async getAddressTransactions(
    address: string,
    options: QueryOptions = {}
  ): Promise<ParsedTransaction[]> {
    const limit = options.limit || 100;
    const signatures = await this.connection.getSignaturesForAddress(
      new PublicKey(address),
      {
        limit,
        before: options.before as string | undefined,
        until: options.until as string | undefined,
      }
    );

    const transactions: ParsedTransaction[] = [];

    for (const sig of signatures) {
      const tx = await this.getTransaction(sig.signature);
      if (tx) {
        transactions.push(tx);
      }
    }

    return transactions;
  }

  async getTokenTransfers(
    address: string,
    tokenMint: string,
    limit: number = 100
  ): Promise<Transfer[]> {
    const cacheKey = `transfers:${address}:${tokenMint}:${limit}`;
    const cached = await redis.getJson<any[]>(cacheKey);

    if (cached) {
      return cached.map(t => ({
        ...t,
        amount: BigInt(t.amount),
      }));
    }

    // Use Helius Enhanced API to get transfers with proper wallet addresses
    const apiKey = process.env.HELIUS_API_KEY;
    const response = await fetch(
      `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${apiKey}&limit=${limit}`
    );

    if (!response.ok) {
      console.error('Helius API error:', response.status);
      return [];
    }

    const transactions = await response.json() as any[];
    const transfers: Transfer[] = [];

    for (const tx of transactions) {
      if (!tx.tokenTransfers) continue;

      for (const tt of tx.tokenTransfers) {
        // Filter by token mint if specified
        if (tokenMint && tt.mint !== tokenMint) continue;

        transfers.push({
          signature: tx.signature,
          fromAddress: tt.fromUserAccount || tt.fromTokenAccount,
          toAddress: tt.toUserAccount || tt.toTokenAccount,
          tokenMint: tt.mint,
          amount: BigInt(Math.floor((tt.tokenAmount || 0) * Math.pow(10, tt.decimals || 6))),
          decimals: tt.decimals || 6,
          instructionIndex: 0,
          blockTime: tx.timestamp,
        });
      }
    }

    // Cache with string amounts
    const serializableTransfers = transfers.map(t => ({
      ...t,
      amount: t.amount.toString(),
    }));
    await redis.setJson(cacheKey, serializableTransfers, 300);

    return transfers;
  }

  async parseTransferInstructions(
    tx: ParsedTransaction,
    tokenMint?: string
  ): Promise<Transfer[]> {
    const transfers: Transfer[] = [];

    for (let i = 0; i < tx.instructions.length; i++) {
      const instruction = tx.instructions[i] as ParsedInstruction;

      if (
        instruction.program === 'spl-token' &&
        instruction.parsed?.type === 'transfer'
      ) {
        const info = instruction.parsed.info;

        if (tokenMint && info.mint && info.mint !== tokenMint) {
          continue;
        }

        transfers.push({
          signature: tx.signature,
          fromAddress: info.source || info.authority,
          toAddress: info.destination,
          tokenMint: info.mint || tokenMint || '',
          amount: BigInt(info.amount || info.tokenAmount?.amount || '0'),
          decimals: info.tokenAmount?.decimals || 0,
          instructionIndex: i,
          blockTime: tx.blockTime,
        });
      }

      if (
        instruction.program === 'spl-token' &&
        instruction.parsed?.type === 'transferChecked'
      ) {
        const info = instruction.parsed.info;

        if (tokenMint && info.mint !== tokenMint) {
          continue;
        }

        transfers.push({
          signature: tx.signature,
          fromAddress: info.source || info.authority,
          toAddress: info.destination,
          tokenMint: info.mint,
          amount: BigInt(info.tokenAmount?.amount || '0'),
          decimals: info.tokenAmount?.decimals || 0,
          instructionIndex: i,
          blockTime: tx.blockTime,
        });
      }
    }

    return transfers;
  }

  async getEnhancedTransaction(signature: string): Promise<any> {
    return this.connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
  }

  async getRecentTokenActivity(
    tokenMint: string,
    limit: number = 100
  ): Promise<Transfer[]> {
    const cacheKey = `token-activity:${tokenMint}:${limit}`;
    const cached = await redis.getJson<any[]>(cacheKey);

    if (cached) {
      return cached.map(t => ({
        ...t,
        amount: BigInt(t.amount),
      }));
    }

    const apiKey = process.env.HELIUS_API_KEY;
    const transfers: Transfer[] = [];

    try {
      // Approach 1: Get signatures for the token mint using RPC with pagination
      // This captures transferChecked transactions and mint/burn events
      console.log(`[Helius] Getting signatures for token mint: ${tokenMint.slice(0, 8)}... (limit: ${limit})`);

      const allSignatures: { signature: string }[] = [];
      let beforeSig: string | undefined = undefined;
      const maxPerPage = 1000; // Solana RPC max is 1000

      // Paginate to get enough signatures
      while (allSignatures.length < limit) {
        const remaining = limit - allSignatures.length;
        const pageSize = Math.min(remaining, maxPerPage);

        const sigs = await this.connection.getSignaturesForAddress(
          new PublicKey(tokenMint),
          { limit: pageSize, before: beforeSig }
        );

        if (sigs.length === 0) break;

        allSignatures.push(...sigs);
        beforeSig = sigs[sigs.length - 1].signature;

        // If we got fewer than requested, no more pages available
        if (sigs.length < pageSize) break;
      }

      console.log(`[Helius] Found ${allSignatures.length} signatures for token mint`);

      // Batch fetch transactions for better performance (10 at a time)
      const batchSize = 10;
      for (let i = 0; i < allSignatures.length && transfers.length < limit; i += batchSize) {
        const batch = allSignatures.slice(i, i + batchSize);
        const batchSigs = batch.map(s => s.signature);

        try {
          // Use Helius Enhanced API for better parsing - batch multiple transactions
          const response = await fetch(
            `https://api.helius.xyz/v0/transactions/?api-key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ transactions: batchSigs }),
            }
          );

          if (response.ok) {
            const txData = await response.json() as any[];

            for (const tx of txData) {
              // Determine transaction type from Helius response (pass target token for context)
              const txType = this.classifyTransactionType(tx, tokenMint);
              const swapInfo = txType === 'swap' ? this.extractSwapInfo(tx, tokenMint) : undefined;

              // Determine swap direction (buy/sell) for swaps
              let swapDirection: 'buy' | 'sell' | undefined = undefined;
              if (txType === 'swap') {
                swapDirection = this.determineSwapDirection(tx, tokenMint);
              }

              // Process token transfers
              if (tx.tokenTransfers) {
                for (const tt of tx.tokenTransfers) {
                  // Only include transfers of this specific token
                  if (tt.mint !== tokenMint) continue;

                  transfers.push({
                    signature: tx.signature,
                    fromAddress: tt.fromUserAccount || tt.fromTokenAccount,
                    toAddress: tt.toUserAccount || tt.toTokenAccount,
                    tokenMint: tt.mint,
                    amount: BigInt(Math.floor((tt.tokenAmount || 0) * Math.pow(10, tt.decimals || 6))),
                    decimals: tt.decimals || 6,
                    instructionIndex: 0,
                    blockTime: tx.timestamp,
                    txType,
                    swapDirection,
                    swapInfo,
                  });
                }
              }
            }
          }
        } catch (batchError) {
          console.error(`[Helius] Error fetching batch:`, batchError);
        }
      }

      // Approach 2: If no transfers found via mint signatures, try searching recent blocks
      // This is a fallback for tokens that use regular 'transfer' instead of 'transferChecked'
      if (transfers.length === 0) {
        console.log(`[Helius] No transfers via mint signatures, trying token account approach...`);

        // Get token largest accounts (top holders)
        try {
          const largestAccounts = await this.connection.getTokenLargestAccounts(
            new PublicKey(tokenMint)
          );

          // Query the top 3 largest holders for recent activity
          const topHolders = largestAccounts.value.slice(0, 3);

          for (const holder of topHolders) {
            const holderAddress = holder.address.toString();

            // Get account info to find the owner
            const accountInfo = await this.connection.getParsedAccountInfo(holder.address);
            const ownerAddress = (accountInfo.value?.data as any)?.parsed?.info?.owner;

            if (!ownerAddress) continue;

            // Use Helius Enhanced API to get transfers for this holder
            const holderResponse = await fetch(
              `https://api.helius.xyz/v0/addresses/${ownerAddress}/transactions?api-key=${apiKey}&limit=50`
            );

            if (holderResponse.ok) {
              const holderTxs = await holderResponse.json() as any[];

              for (const tx of holderTxs) {
                if (!tx.tokenTransfers) continue;

                const txType = this.classifyTransactionType(tx, tokenMint);
                const swapInfo = txType === 'swap' ? this.extractSwapInfo(tx, tokenMint) : undefined;
                const swapDirection = txType === 'swap' ? this.determineSwapDirection(tx, tokenMint) : undefined;

                for (const tt of tx.tokenTransfers) {
                  if (tt.mint !== tokenMint) continue;

                  // Check if we already have this transfer
                  const exists = transfers.some(t =>
                    t.signature === tx.signature &&
                    t.fromAddress === (tt.fromUserAccount || tt.fromTokenAccount)
                  );

                  if (!exists) {
                    transfers.push({
                      signature: tx.signature,
                      fromAddress: tt.fromUserAccount || tt.fromTokenAccount,
                      toAddress: tt.toUserAccount || tt.toTokenAccount,
                      tokenMint: tt.mint,
                      amount: BigInt(Math.floor((tt.tokenAmount || 0) * Math.pow(10, tt.decimals || 6))),
                      decimals: tt.decimals || 6,
                      instructionIndex: 0,
                      blockTime: tx.timestamp,
                      txType,
                      swapDirection,
                      swapInfo,
                    });
                  }
                }
              }
            }

            if (transfers.length >= limit) break;
          }
        } catch (holderError) {
          console.error('[Helius] Error fetching token holders:', holderError);
        }
      }
    } catch (error) {
      console.error('[Helius] Error in getRecentTokenActivity:', error);
    }

    // Sort by timestamp descending
    transfers.sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));

    // Limit results
    const limitedTransfers = transfers.slice(0, limit);

    // Cache with string amounts
    const serializableTransfers = limitedTransfers.map(t => ({
      ...t,
      amount: t.amount.toString(),
    }));
    await redis.setJson(cacheKey, serializableTransfers, 120); // Cache for 2 minutes

    console.log(`[Helius] getRecentTokenActivity: ${tokenMint.slice(0, 8)}... found ${limitedTransfers.length} transfers`);
    return limitedTransfers;
  }

  async getParsedTransactionHistory(
    address: string,
    startTime: number,
    endTime: number
  ): Promise<ParsedTransaction[]> {
    const transactions: ParsedTransaction[] = [];
    let before: string | undefined = undefined;

    while (true) {
      const sigs = await this.connection.getSignaturesForAddress(
        new PublicKey(address),
        {
          limit: 100,
          before,
        }
      );

      if (sigs.length === 0) break;

      for (const sig of sigs) {
        if (sig.blockTime && sig.blockTime >= startTime && sig.blockTime <= endTime) {
          const tx = await this.getTransaction(sig.signature);
          if (tx) {
            transactions.push(tx);
          }
        }

        if (sig.blockTime && sig.blockTime < startTime) {
          return transactions;
        }
      }

      before = sigs[sigs.length - 1].signature;

      if (sigs.length < 100) break;
    }

    return transactions;
  }

  // Known DEX program IDs for swap classification
  private readonly DEX_PROGRAMS = new Set([
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter v6
    'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  // Jupiter v4
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
    '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca v1
    'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',  // Serum DEX
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora Pools
    'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',  // Phoenix
  ]);

  private readonly DEX_NAMES: { [key: string]: string } = {
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter',
    'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB': 'Jupiter',
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca',
    '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': 'Orca',
    'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX': 'Serum',
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora',
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Meteora',
    'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY': 'Phoenix',
  };

  private classifyTransactionType(tx: any, targetTokenMint?: string): 'transfer' | 'swap' | 'unknown' {
    // For token activity analysis, we need to determine if the TARGET token is being:
    // - TRANSFERRED: moved from wallet A to wallet B (same token in and out)
    // - SWAPPED: exchanged for a different token
    //
    // KEY RULE: A swap MUST involve 2+ different significant token types being exchanged.
    // If only 1 token type moves (even through DEX routing), it's a transfer.

    if (!tx.tokenTransfers || tx.tokenTransfers.length === 0) {
      return 'unknown';
    }

    // Get unique token mints involved (excluding tiny wrapped SOL transfers which are just fees)
    const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
    const significantMints = new Set<string>();

    for (const tt of tx.tokenTransfers) {
      const amount = tt.tokenAmount || 0;
      // Only count SOL if it's a significant amount (> 0.1 SOL), otherwise it's likely just fees
      if (tt.mint !== WRAPPED_SOL || amount > 0.1) {
        significantMints.add(tt.mint);
      }
    }

    // CRITICAL: A real swap requires 2+ different tokens being exchanged
    // If only 1 token type is involved, it's ALWAYS a transfer (even if routed through DEX)
    const hasMultipleTokenTypes = significantMints.size >= 2;

    // If Helius says TRANSFER, trust it
    if (tx.type) {
      const txType = tx.type.toUpperCase();
      if (txType === 'TRANSFER' || txType === 'TOKEN_TRANSFER') {
        return 'transfer';
      }
    }

    // Only classify as swap if there are actually multiple token types
    if (!hasMultipleTokenTypes) {
      // Single token type = transfer, regardless of DEX routing or Helius classification
      return 'transfer';
    }

    // We have 2+ token types - check if this is a swap
    // Check for explicit swap event from Helius (AND we have multiple tokens)
    if (tx.events?.swap) {
      return 'swap';
    }

    // If Helius says SWAP and we have multiple tokens, it's a swap
    if (tx.type) {
      const txType = tx.type.toUpperCase();
      if (txType === 'SWAP' || txType.includes('SWAP')) {
        return 'swap';
      }
    }

    // Multiple tokens involved = likely a swap
    return 'swap';
  }

  private extractSwapInfo(tx: any, tokenMint: string): { dex?: string; tokenIn?: string; tokenOut?: string; amountIn?: string; amountOut?: string } | undefined {
    const swapInfo: { dex?: string; tokenIn?: string; tokenOut?: string; amountIn?: string; amountOut?: string } = {};

    // Try to get DEX from program IDs
    const instructions = tx.instructions || [];
    for (const inst of instructions) {
      if (inst.programId && this.DEX_NAMES[inst.programId]) {
        swapInfo.dex = this.DEX_NAMES[inst.programId];
        break;
      }
    }

    // If not found in instructions, check account data
    if (!swapInfo.dex) {
      const accountKeys = tx.accountData?.map((a: any) => a.account) || [];
      for (const account of accountKeys) {
        if (this.DEX_NAMES[account]) {
          swapInfo.dex = this.DEX_NAMES[account];
          break;
        }
      }
    }

    // Extract token in/out from token transfers
    if (tx.tokenTransfers && tx.tokenTransfers.length >= 2) {
      // Find the token being swapped from and to
      for (const tt of tx.tokenTransfers) {
        if (tt.mint === tokenMint) {
          // This is our target token
          // Determine if it's input or output based on the transaction structure
        } else {
          // This is the other token in the swap
          if (!swapInfo.tokenIn || swapInfo.tokenIn === tokenMint) {
            swapInfo.tokenOut = tt.mint;
          } else {
            swapInfo.tokenIn = tt.mint;
          }
        }
      }
    }

    // Try to get from swap events
    if (tx.events?.swap) {
      const swap = tx.events.swap;
      swapInfo.tokenIn = swap.tokenInputs?.[0]?.mint;
      swapInfo.tokenOut = swap.tokenOutputs?.[0]?.mint;
      swapInfo.amountIn = swap.tokenInputs?.[0]?.rawTokenAmount?.tokenAmount;
      swapInfo.amountOut = swap.tokenOutputs?.[0]?.rawTokenAmount?.tokenAmount;
    }

    return Object.keys(swapInfo).length > 0 ? swapInfo : undefined;
  }

  /**
   * Determine if a swap is a buy or sell for the target token.
   * Buy = user receives the target token (token flows TO user)
   * Sell = user sends the target token (token flows FROM user)
   */
  private determineSwapDirection(tx: any, tokenMint: string): 'buy' | 'sell' | undefined {
    if (!tx.tokenTransfers || tx.tokenTransfers.length === 0) {
      return undefined;
    }

    // Find transfers of the target token
    const targetTokenTransfers = tx.tokenTransfers.filter(
      (tt: any) => tt.mint === tokenMint
    );

    if (targetTokenTransfers.length === 0) {
      return undefined;
    }

    // Get the fee payer (usually the user initiating the swap)
    const feePayer = tx.feePayer || tx.accountData?.[0]?.account;

    // Check if the user is receiving or sending the target token
    for (const tt of targetTokenTransfers) {
      const toAddress = tt.toUserAccount || tt.toTokenAccount;
      const fromAddress = tt.fromUserAccount || tt.fromTokenAccount;

      // If the target token is being received by the fee payer, it's a buy
      if (toAddress === feePayer) {
        return 'buy';
      }

      // If the target token is being sent from the fee payer, it's a sell
      if (fromAddress === feePayer) {
        return 'sell';
      }
    }

    // Fallback: Check swap events if available
    if (tx.events?.swap) {
      const swap = tx.events.swap;

      // If target token is in outputs, it's a buy
      const isOutputToken = swap.tokenOutputs?.some(
        (t: any) => t.mint === tokenMint
      );
      if (isOutputToken) {
        return 'buy';
      }

      // If target token is in inputs, it's a sell
      const isInputToken = swap.tokenInputs?.some(
        (t: any) => t.mint === tokenMint
      );
      if (isInputToken) {
        return 'sell';
      }
    }

    // Secondary fallback: Look at the direction of target token flow
    // If the token amount in the transfer is positive (incoming), it's likely a buy
    for (const tt of targetTokenTransfers) {
      // Check if user received the token (buy) vs sent (sell)
      // Use the nativeTransfers to determine the user's wallet
      const nativeTransfers = tx.nativeTransfers || [];
      const userWallet = nativeTransfers.length > 0
        ? nativeTransfers[0].fromUserAccount
        : feePayer;

      if (userWallet) {
        const toAddress = tt.toUserAccount || tt.toTokenAccount;
        const fromAddress = tt.fromUserAccount || tt.fromTokenAccount;

        if (toAddress === userWallet) return 'buy';
        if (fromAddress === userWallet) return 'sell';
      }
    }

    return undefined;
  }
}

export const heliusService = new HeliusService();
