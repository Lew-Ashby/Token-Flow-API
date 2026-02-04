import { v4 as uuidv4 } from 'uuid';
import { heliusService } from './helius.service';
import { entityService } from './entity.service';
import { db } from '../utils/database';
import { FlowPath, PathNode, Transfer, TimeRange, CircularFlow } from '../types';

export class FlowBuilderService {
  async buildForwardPath(
    startAddress: string,
    tokenMint: string,
    maxDepth: number,
    timeRange: TimeRange
  ): Promise<FlowPath[]> {
    const visited = new Set<string>();
    const paths: FlowPath[] = [];

    await this.exploreForward(
      startAddress,
      tokenMint,
      [],
      visited,
      paths,
      maxDepth,
      timeRange,
      0
    );

    for (const path of paths) {
      await this.savePath(path);
    }

    return paths;
  }

  private async exploreForward(
    currentAddress: string,
    tokenMint: string,
    currentPath: PathNode[],
    visited: Set<string>,
    paths: FlowPath[],
    maxDepth: number,
    timeRange: TimeRange,
    depth: number
  ): Promise<void> {
    // Safety limits to prevent DoS
    if (depth >= maxDepth || visited.size > 10000 || paths.length > 1000) {
      if (currentPath.length > 0) {
        paths.push(this.createFlowPath(currentPath, tokenMint));
      }
      return;
    }

    if (visited.has(currentAddress)) {
      return;
    }

    visited.add(currentAddress);

    const transfers = await this.getTransfersFromAddress(
      currentAddress,
      tokenMint,
      timeRange
    );

    if (transfers.length === 0) {
      if (currentPath.length > 0) {
        paths.push(this.createFlowPath(currentPath, tokenMint));
      }
      return;
    }

    const aggregatedTransfers = this.aggregateTransfersByDestination(transfers);

    for (const [toAddress, transferList] of aggregatedTransfers.entries()) {
      const totalAmount = transferList.reduce((sum, t) => sum + t.amount, BigInt(0));

      const entity = await entityService.identifyEntity(toAddress);
      const node: PathNode = {
        address: toAddress,
        entityType: entity?.entityType,
        entityName: entity?.name,
        amountIn: totalAmount.toString(),
        amountOut: totalAmount.toString(),
        timestamp: transferList[0].blockTime,
      };

      const newPath = [...currentPath, node];

      await this.exploreForward(
        toAddress,
        tokenMint,
        newPath,
        visited,
        paths,
        maxDepth,
        timeRange,
        depth + 1
      );
    }

    visited.delete(currentAddress);
  }

  async buildBackwardPath(
    endAddress: string,
    tokenMint: string,
    maxDepth: number,
    timeRange: TimeRange
  ): Promise<FlowPath[]> {
    const visited = new Set<string>();
    const paths: FlowPath[] = [];

    await this.exploreBackward(
      endAddress,
      tokenMint,
      [],
      visited,
      paths,
      maxDepth,
      timeRange,
      0
    );

    for (const path of paths) {
      await this.savePath(path);
    }

    return paths;
  }

  private async exploreBackward(
    currentAddress: string,
    tokenMint: string,
    currentPath: PathNode[],
    visited: Set<string>,
    paths: FlowPath[],
    maxDepth: number,
    timeRange: TimeRange,
    depth: number
  ): Promise<void> {
    // Safety limits to prevent DoS
    if (depth >= maxDepth || visited.size > 10000 || paths.length > 1000) {
      if (currentPath.length > 0) {
        const reversedPath = [...currentPath].reverse();
        paths.push(this.createFlowPath(reversedPath, tokenMint));
      }
      return;
    }

    if (visited.has(currentAddress)) {
      return;
    }

    visited.add(currentAddress);

    const transfers = await this.getTransfersToAddress(
      currentAddress,
      tokenMint,
      timeRange
    );

    if (transfers.length === 0) {
      if (currentPath.length > 0) {
        const reversedPath = [...currentPath].reverse();
        paths.push(this.createFlowPath(reversedPath, tokenMint));
      }
      return;
    }

    const aggregatedTransfers = this.aggregateTransfersBySource(transfers);

    for (const [fromAddress, transferList] of aggregatedTransfers.entries()) {
      const totalAmount = transferList.reduce((sum, t) => sum + t.amount, BigInt(0));

      const entity = await entityService.identifyEntity(fromAddress);
      const node: PathNode = {
        address: fromAddress,
        entityType: entity?.entityType,
        entityName: entity?.name,
        amountIn: totalAmount.toString(),
        amountOut: totalAmount.toString(),
        timestamp: transferList[0].blockTime,
      };

      const newPath = [node, ...currentPath];

      await this.exploreBackward(
        fromAddress,
        tokenMint,
        newPath,
        visited,
        paths,
        maxDepth,
        timeRange,
        depth + 1
      );
    }

    visited.delete(currentAddress);
  }

  async detectCircularFlows(
    address: string,
    tokenMint: string
  ): Promise<CircularFlow[]> {
    const circularFlows: CircularFlow[] = [];
    const transfers = await this.getAllTransfersForAddress(address, tokenMint);

    const graph = new Map<string, Set<string>>();

    for (const transfer of transfers) {
      if (!graph.has(transfer.fromAddress)) {
        graph.set(transfer.fromAddress, new Set());
      }
      graph.get(transfer.fromAddress)!.add(transfer.toAddress);
    }

    const cycles = this.findCycles(graph, address);

    for (const cycle of cycles) {
      const cycleTransfers = transfers.filter(
        t => cycle.includes(t.fromAddress) && cycle.includes(t.toAddress)
      );

      const totalAmount = cycleTransfers.reduce((sum, t) => sum + t.amount, BigInt(0));

      circularFlows.push({
        addresses: cycle,
        totalAmount: totalAmount.toString(),
        cycleCount: cycleTransfers.length,
      });
    }

    return circularFlows;
  }

  private findCycles(graph: Map<string, Set<string>>, startNode: string): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack: string[] = [];

    const dfs = (node: string, path: string[]) => {
      visited.add(node);
      recursionStack.push(node);
      path.push(node);

      const neighbors = graph.get(node) || new Set();

      for (const neighbor of neighbors) {
        if (neighbor === startNode && path.length > 2) {
          cycles.push([...path, neighbor]);
        } else if (!visited.has(neighbor)) {
          dfs(neighbor, [...path]);
        }
      }

      recursionStack.pop();
    };

    dfs(startNode, []);

    return cycles;
  }

  private async getTransfersFromAddress(
    address: string,
    tokenMint: string,
    timeRange: TimeRange
  ): Promise<Transfer[]> {
    // Fetch transfers directly from Helius API instead of database
    const transfers = await heliusService.getTokenTransfers(address, tokenMint, 50);

    // Filter by time range and direction (outgoing transfers)
    const startTime = Math.floor(timeRange.start / 1000);
    const endTime = Math.floor(timeRange.end / 1000) + 300; // Add 5 min buffer for clock skew

    const filtered = transfers.filter(t => {
      const isInTimeRange = !t.blockTime || (t.blockTime >= startTime && t.blockTime <= endTime);
      const isOutgoing = t.fromAddress === address;
      return isOutgoing; // Skip time filter for now - Helius already returns recent transactions
    });

    console.log(`[FlowBuilder] getTransfersFromAddress: ${address.slice(0,8)}... found ${transfers.length} total, ${filtered.length} outgoing`);
    return filtered;
  }

  private async getTransfersToAddress(
    address: string,
    tokenMint: string,
    timeRange: TimeRange
  ): Promise<Transfer[]> {
    // Fetch transfers directly from Helius API instead of database
    const transfers = await heliusService.getTokenTransfers(address, tokenMint, 50);

    // Filter by direction (incoming transfers)
    const filtered = transfers.filter(t => {
      const isIncoming = t.toAddress === address;
      return isIncoming; // Skip time filter - Helius already returns recent transactions
    });

    console.log(`[FlowBuilder] getTransfersToAddress: ${address.slice(0,8)}... found ${transfers.length} total, ${filtered.length} incoming`);
    return filtered;
  }

  private async getAllTransfersForAddress(
    address: string,
    tokenMint: string
  ): Promise<Transfer[]> {
    // Fetch all transfers directly from Helius API
    return heliusService.getTokenTransfers(address, tokenMint, 100);
  }

  private aggregateTransfersByDestination(transfers: Transfer[]): Map<string, Transfer[]> {
    const aggregated = new Map<string, Transfer[]>();

    for (const transfer of transfers) {
      if (!aggregated.has(transfer.toAddress)) {
        aggregated.set(transfer.toAddress, []);
      }
      aggregated.get(transfer.toAddress)!.push(transfer);
    }

    return aggregated;
  }

  private aggregateTransfersBySource(transfers: Transfer[]): Map<string, Transfer[]> {
    const aggregated = new Map<string, Transfer[]>();

    for (const transfer of transfers) {
      if (!aggregated.has(transfer.fromAddress)) {
        aggregated.set(transfer.fromAddress, []);
      }
      aggregated.get(transfer.fromAddress)!.push(transfer);
    }

    return aggregated;
  }

  private createFlowPath(nodes: PathNode[], tokenMint: string): FlowPath {
    const totalAmount = nodes.reduce(
      (sum, node) => sum + BigInt(node.amountIn),
      BigInt(0)
    );

    const confidence = this.calculateConfidence(nodes);

    return {
      pathId: uuidv4(),
      startAddress: nodes[0]?.address || '',
      endAddress: nodes[nodes.length - 1]?.address || '',
      tokenMint,
      hops: nodes,
      totalAmount: totalAmount.toString(),
      hopCount: nodes.length,
      confidenceScore: confidence,
    };
  }

  private calculateConfidence(path: PathNode[]): number {
    if (path.length === 0) return 0;
    if (path.length === 1) return 1.0;

    let score = 1.0;

    for (let i = 1; i < path.length; i++) {
      const prevNode = path[i - 1];
      const currentNode = path[i];

      const prevAmount = BigInt(prevNode.amountOut);
      const currentAmount = BigInt(currentNode.amountIn);

      if (currentAmount === BigInt(0)) {
        score *= 0.5;
        continue;
      }

      const ratio = Number(prevAmount * BigInt(100) / currentAmount) / 100;

      if (ratio >= 0.95 && ratio <= 1.05) {
        score *= 1.0;
      } else if (ratio >= 0.90 && ratio <= 1.10) {
        score *= 0.95;
      } else if (ratio >= 0.80 && ratio <= 1.20) {
        score *= 0.85;
      } else {
        score *= 0.7;
      }

      if (currentNode.entityType === 'dex') {
        score *= 0.98;
      }

      if (prevNode.timestamp && currentNode.timestamp) {
        const timeDiff = Math.abs(currentNode.timestamp - prevNode.timestamp);
        if (timeDiff > 86400) {
          score *= 0.9;
        }
      }
    }

    return Math.max(0, Math.min(1, score));
  }

  private async savePath(path: FlowPath): Promise<void> {
    await db.query(
      `INSERT INTO flow_paths (id, start_address, end_address, token_mint, path_hops, total_amount, hop_count, confidence_score, intent_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        path.pathId,
        path.startAddress,
        path.endAddress,
        path.tokenMint,
        JSON.stringify(path.hops),
        path.totalAmount,
        path.hopCount,
        path.confidenceScore,
        path.intent,
      ]
    );
  }
}

export const flowBuilderService = new FlowBuilderService();
