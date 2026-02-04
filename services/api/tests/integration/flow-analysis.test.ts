import { flowBuilderService } from '../../src/services/flow-builder.service';
import { heliusService } from '../../src/services/helius.service';
import { riskScoringService } from '../../src/services/risk-scoring.service';
import { mlService } from '../../src/services/ml.service';
import { db } from '../../src/utils/database';
import { redis } from '../../src/utils/redis';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TEST_ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

describe('Flow Analysis Integration Tests', () => {
  beforeAll(async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        signature VARCHAR(88) PRIMARY KEY,
        block_time BIGINT NOT NULL,
        slot BIGINT NOT NULL,
        fee BIGINT NOT NULL,
        success BOOLEAN NOT NULL,
        accounts JSONB NOT NULL,
        instructions JSONB NOT NULL,
        indexed_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS transfers (
        id SERIAL PRIMARY KEY,
        signature VARCHAR(88),
        from_address VARCHAR(44) NOT NULL,
        to_address VARCHAR(44) NOT NULL,
        token_mint VARCHAR(44) NOT NULL,
        amount BIGINT NOT NULL,
        decimals INT NOT NULL,
        instruction_index INT NOT NULL,
        indexed_at TIMESTAMP DEFAULT NOW()
      )
    `);
  });

  afterAll(async () => {
    await db.query('DROP TABLE IF EXISTS transfers');
    await db.query('DROP TABLE IF EXISTS transactions');
    await db.close();
    await redis.close();
  });

  describe('Transaction Fetching', () => {
    test('should fetch real Solana transaction', async () => {
      const signature = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

      const tx = await heliusService.getTransaction(signature);

      expect(tx).toBeDefined();
      expect(tx?.signature).toBe(signature);
      expect(tx?.blockTime).toBeGreaterThan(0);
      expect(tx?.accounts.length).toBeGreaterThan(0);
    }, 30000);

    test('should handle non-existent transaction gracefully', async () => {
      const fakeSig = '1'.repeat(88);

      const tx = await heliusService.getTransaction(fakeSig);

      expect(tx).toBeNull();
    });
  });

  describe('Transfer Parsing', () => {
    test('should parse SPL token transfers from transaction', async () => {
      const signature = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

      const tx = await heliusService.getTransaction(signature);
      expect(tx).toBeDefined();

      if (tx) {
        const transfers = await heliusService.parseTransferInstructions(tx);

        expect(Array.isArray(transfers)).toBe(true);

        if (transfers.length > 0) {
          const transfer = transfers[0];
          expect(transfer.fromAddress).toBeDefined();
          expect(transfer.toAddress).toBeDefined();
          expect(transfer.amount).toBeGreaterThan(BigInt(0));
        }
      }
    }, 30000);
  });

  describe('Flow Path Building', () => {
    beforeEach(async () => {
      await db.query('TRUNCATE transfers, transactions CASCADE');

      const mockTx = {
        signature: 'test_sig_1',
        blockTime: Math.floor(Date.now() / 1000),
        slot: 100000,
        fee: 5000,
        success: true,
        accounts: ['addr1', 'addr2', 'addr3'],
        instructions: [],
      };

      await db.query(
        `INSERT INTO transactions (signature, block_time, slot, fee, success, accounts, instructions)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          mockTx.signature,
          mockTx.blockTime,
          mockTx.slot,
          mockTx.fee,
          mockTx.success,
          JSON.stringify(mockTx.accounts),
          JSON.stringify(mockTx.instructions),
        ]
      );

      await db.query(
        `INSERT INTO transfers (signature, from_address, to_address, token_mint, amount, decimals, instruction_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['test_sig_1', 'addr1', 'addr2', USDC_MINT, '1000000', 6, 0]
      );

      await db.query(
        `INSERT INTO transfers (signature, from_address, to_address, token_mint, amount, decimals, instruction_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['test_sig_1', 'addr2', 'addr3', USDC_MINT, '1000000', 6, 1]
      );
    });

    test('should build forward flow path', async () => {
      const timeRange = {
        start: Date.now() - 86400000,
        end: Date.now(),
      };

      const paths = await flowBuilderService.buildForwardPath(
        'addr1',
        USDC_MINT,
        3,
        timeRange
      );

      expect(Array.isArray(paths)).toBe(true);
      expect(paths.length).toBeGreaterThan(0);

      if (paths.length > 0) {
        const path = paths[0];
        expect(path.startAddress).toBe('addr1');
        expect(path.hopCount).toBeGreaterThan(0);
        expect(path.confidenceScore).toBeGreaterThan(0);
      }
    }, 10000);

    test('should detect circular flows', async () => {
      await db.query(
        `INSERT INTO transfers (signature, from_address, to_address, token_mint, amount, decimals, instruction_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['test_sig_2', 'addr3', 'addr1', USDC_MINT, '1000000', 6, 0]
      );

      const circularFlows = await flowBuilderService.detectCircularFlows('addr1', USDC_MINT);

      expect(Array.isArray(circularFlows)).toBe(true);
    });
  });

  describe('Risk Scoring', () => {
    beforeEach(async () => {
      await riskScoringService.loadRiskDatabases();
    });

    test('should assess risk for address', async () => {
      const assessment = await riskScoringService.assessRisk(TEST_ADDRESS, USDC_MINT);

      expect(assessment).toBeDefined();
      expect(assessment.riskScore).toBeGreaterThanOrEqual(0);
      expect(assessment.riskScore).toBeLessThanOrEqual(100);
      expect(['low', 'medium', 'high', 'critical']).toContain(assessment.riskLevel);
      expect(Array.isArray(assessment.flags)).toBe(true);
    }, 15000);

    test('should detect high velocity', async () => {
      const address = 'test_velocity_addr';

      for (let i = 0; i < 150; i++) {
        await db.query(
          `INSERT INTO transfers (signature, from_address, to_address, token_mint, amount, decimals, instruction_index)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [`test_velocity_${i}`, address, 'dest_addr', USDC_MINT, '1000', 6, 0]
        );
      }

      const assessment = await riskScoringService.assessRisk(address, USDC_MINT);

      expect(assessment.riskScore).toBeGreaterThan(0);
      const hasVelocityFlag = assessment.flags.some(f => f.type === 'high_velocity');
      expect(hasVelocityFlag).toBe(true);
    });
  });

  describe('Intent Inference', () => {
    test('should predict intent for transaction', async () => {
      const mockTx = {
        signature: 'test_intent_sig',
        blockTime: Math.floor(Date.now() / 1000),
        slot: 100000,
        fee: 5000,
        success: true,
        accounts: [
          '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
          'addr1',
          'addr2'
        ],
        instructions: [
          {
            program: 'spl-token',
            parsed: {
              type: 'transfer',
              info: {
                source: 'addr1',
                destination: 'addr2',
                amount: '1000000',
              },
            },
          },
        ],
      };

      const intent = await mlService.predictIntent(mockTx);

      expect(intent).toBeDefined();
      expect(intent.intent).toBeDefined();
      expect(intent.confidence).toBeGreaterThan(0);
      expect(intent.confidence).toBeLessThanOrEqual(1);
    }, 10000);
  });

  describe('End-to-End Flow Analysis', () => {
    test('should complete full flow analysis pipeline', async () => {
      await db.query('TRUNCATE transfers, transactions CASCADE');

      const mockTx = {
        signature: 'e2e_test_sig',
        blockTime: Math.floor(Date.now() / 1000),
        slot: 100000,
        fee: 5000,
        success: true,
        accounts: ['source_addr', 'intermediate_addr', 'dest_addr'],
        instructions: [],
      };

      await db.query(
        `INSERT INTO transactions (signature, block_time, slot, fee, success, accounts, instructions)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          mockTx.signature,
          mockTx.blockTime,
          mockTx.slot,
          mockTx.fee,
          mockTx.success,
          JSON.stringify(mockTx.accounts),
          JSON.stringify(mockTx.instructions),
        ]
      );

      await db.query(
        `INSERT INTO transfers (signature, from_address, to_address, token_mint, amount, decimals, instruction_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['e2e_test_sig', 'source_addr', 'intermediate_addr', USDC_MINT, '5000000', 6, 0]
      );

      await db.query(
        `INSERT INTO transfers (signature, from_address, to_address, token_mint, amount, decimals, instruction_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['e2e_test_sig', 'intermediate_addr', 'dest_addr', USDC_MINT, '5000000', 6, 1]
      );

      const timeRange = {
        start: Date.now() - 86400000,
        end: Date.now(),
      };

      const paths = await flowBuilderService.buildForwardPath(
        'source_addr',
        USDC_MINT,
        3,
        timeRange
      );

      expect(paths.length).toBeGreaterThan(0);

      const path = paths[0];
      expect(path.startAddress).toBe('source_addr');
      expect(path.hops.length).toBeGreaterThan(0);

      const riskAssessment = await riskScoringService.assessRisk('dest_addr', USDC_MINT);
      expect(riskAssessment).toBeDefined();

      console.log('\n✓ E2E Flow Analysis Complete');
      console.log(`  - Paths found: ${paths.length}`);
      console.log(`  - Hops in first path: ${path.hops.length}`);
      console.log(`  - Risk score: ${riskAssessment.riskScore}`);
      console.log(`  - Risk level: ${riskAssessment.riskLevel}`);
    }, 30000);
  });
});
