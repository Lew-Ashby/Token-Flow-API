import axios from 'axios';
import { ParsedTransaction } from '../types';
import { redis } from '../utils/redis';

export interface MLIntentPrediction {
  intent: string;
  confidence: number;
}

export class MLService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.ML_SERVICE_URL || 'http://localhost:8001';
  }

  async predictIntent(transaction: ParsedTransaction): Promise<MLIntentPrediction> {
    const cacheKey = `intent:${transaction.signature}`;
    const cached = await redis.getJson<MLIntentPrediction>(cacheKey);

    if (cached) {
      return cached;
    }

    const response = await axios.post(`${this.baseUrl}/predict`, {
      signature: transaction.signature,
      instructions: transaction.instructions,
      accounts: transaction.accounts,
      fee: transaction.fee,
    });

    const prediction: MLIntentPrediction = {
      intent: response.data.intent,
      confidence: response.data.confidence,
    };

    await redis.setJson(cacheKey, prediction, 3600);

    return prediction;
  }

  async predictBatch(transactions: ParsedTransaction[]): Promise<MLIntentPrediction[]> {
    const predictions: MLIntentPrediction[] = [];

    for (const tx of transactions) {
      try {
        const prediction = await this.predictIntent(tx);
        predictions.push(prediction);
      } catch (error) {
        console.error(`Failed to predict intent for ${tx.signature}:`, error);
        predictions.push({ intent: 'unknown', confidence: 0 });
      }
    }

    return predictions;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/health`, { timeout: 2000 });
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

export const mlService = new MLService();
