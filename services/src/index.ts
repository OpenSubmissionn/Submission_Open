export * from './analysis/types.js';
export {
  getProgramName,
  getProgramNameSync,
  getProgramInfo,
  isProgramKnown,
  getProgramsByCategory,
} from './solana/programs.js';

export * from './analysis/accountDiff.js';
export * from './analysis/txParser.js';
export type { ParsedLogs as ParsedLogsFromLogParser } from './analysis/logParser.js';
export { parseLogsFromBundle } from './analysis/logParser.js';
export * from './analysis/cuProfiler.js';
export * from './analysis/cpiTreeBuilder.js';
export * from './solana/idlcache.js';
export type { IdlCacheOptions, FetchResult } from './solana/idlcache.js';
export * from './analysis/merger.js';
export { analyzeTransaction, mergeInsights } from './analysis/insightEngine.js';
export { detectAnomalies } from './analysis/anomalyDetector.js';
export type {
  Anomaly,
  AnomalyType,
  AnomalySeverity,
  AnomalyReport,
} from './analysis/anomalyDetector.js';
export * from './analysis/renderer.js';
export * from './solana/rpc.js';
export * from './solana/connection.js';
export * from './solana/simulationService.js';
export * from './solana/sourceRunner.js';

// Batch analysis
export * from './analysis/batchAggregator.js';

// MCP Integration
export * from './mcp/client.js';
export * from './mcp/mcpInsightProvider.js';
