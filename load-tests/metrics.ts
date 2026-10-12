import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

export interface LatencyStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface MemorySample {
  rssMB: number;
  heapUsedMB: number;
  heapTotalMB: number;
  externalMB: number;
}

export interface EventLoopStats {
  meanMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ScenarioTierResult {
  scenarioName: string;
  concurrency: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  errorRatePercent: number;
  statusCodes: Record<number, number>;
  totalDurationMs: LatencyStats;
  ttftMs?: LatencyStats;
  throughputReqSec: number;
  eventLoopLag: EventLoopStats;
  memory: {
    start: MemorySample;
    peak: MemorySample;
    end: MemorySample;
  };
  integrityCheck: {
    passed: boolean;
    details: string;
  };
}

export function computePercentiles(values: number[]): LatencyStats {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = Math.round((sum / count) * 100) / 100;

  const getPercentile = (p: number): number => {
    const idx = Math.min(Math.floor((p / 100) * count), count - 1);
    return Math.round((sorted[idx] ?? 0) * 100) / 100;
  };

  return {
    count,
    min: Math.round((sorted[0] ?? 0) * 100) / 100,
    max: Math.round((sorted[count - 1] ?? 0) * 100) / 100,
    mean,
    p50: getPercentile(50),
    p90: getPercentile(90),
    p95: getPercentile(95),
    p99: getPercentile(99),
  };
}

export function sampleMemory(): MemorySample {
  const mem = process.memoryUsage();
  const toMB = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 100) / 100;
  return {
    rssMB: toMB(mem.rss),
    heapUsedMB: toMB(mem.heapUsed),
    heapTotalMB: toMB(mem.heapTotal),
    externalMB: toMB(mem.external),
  };
}

export class PerformanceCollector {
  private elHistogram: IntervalHistogram | null = null;
  private peakMem: MemorySample;
  private startMem: MemorySample;
  private memoryInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startMem = sampleMemory();
    this.peakMem = { ...this.startMem };
  }

  public start(): void {
    this.startMem = sampleMemory();
    this.peakMem = { ...this.startMem };

    this.elHistogram = monitorEventLoopDelay({ resolution: 20 });
    this.elHistogram.enable();

    this.memoryInterval = setInterval(() => {
      const current = sampleMemory();
      if (current.rssMB > this.peakMem.rssMB) this.peakMem.rssMB = current.rssMB;
      if (current.heapUsedMB > this.peakMem.heapUsedMB) this.peakMem.heapUsedMB = current.heapUsedMB;
      if (current.heapTotalMB > this.peakMem.heapTotalMB) this.peakMem.heapTotalMB = current.heapTotalMB;
    }, 50);
  }

  public stop(): {
    eventLoopLag: EventLoopStats;
    memory: { start: MemorySample; peak: MemorySample; end: MemorySample };
  } {
    if (this.memoryInterval) {
      clearInterval(this.memoryInterval);
      this.memoryInterval = null;
    }

    let eventLoopLag: EventLoopStats = {
      meanMs: 0,
      maxMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
    };

    if (this.elHistogram) {
      this.elHistogram.disable();
      const toMs = (nanos: number) => Math.round((nanos / 1e6) * 100) / 100;
      eventLoopLag = {
        meanMs: toMs(this.elHistogram.mean),
        maxMs: toMs(this.elHistogram.max),
        p50Ms: toMs(this.elHistogram.percentile(50)),
        p95Ms: toMs(this.elHistogram.percentile(95)),
        p99Ms: toMs(this.elHistogram.percentile(99)),
      };
    }

    const endMem = sampleMemory();
    return {
      eventLoopLag,
      memory: {
        start: this.startMem,
        peak: this.peakMem,
        end: endMem,
      },
    };
  }
}

export function printTierSummaryTable(tier: ScenarioTierResult): void {
  console.log(`\n+-----------------------------------------------------------------------------------------+`);
  console.log(`| [${tier.scenarioName}] CONCURRENCY TIER: ${tier.concurrency} CONNECTIONS`.padEnd(90) + "|");
  console.log(`+-----------------------------------------------------------------------------------------+`);
  console.log(
    `| Requests: Total=${tier.totalRequests} | OK=${tier.successfulRequests} | Fail=${tier.failedRequests} | Error Rate=${tier.errorRatePercent.toFixed(1)}% | Throughput=${tier.throughputReqSec.toFixed(1)} req/s`.padEnd(90) + "|"
  );
  console.log(
    `| Status Codes: ${JSON.stringify(tier.statusCodes)}`.padEnd(90) + "|"
  );
  console.log(`| Latency Total: p50=${tier.totalDurationMs.p50}ms | p90=${tier.totalDurationMs.p90}ms | p95=${tier.totalDurationMs.p95}ms | p99=${tier.totalDurationMs.p99}ms | max=${tier.totalDurationMs.max}ms`.padEnd(90) + "|");

  if (tier.ttftMs && tier.ttftMs.count > 0) {
    console.log(`| Stream TTFT:   p50=${tier.ttftMs.p50}ms | p90=${tier.ttftMs.p90}ms | p95=${tier.ttftMs.p95}ms | p99=${tier.ttftMs.p99}ms | max=${tier.ttftMs.max}ms`.padEnd(90) + "|");
  }

  console.log(`| Memory (RSS):  Start=${tier.memory.start.rssMB}MB -> Peak=${tier.memory.peak.rssMB}MB -> End=${tier.memory.end.rssMB}MB (Delta: +${(tier.memory.peak.rssMB - tier.memory.start.rssMB).toFixed(1)}MB)`.padEnd(90) + "|");
  console.log(`| Memory (Heap): Start=${tier.memory.start.heapUsedMB}MB -> Peak=${tier.memory.peak.heapUsedMB}MB -> End=${tier.memory.end.heapUsedMB}MB`.padEnd(90) + "|");
  console.log(`| EventLoop Lag: p50=${tier.eventLoopLag.p50Ms}ms | p95=${tier.eventLoopLag.p95Ms}ms | p99=${tier.eventLoopLag.p99Ms}ms | max=${tier.eventLoopLag.maxMs}ms`.padEnd(90) + "|");
  console.log(`| Integrity:     [${tier.integrityCheck.passed ? "PASS" : "FAIL"}] ${tier.integrityCheck.details}`.padEnd(90) + "|");
  console.log(`+-----------------------------------------------------------------------------------------+\n`);
}
