import { db } from '../utils/database';
import { Entity } from '../types';
import { redis } from '../utils/redis';

export class EntityService {
  private dexPrograms: Set<string>;
  private bridgePrograms: Set<string>;
  private lendingPrograms: Set<string>;
  private entityCache: Map<string, Entity>;

  constructor() {
    this.dexPrograms = new Set([
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpools
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter Aggregator v6
      'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter Aggregator v4
      '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', // Serum DEX v3
      'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', // Serum DEX
    ]);

    this.bridgePrograms = new Set([
      'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth', // Wormhole Token Bridge
      'WnFt12ZrnzZrFZkt2xsNsaNWoQribnuQ5B5FrDbwDhD', // Wormhole NFT Bridge
      'DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe', // Portal Token Bridge (Wormhole)
      'ABpt8JnJdAUtP8Q1x1V3t1FMpPdhx7PXcWJWmVdaALnA', // Allbridge Core
    ]);

    this.lendingPrograms = new Set([
      'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo', // Solend
      'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA', // MarginFi
      'm4ngxxyZ4TZVw1pDU7w9VjKNRdVzB6oT5Zd4J5L7CJ9', // Mango Markets v3
    ]);

    this.entityCache = new Map();
  }

  async loadEntityDatabase(): Promise<void> {
    const result = await db.query<Entity>(
      'SELECT address, entity_type, name, risk_level, risk_score, metadata FROM entities'
    );

    for (const row of result.rows) {
      this.entityCache.set(row.address, row);
    }

    console.log(`Loaded ${this.entityCache.size} entities from database`);
  }

  async identifyEntity(address: string): Promise<Entity | null> {
    const cacheKey = `entity:${address}`;
    const cached = await redis.getJson<Entity>(cacheKey);

    if (cached) {
      return cached;
    }

    if (this.entityCache.has(address)) {
      const entity = this.entityCache.get(address)!;
      await redis.setJson(cacheKey, entity, 3600);
      return entity;
    }

    let entityType: string | undefined;
    let name: string | undefined;

    if (this.dexPrograms.has(address)) {
      entityType = 'dex';
      name = this.getDexName(address);
    } else if (this.bridgePrograms.has(address)) {
      entityType = 'bridge';
      name = this.getBridgeName(address);
    } else if (this.lendingPrograms.has(address)) {
      entityType = 'lending';
      name = this.getLendingName(address);
    }

    if (entityType) {
      const entity: Entity = {
        address,
        entityType,
        name,
        riskLevel: 'low',
        riskScore: 0,
      };

      await this.saveEntity(entity);
      await redis.setJson(cacheKey, entity, 3600);

      return entity;
    }

    return null;
  }

  private getDexName(address: string): string {
    const dexNames: { [key: string]: string } = {
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca',
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter',
      'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB': 'Jupiter',
      '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin': 'Serum',
      'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX': 'Serum',
    };
    return dexNames[address] || 'Unknown DEX';
  }

  private getBridgeName(address: string): string {
    const bridgeNames: { [key: string]: string } = {
      'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth': 'Wormhole',
      'WnFt12ZrnzZrFZkt2xsNsaNWoQribnuQ5B5FrDbwDhD': 'Wormhole NFT',
      'DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe': 'Portal',
      'ABpt8JnJdAUtP8Q1x1V3t1FMpPdhx7PXcWJWmVdaALnA': 'Allbridge',
    };
    return bridgeNames[address] || 'Unknown Bridge';
  }

  private getLendingName(address: string): string {
    const lendingNames: { [key: string]: string } = {
      'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo': 'Solend',
      'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA': 'MarginFi',
      'm4ngxxyZ4TZVw1pDU7w9VjKNRdVzB6oT5Zd4J5L7CJ9': 'Mango',
    };
    return lendingNames[address] || 'Unknown Lending';
  }

  async saveEntity(entity: Entity): Promise<void> {
    await db.query(
      `INSERT INTO entities (address, entity_type, name, risk_level, risk_score, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (address) DO UPDATE
       SET entity_type = $2, name = $3, risk_level = $4, risk_score = $5, metadata = $6, last_updated = NOW()`,
      [
        entity.address,
        entity.entityType,
        entity.name,
        entity.riskLevel,
        entity.riskScore,
        JSON.stringify(entity.metadata || {}),
      ]
    );

    this.entityCache.set(entity.address, entity);
  }

  async flagEntityAsRisky(
    address: string,
    riskLevel: string,
    riskScore: number,
    reason: string
  ): Promise<void> {
    await db.query(
      `UPDATE entities SET risk_level = $1, risk_score = $2, metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{risk_reason}',
         $3::jsonb
       )
       WHERE address = $4`,
      [riskLevel, riskScore, JSON.stringify(reason), address]
    );

    await redis.del(`entity:${address}`);
  }

  async getEntity(address: string): Promise<Entity | null> {
    return this.identifyEntity(address);
  }
}

export const entityService = new EntityService();
