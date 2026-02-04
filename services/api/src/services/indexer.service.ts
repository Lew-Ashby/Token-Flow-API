import { heliusService } from './helius.service';
import { entityService } from './entity.service';
import { db } from '../utils/database';
import { redis } from '../utils/redis';
import { ParsedTransaction, Transfer } from '../types';

interface IndexerState {
  lastProcessedSlot: number;
  lastProcessedSignature: string;
  isRunning: boolean;
}

export class TransactionIndexerService {
  private state: IndexerState;
  private batchSize: number = 100;
  private confirmationLevel: 'finalized' | 'confirmed' = 'finalized';

  constructor() {
    this.state = {
      lastProcessedSlot: 0,
      lastProcessedSignature: '',
      isRunning: false,
    };
  }

  async initialize(): Promise<void> {
    const savedState = await redis.getJson<IndexerState>('indexer:state');
    if (savedState) {
      this.state = savedState;
      console.log(`Indexer state restored: slot=${this.state.lastProcessedSlot}`);
    }
  }

  async startIndexing(address: string, tokenMint: string): Promise<void> {
    if (this.state.isRunning) {
      console.log('Indexer already running');
      return;
    }

    this.state.isRunning = true;
    console.log(`Starting indexer for address=${address}, token=${tokenMint}`);

    try {
      await this.indexHistoricalTransactions(address, tokenMint);
    } catch (error) {
      console.error('Indexing error:', error);
      this.state.isRunning = false;
      throw error;
    }
  }

  private async indexHistoricalTransactions(
    address: string,
    tokenMint: string
  ): Promise<void> {
    let before: string | undefined = undefined;
    let processedCount = 0;

    while (this.state.isRunning) {
      const transactions = await heliusService.getAddressTransactions(address, {
        limit: this.batchSize,
        before,
      });

      if (transactions.length === 0) {
        console.log(`Indexing complete. Processed ${processedCount} transactions`);
        break;
      }

      for (const tx of transactions) {
        await this.processTransaction(tx, tokenMint);
        processedCount++;

        if (tx.slot > this.state.lastProcessedSlot) {
          this.state.lastProcessedSlot = tx.slot;
          this.state.lastProcessedSignature = tx.signature;
        }
      }

      before = transactions[transactions.length - 1].signature;

      await this.saveState();

      if (processedCount % 100 === 0) {
        console.log(`Indexed ${processedCount} transactions, slot=${this.state.lastProcessedSlot}`);
      }

      await this.sleep(100);
    }

    this.state.isRunning = false;
  }

  async processTransaction(tx: ParsedTransaction, tokenMint?: string): Promise<void> {
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      const existingTx = await client.query(
        'SELECT signature FROM transactions WHERE signature = $1',
        [tx.signature]
      );

      if (existingTx.rows.length > 0) {
        await client.query('ROLLBACK');
        return;
      }

      await client.query(
        `INSERT INTO transactions (signature, block_time, slot, fee, success, accounts, instructions)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tx.signature,
          tx.blockTime,
          tx.slot,
          tx.fee,
          tx.success,
          JSON.stringify(tx.accounts),
          JSON.stringify(tx.instructions),
        ]
      );

      const transfers = await heliusService.parseTransferInstructions(tx, tokenMint);

      for (const transfer of transfers) {
        await this.indexTransfer(client, transfer);
      }

      await client.query('COMMIT');

      await this.updateEntityCache(transfers);

    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Failed to process transaction ${tx.signature}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  private async indexTransfer(client: any, transfer: Transfer): Promise<void> {
    await client.query(
      `INSERT INTO transfers (signature, from_address, to_address, token_mint, amount, decimals, instruction_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        transfer.signature,
        transfer.fromAddress,
        transfer.toAddress,
        transfer.tokenMint,
        transfer.amount.toString(),
        transfer.decimals,
        transfer.instructionIndex,
      ]
    );
  }

  private async updateEntityCache(transfers: Transfer[]): Promise<void> {
    const addresses = new Set<string>();

    for (const transfer of transfers) {
      addresses.add(transfer.fromAddress);
      addresses.add(transfer.toAddress);
    }

    for (const address of addresses) {
      const entity = await entityService.identifyEntity(address);
      if (entity) {
        await redis.setJson(`entity:${address}`, entity, 3600);
      }
    }
  }

  async handleReorg(fromSlot: number, toSlot: number): Promise<void> {
    console.log(`Reorg detected: rolling back from slot ${fromSlot} to ${toSlot}`);

    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      await client.query(
        'DELETE FROM transfers WHERE signature IN (SELECT signature FROM transactions WHERE slot > $1)',
        [toSlot]
      );

      await client.query(
        'DELETE FROM transactions WHERE slot > $1',
        [toSlot]
      );

      await client.query('COMMIT');

      this.state.lastProcessedSlot = toSlot;
      await this.saveState();

      console.log(`Reorg handled: rolled back to slot ${toSlot}`);

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Reorg handling failed:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getIndexerStats(): Promise<any> {
    const txCount = await db.query('SELECT COUNT(*) as count FROM transactions');
    const transferCount = await db.query('SELECT COUNT(*) as count FROM transfers');

    const latestTx = await db.query(
      'SELECT slot, block_time FROM transactions ORDER BY slot DESC LIMIT 1'
    );

    return {
      totalTransactions: parseInt(txCount.rows[0]?.count || '0'),
      totalTransfers: parseInt(transferCount.rows[0]?.count || '0'),
      lastProcessedSlot: this.state.lastProcessedSlot,
      latestSlot: latestTx.rows[0]?.slot || 0,
      latestBlockTime: latestTx.rows[0]?.block_time || 0,
      isRunning: this.state.isRunning,
    };
  }

  private async saveState(): Promise<void> {
    await redis.setJson('indexer:state', this.state, 0);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  stop(): void {
    console.log('Stopping indexer...');
    this.state.isRunning = false;
  }
}

export const indexerService = new TransactionIndexerService();
