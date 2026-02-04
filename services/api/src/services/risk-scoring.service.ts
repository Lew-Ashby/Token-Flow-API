import { db } from '../utils/database';
import { redis } from '../utils/redis';
import { RiskAssessment, RiskFlag } from '../types';
import { flowBuilderService } from './flow-builder.service';

export class RiskScoringService {
  private mixerAddresses: Set<string>;
  private sanctionedAddresses: Set<string>;

  constructor() {
    this.mixerAddresses = new Set();
    this.sanctionedAddresses = new Set();
  }

  async loadRiskDatabases(): Promise<void> {
    const mixers = await db.query<{ address: string }>(
      `SELECT address FROM entities WHERE entity_type = 'mixer'`
    );

    for (const row of mixers.rows) {
      this.mixerAddresses.add(row.address);
    }

    const sanctioned = await db.query<{ address: string }>(
      `SELECT address FROM entities WHERE entity_type = 'sanctioned'`
    );

    for (const row of sanctioned.rows) {
      this.sanctionedAddresses.add(row.address);
    }

    console.log(`Loaded ${this.mixerAddresses.size} mixer addresses`);
    console.log(`Loaded ${this.sanctionedAddresses.size} sanctioned addresses`);
  }

  async assessRisk(address: string, tokenMint: string): Promise<RiskAssessment> {
    const cacheKey = `risk:${address}:${tokenMint}`;
    const cached = await redis.getJson<RiskAssessment>(cacheKey);

    if (cached) {
      return cached;
    }

    const flags: RiskFlag[] = [];
    let score = 0;

    const mixerProximity = await this.checkMixerProximity(address, tokenMint);
    if (mixerProximity.within2Hops) {
      flags.push({
        type: 'mixer_proximity',
        severity: 'critical',
        details: mixerProximity,
      });
      score += 40;
    }

    const velocity = await this.checkVelocity(address, tokenMint);
    if (velocity.transfersPerHour > 100) {
      flags.push({
        type: 'high_velocity',
        severity: 'warning',
        details: velocity,
      });
      score += 20;
    }

    const circular = await flowBuilderService.detectCircularFlows(address, tokenMint);
    if (circular.length > 0) {
      flags.push({
        type: 'circular_flow',
        severity: 'warning',
        details: { flows: circular },
      });
      score += 25;
    }

    const peelChain = await this.detectPeelChain(address, tokenMint);
    if (peelChain.detected) {
      flags.push({
        type: 'peel_chain',
        severity: 'critical',
        details: peelChain,
      });
      score += 35;
    }

    const sanctioned = await this.checkSanctionedProximity(address, tokenMint);
    if (sanctioned.direct) {
      flags.push({
        type: 'sanctioned_direct',
        severity: 'critical',
        details: sanctioned,
      });
      score = 100;
    } else if (sanctioned.within2Hops) {
      flags.push({
        type: 'sanctioned_proximity',
        severity: 'critical',
        details: sanctioned,
      });
      score += 50;
    }

    const riskLevel = this.scoreToLevel(score);

    const assessment: RiskAssessment = {
      address,
      riskScore: Math.min(score, 100),
      riskLevel,
      flags,
      lastAssessed: new Date(),
    };

    await this.saveRiskAssessment(assessment);
    await redis.setJson(cacheKey, assessment, 600);

    return assessment;
  }

  private async checkMixerProximity(
    address: string,
    tokenMint: string
  ): Promise<any> {
    const visited = new Set<string>();
    const mixersFound: { address: string; hops: number }[] = [];

    const bfs = async (currentAddr: string, depth: number) => {
      if (depth > 2 || visited.has(currentAddr)) return;
      visited.add(currentAddr);

      if (this.mixerAddresses.has(currentAddr)) {
        mixersFound.push({ address: currentAddr, hops: depth });
        return;
      }

      const transfers = await db.query(
        `SELECT DISTINCT to_address FROM transfers
         WHERE from_address = $1 AND token_mint = $2
         LIMIT 10`,
        [currentAddr, tokenMint]
      );

      for (const row of transfers.rows) {
        await bfs(row.to_address, depth + 1);
      }
    };

    await bfs(address, 0);

    return {
      within2Hops: mixersFound.length > 0,
      mixersFound,
      totalChecked: visited.size,
    };
  }

  private async checkVelocity(address: string, tokenMint: string): Promise<any> {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

    const result = await db.query(
      `SELECT COUNT(*) as count FROM transfers
       WHERE from_address = $1 AND token_mint = $2
       AND EXISTS (
         SELECT 1 FROM transactions
         WHERE transactions.signature = transfers.signature
         AND transactions.block_time >= $3
       )`,
      [address, tokenMint, oneHourAgo]
    );

    const transfersPerHour = parseInt(result.rows[0]?.count || '0');

    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
    const dayResult = await db.query(
      `SELECT COUNT(*) as count FROM transfers
       WHERE from_address = $1 AND token_mint = $2
       AND EXISTS (
         SELECT 1 FROM transactions
         WHERE transactions.signature = transfers.signature
         AND transactions.block_time >= $3
       )`,
      [address, tokenMint, oneDayAgo]
    );

    const transfersPerDay = parseInt(dayResult.rows[0]?.count || '0');

    return {
      transfersPerHour,
      transfersPerDay,
      avgPerHour: transfersPerDay / 24,
    };
  }

  private async detectPeelChain(address: string, tokenMint: string): Promise<any> {
    const transfers = await db.query(
      `SELECT t.*, tx.block_time
       FROM transfers t
       JOIN transactions tx ON t.signature = tx.signature
       WHERE t.from_address = $1 AND t.token_mint = $2
       ORDER BY tx.block_time DESC
       LIMIT 20`,
      [address, tokenMint]
    );

    if (transfers.rows.length < 3) {
      return { detected: false };
    }

    const peelPattern: any[] = [];
    let consecutivePeels = 0;

    for (let i = 0; i < transfers.rows.length - 1; i++) {
      const current = transfers.rows[i];
      const next = transfers.rows[i + 1];

      const currentAmount = BigInt(current.amount);
      const nextAmount = BigInt(next.amount);

      if (nextAmount === BigInt(0) || currentAmount === BigInt(0)) continue;

      const ratio = Number((currentAmount * BigInt(100)) / nextAmount) / 100;

      if (ratio >= 0.85 && ratio <= 0.95) {
        consecutivePeels++;
        peelPattern.push({
          from: current.to_address,
          amount: current.amount.toString(),
          ratio,
        });

        if (consecutivePeels >= 3) {
          return {
            detected: true,
            chainLength: consecutivePeels,
            pattern: peelPattern,
          };
        }
      } else {
        consecutivePeels = 0;
        peelPattern.length = 0;
      }
    }

    return { detected: false };
  }

  private async checkSanctionedProximity(
    address: string,
    tokenMint: string
  ): Promise<any> {
    if (this.sanctionedAddresses.has(address)) {
      return {
        direct: true,
        within2Hops: true,
        sanctionedAddress: address,
      };
    }

    const visited = new Set<string>();
    const sanctionedFound: { address: string; hops: number }[] = [];

    const bfs = async (currentAddr: string, depth: number) => {
      if (depth > 2 || visited.has(currentAddr)) return;
      visited.add(currentAddr);

      if (this.sanctionedAddresses.has(currentAddr)) {
        sanctionedFound.push({ address: currentAddr, hops: depth });
        return;
      }

      const transfers = await db.query(
        `SELECT DISTINCT to_address FROM transfers
         WHERE from_address = $1 AND token_mint = $2
         LIMIT 10`,
        [currentAddr, tokenMint]
      );

      for (const row of transfers.rows) {
        await bfs(row.to_address, depth + 1);
      }
    };

    await bfs(address, 0);

    return {
      direct: false,
      within2Hops: sanctionedFound.length > 0,
      sanctionedFound,
    };
  }

  private scoreToLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score >= 75) return 'critical';
    if (score >= 50) return 'high';
    if (score >= 25) return 'medium';
    return 'low';
  }

  private async saveRiskAssessment(assessment: RiskAssessment): Promise<void> {
    await db.query(
      `UPDATE entities SET risk_level = $1, risk_score = $2, last_updated = NOW()
       WHERE address = $3`,
      [assessment.riskLevel, assessment.riskScore, assessment.address]
    );

    for (const flag of assessment.flags) {
      await db.query(
        `INSERT INTO risk_flags (address, flag_type, severity, details)
         VALUES ($1, $2, $3, $4)`,
        [assessment.address, flag.type, flag.severity, JSON.stringify(flag.details)]
      );
    }
  }
}

export const riskScoringService = new RiskScoringService();
