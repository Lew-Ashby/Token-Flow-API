export interface Transfer {
  signature: string;
  fromAddress: string;
  toAddress: string;
  tokenMint: string;
  amount: bigint;
  decimals: number;
  instructionIndex: number;
  blockTime: number;
  txType?: 'transfer' | 'swap' | 'unknown';  // Transaction type
  swapDirection?: 'buy' | 'sell';  // For swaps: buy = receiving target token, sell = sending target token
  swapInfo?: {
    dex?: string;           // DEX name (Jupiter, Raydium, etc.)
    tokenIn?: string;       // Token swapped from
    tokenOut?: string;      // Token swapped to
    amountIn?: string;
    amountOut?: string;
  };
}

export interface ParsedTransaction {
  signature: string;
  blockTime: number;
  slot: number;
  fee: number;
  success: boolean;
  accounts: string[];
  instructions: any[];
}

export interface PathNode {
  address: string;
  entityType?: string;
  entityName?: string;
  amountIn: string;
  amountOut: string;
  timestamp?: number;
}

export interface FlowPath {
  pathId: string;
  startAddress: string;
  endAddress: string;
  tokenMint: string;
  hops: PathNode[];
  totalAmount: string;
  hopCount: number;
  confidenceScore: number;
  intent?: string;
  intentConfidence?: number;
  riskScore?: number;
  riskLevel?: string;
}

export interface CircularFlow {
  addresses: string[];
  totalAmount: string;
  cycleCount: number;
}

export interface TimeRange {
  start: number;
  end: number;
}

export interface QueryOptions {
  limit?: number;
  before?: string;
  until?: number;
}

export interface Entity {
  address: string;
  entityType: string;
  name?: string;
  riskLevel?: string;
  riskScore?: number;
  metadata?: any;
}

export interface RiskAssessment {
  address: string;
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  flags: RiskFlag[];
  lastAssessed: Date;
}

export interface RiskFlag {
  type: string;
  severity: 'info' | 'warning' | 'critical';
  details: any;
}

export interface AlertConditions {
  minAmount?: string;
  maxRiskScore?: number;
  intentTypes?: string[];
  entityTypes?: string[];
}

export interface ApiKeyData {
  key_hash: string;
  user_id: string;
  tier: string;
  rate_limit_per_minute: number;
  created_at: Date;
  last_used_at?: Date;
  active: boolean;
}

export interface PathAnalysisRequest {
  address: string;
  token: string;
  direction?: 'forward' | 'backward';
  maxDepth?: number;
  timeRange?: string;
}

export interface PathAnalysisResponse {
  paths: FlowPath[];
  summary: {
    totalPaths: number;
    netFlow: {
      in: string;
      out: string;
    };
  };
}

export interface IntentPrediction {
  signature: string;
  intent: string;
  confidence: number;
  details: {
    dexInteraction: boolean;
    tokenSwapped: boolean;
    programsInvolved: string[];
  };
}

export interface TraceRequest {
  signatures: string[];
  buildGraph?: boolean;
}

export interface GraphNode {
  id: string;
  address: string;
  entityType?: string;
  entityName?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  amount: string;
  tokenMint: string;
  signature: string;
}

export interface TraceResponse {
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  aggregatedIntent?: string;
  confidence?: number;
}
