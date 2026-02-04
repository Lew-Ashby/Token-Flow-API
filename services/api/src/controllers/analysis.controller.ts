import { Request, Response } from 'express';
import { flowBuilderService } from '../services/flow-builder.service';
import { riskScoringService } from '../services/risk-scoring.service';
import { heliusService } from '../services/helius.service';
import { mlService } from '../services/ml.service';
import { PathAnalysisRequest, PathAnalysisResponse, TraceRequest } from '../types';

export class AnalysisController {
  async analyzePath(req: Request, res: Response): Promise<void> {
    const body: PathAnalysisRequest = req.body;

    if (!body.address || !body.token) {
      res.status(400).json({ error: 'address and token are required' });
      return;
    }

    const direction = body.direction || 'forward';
    const maxDepth = Math.min(body.maxDepth || 5, 10);
    const timeRangeStr = body.timeRange || '30d';

    const timeRange = this.parseTimeRange(timeRangeStr);

    let paths;
    if (direction === 'forward') {
      paths = await flowBuilderService.buildForwardPath(
        body.address,
        body.token,
        maxDepth,
        timeRange
      );
    } else {
      paths = await flowBuilderService.buildBackwardPath(
        body.address,
        body.token,
        maxDepth,
        timeRange
      );
    }

    for (const path of paths) {
      if (path.hops.length > 0) {
        const lastHop = path.hops[path.hops.length - 1];

        // Skip transaction-based intent analysis for now - use default
        path.intent = 'transfer';
        path.intentConfidence = 0.75;

        try {
          const risk = await riskScoringService.assessRisk(lastHop.address, body.token);
          path.riskScore = risk.riskScore;
          path.riskLevel = risk.riskLevel;
        } catch (e) {
          path.riskScore = 0;
          path.riskLevel = 'low';
        }
      }
    }

    let totalIn = BigInt(0);
    let totalOut = BigInt(0);

    for (const path of paths) {
      if (direction === 'forward') {
        totalOut += BigInt(path.totalAmount);
      } else {
        totalIn += BigInt(path.totalAmount);
      }
    }

    const response: PathAnalysisResponse = {
      paths,
      summary: {
        totalPaths: paths.length,
        netFlow: {
          in: totalIn.toString(),
          out: totalOut.toString(),
        },
      },
    };

    res.json(response);
  }

  async getRiskAssessment(req: Request, res: Response): Promise<void> {
    const { address } = req.params;
    const { token } = req.query;

    if (!address || !token) {
      res.status(400).json({ error: 'address and token query parameter are required' });
      return;
    }

    const assessment = await riskScoringService.assessRisk(address, token as string);

    res.json(assessment);
  }

  async getTransactionIntent(req: Request, res: Response): Promise<void> {
    const { signature } = req.params;

    if (!signature) {
      res.status(400).json({ error: 'signature is required' });
      return;
    }

    const tx = await heliusService.getTransaction(signature);

    if (!tx) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    const intent = await mlService.predictIntent(tx);

    const dexPrograms = [
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    ];

    const dexInteraction = tx.accounts.some(acc => dexPrograms.includes(acc));
    const tokenSwapped = tx.instructions.some(
      (inst: any) => inst.program === 'spl-token' && inst.parsed?.type === 'transfer'
    );

    const programsInvolved = [...new Set(tx.instructions.map((inst: any) => inst.program || inst.programId?.toString()))]
      .filter(Boolean);

    res.json({
      signature,
      intent: intent.intent,
      confidence: intent.confidence,
      details: {
        dexInteraction,
        tokenSwapped,
        programsInvolved,
      },
    });
  }

  async analyzeToken(req: Request, res: Response): Promise<void> {
    const { token } = req.body;
    const limit = Math.min(req.body.limit || 100, 1000);

    if (!token) {
      res.status(400).json({ error: 'token mint address is required' });
      return;
    }

    // Get recent token activity
    const transfers = await heliusService.getRecentTokenActivity(token, limit);

    if (transfers.length === 0) {
      res.json({
        token,
        transfers: [],
        graph: { nodes: [], edges: [] },
        stats: {
          totalTransfers: 0,
          uniqueWallets: 0,
          totalVolume: '0',
          topSenders: [],
          topReceivers: [],
        },
      });
      return;
    }

    // Build graph from transfers
    const nodes = new Map<string, any>();
    const edges: any[] = [];
    const senderVolume = new Map<string, bigint>();
    const receiverVolume = new Map<string, bigint>();
    // Track transactions per address for showing txIDs in results
    const senderTxs = new Map<string, { signature: string; amount: bigint }[]>();
    const receiverTxs = new Map<string, { signature: string; amount: bigint }[]>();

    // Track address involvement to identify DEX/liquidity pool addresses
    // A liquidity pool is characterized by:
    // 1. Being a counterparty to MANY different unique wallets
    // 2. High transaction volume
    const addressCounterparties = new Map<string, Set<string>>(); // address -> set of unique counterparties
    const addressSwapCount = new Map<string, number>();
    const potentialPoolAddresses = new Set<string>(); // Addresses that might be liquidity pools

    // First pass: analyze transaction patterns
    for (const transfer of transfers) {
      const from = transfer.fromAddress;
      const to = transfer.toAddress;

      if (from && to) {
        // Track unique counterparties for each address
        if (!addressCounterparties.has(from)) {
          addressCounterparties.set(from, new Set());
        }
        addressCounterparties.get(from)!.add(to);

        if (!addressCounterparties.has(to)) {
          addressCounterparties.set(to, new Set());
        }
        addressCounterparties.get(to)!.add(from);

        // Count swap involvement
        if (transfer.txType === 'swap') {
          addressSwapCount.set(from, (addressSwapCount.get(from) || 0) + 1);
          addressSwapCount.set(to, (addressSwapCount.get(to) || 0) + 1);
        }
      }
    }

    // Identify liquidity pools: addresses with many unique counterparties (10+)
    // These are the "hub" nodes that trade with many different wallets
    for (const [address, counterparties] of addressCounterparties.entries()) {
      const uniqueCounterpartyCount = counterparties.size;
      const swapCount = addressSwapCount.get(address) || 0;

      // Liquidity pool criteria:
      // - 10+ unique counterparties (trades with many different wallets)
      // - AND participates in swaps
      if (uniqueCounterpartyCount >= 10 && swapCount >= 5) {
        potentialPoolAddresses.add(address);
      }
    }

    // Determine node type - only mark as DEX if it's clearly a liquidity pool
    const getNodeType = (address: string): string => {
      if (potentialPoolAddresses.has(address)) {
        return 'dex';
      }
      return 'wallet';
    };

    const getNodeName = (address: string): string | undefined => {
      // Could be enhanced to look up known pool names
      return potentialPoolAddresses.has(address) ? 'Liquidity Pool' : undefined;
    };

    for (const transfer of transfers) {
      // Add sender node
      if (transfer.fromAddress && !nodes.has(transfer.fromAddress)) {
        const nodeType = getNodeType(transfer.fromAddress);
        nodes.set(transfer.fromAddress, {
          id: transfer.fromAddress,
          address: transfer.fromAddress,
          type: nodeType,
          name: nodeType === 'dex' ? getNodeName(transfer.fromAddress) : undefined,
        });
      }

      // Add receiver node
      if (transfer.toAddress && !nodes.has(transfer.toAddress)) {
        const nodeType = getNodeType(transfer.toAddress);
        nodes.set(transfer.toAddress, {
          id: transfer.toAddress,
          address: transfer.toAddress,
          type: nodeType,
          name: nodeType === 'dex' ? getNodeName(transfer.toAddress) : undefined,
        });
      }

      // Add edge
      if (transfer.fromAddress && transfer.toAddress) {
        edges.push({
          from: transfer.fromAddress,
          to: transfer.toAddress,
          amount: transfer.amount.toString(),
          signature: transfer.signature,
          timestamp: transfer.blockTime,
          txType: transfer.txType || 'transfer',
          swapDirection: transfer.swapDirection,
          swapInfo: transfer.swapInfo,
        });

        // Track volumes and transactions
        const currentSenderVol = senderVolume.get(transfer.fromAddress) || BigInt(0);
        senderVolume.set(transfer.fromAddress, currentSenderVol + transfer.amount);

        // Track sender transactions
        if (!senderTxs.has(transfer.fromAddress)) {
          senderTxs.set(transfer.fromAddress, []);
        }
        senderTxs.get(transfer.fromAddress)!.push({ signature: transfer.signature, amount: transfer.amount });

        const currentReceiverVol = receiverVolume.get(transfer.toAddress) || BigInt(0);
        receiverVolume.set(transfer.toAddress, currentReceiverVol + transfer.amount);

        // Track receiver transactions
        if (!receiverTxs.has(transfer.toAddress)) {
          receiverTxs.set(transfer.toAddress, []);
        }
        receiverTxs.get(transfer.toAddress)!.push({ signature: transfer.signature, amount: transfer.amount });
      }
    }

    // Calculate total volume and count swaps
    let totalVolume = BigInt(0);
    let swapCount = 0;
    let transferCount = 0;
    for (const transfer of transfers) {
      totalVolume += transfer.amount;
      if (transfer.txType === 'swap') {
        swapCount++;
      } else {
        transferCount++;
      }
    }

    // Get top senders and receivers with their largest transaction
    const topSenders = Array.from(senderVolume.entries())
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .slice(0, 10)
      .map(([address, volume]) => {
        const txs = senderTxs.get(address) || [];
        // Get the largest transaction by amount
        const largestTx = txs.sort((a, b) => (b.amount > a.amount ? 1 : -1))[0];
        return {
          address,
          volume: volume.toString(),
          txSignature: largestTx?.signature,
          txCount: txs.length,
        };
      });

    const topReceivers = Array.from(receiverVolume.entries())
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .slice(0, 10)
      .map(([address, volume]) => {
        const txs = receiverTxs.get(address) || [];
        // Get the largest transaction by amount
        const largestTx = txs.sort((a, b) => (b.amount > a.amount ? 1 : -1))[0];
        return {
          address,
          volume: volume.toString(),
          txSignature: largestTx?.signature,
          txCount: txs.length,
        };
      });

    res.json({
      token,
      transfers: transfers.map(t => ({
        ...t,
        amount: t.amount.toString(),
      })),
      graph: {
        nodes: Array.from(nodes.values()),
        edges,
      },
      stats: {
        totalTransfers: transfers.length,
        swapCount,
        transferCount,
        uniqueWallets: nodes.size,
        totalVolume: totalVolume.toString(),
        topSenders,
        topReceivers,
      },
    });
  }

  async traceTransactions(req: Request, res: Response): Promise<void> {
    const body: TraceRequest = req.body;

    if (!body.signatures || body.signatures.length === 0) {
      res.status(400).json({ error: 'signatures array is required' });
      return;
    }

    const transactions = await Promise.all(
      body.signatures.map(sig => heliusService.getTransaction(sig))
    );

    const validTxs = transactions.filter(tx => tx !== null);

    if (validTxs.length === 0) {
      res.status(404).json({ error: 'No valid transactions found' });
      return;
    }

    const nodes = new Map();
    const edges = [];

    for (const tx of validTxs) {
      if (!tx) continue;

      const transfers = await heliusService.parseTransferInstructions(tx);

      for (const transfer of transfers) {
        if (!nodes.has(transfer.fromAddress)) {
          nodes.set(transfer.fromAddress, {
            id: transfer.fromAddress,
            address: transfer.fromAddress,
          });
        }

        if (!nodes.has(transfer.toAddress)) {
          nodes.set(transfer.toAddress, {
            id: transfer.toAddress,
            address: transfer.toAddress,
          });
        }

        edges.push({
          from: transfer.fromAddress,
          to: transfer.toAddress,
          amount: transfer.amount.toString(),
          tokenMint: transfer.tokenMint,
          signature: transfer.signature,
        });
      }
    }

    const intents = await mlService.predictBatch(validTxs);
    const intentCounts: { [key: string]: number } = {};

    for (const intent of intents) {
      intentCounts[intent.intent] = (intentCounts[intent.intent] || 0) + 1;
    }

    const aggregatedIntent = Object.entries(intentCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
    const totalIntents = Object.values(intentCounts).reduce((sum, count) => sum + count, 0);
    const confidence = totalIntents > 0 ? intentCounts[aggregatedIntent] / totalIntents : 0;

    res.json({
      graph: {
        nodes: Array.from(nodes.values()),
        edges,
      },
      aggregatedIntent,
      confidence,
    });
  }

  private parseTimeRange(timeRangeStr: string): { start: number; end: number } {
    const end = Date.now();
    let start = end;

    const match = timeRangeStr.match(/^(\d+)([dhm])$/);
    if (match) {
      const value = parseInt(match[1]);
      const unit = match[2];

      switch (unit) {
        case 'd':
          start = end - value * 24 * 60 * 60 * 1000;
          break;
        case 'h':
          start = end - value * 60 * 60 * 1000;
          break;
        case 'm':
          start = end - value * 60 * 1000;
          break;
      }
    } else {
      start = end - 30 * 24 * 60 * 60 * 1000;
    }

    return { start, end };
  }
}

export const analysisController = new AnalysisController();
