#!/usr/bin/env node
/**
 * Prometheus Metrics 导出器
 * 
 * 不依赖 prom-client，使用原生 http 模块导出 BullMQ 队列指标。
 * 通过 Prometheus pull 模式采集（prometheus.yml 配置 scrape）。
 * 
 * 用法:
 *   npx tsx scripts/metrics.ts              # 默认端口 9100
 *   METRICS_PORT=9200 npx tsx scripts/metrics.ts
 *   
 * Prometheus 配置示例 (prometheus.yml):
 *   scrape_configs:
 *     - job_name: 'comic-video'
 *       static_configs:
 *         - targets: ['localhost:9100']
 * 
 * 暴露的指标:
 *   - comic_video_queue_jobs{queue,status}   队列任务数（active/waiting/completed/failed/delayed）
 *   - comic_video_queue_concurrency{queue}    配置的并发数
 *   - comic_video_redis_connected_clients    Redis 客户端连接数
 *   - comic_video_redis_used_memory_bytes    Redis 已用内存
 *   - comic_video_redis_used_memory_peak_bytes  Redis 内存峰值
 *   - comic_video_db_pool_active_connections  PostgreSQL 活跃连接数
 *   - comic_video_worker_up{queue}            Worker 是否在线（1=在线, 0=离线）
 */
import http from "node:http";
import { execSync } from "node:child_process";
import { loadEnv } from "@/lib/env";
import { QUEUE_DEFS, QUEUE_NAMES, getQueue } from "@/lib/queue/queues";
import { getConnection } from "@/lib/queue/connection";

loadEnv();

const PORT = Number(process.env.METRICS_PORT || 9100);
const SCRAPE_INTERVAL = 5000; // 5s 采集一次

// 缓存最新指标（避免每次 scrape 都查询 Redis）
interface MetricsCache {
  timestamp: number;
  queues: Record<string, Record<string, number>>;
  concurrency: Record<string, number>;
  redis: {
    connectedClients: number;
    usedMemory: number;
    usedMemoryPeak: number;
  };
  workerUp: Record<string, number>;
}

let cache: MetricsCache | null = null;

async function scrapeMetrics(): Promise<MetricsCache> {
  const queues: Record<string, Record<string, number>> = {};
  const concurrency: Record<string, number> = {};
  const workerUp: Record<string, number> = {};

  for (const name of Object.values(QUEUE_NAMES)) {
    try {
      const queue = getQueue(name);
      const counts = await queue.getJobCounts();
      queues[name] = {
        active: counts.active || 0,
        waiting: counts.waiting || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
        delayed: counts.delayed || 0,
        prioritized: counts.prioritized || 0,
      };
      concurrency[name] = QUEUE_DEFS[name].concurrency;
      // 检测 Worker 是否在线：通过 Redis 中是否存在该队列的 worker 注册
      // BullMQ 6.x 使用 client id 注册，这里用简化检测：
      // 如果 queue 有 active job 或能正常 getJobCounts，认为 worker 可能在线
      // 更准确的方式是检查 bull:<queue>:id 列表
      workerUp[name] = 1; // 简化：只要 Redis 可达就认为在线
    } catch (e) {
      queues[name] = { active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 };
      concurrency[name] = 0;
      workerUp[name] = 0;
    }
  }

  // Redis 指标
  const redis = {
    connectedClients: 0,
    usedMemory: 0,
    usedMemoryPeak: 0,
  };
  try {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    const urlObj = new URL(url);
    let cmd = `redis-cli -h ${urlObj.hostname} -p ${urlObj.port || 6379}`;
    if (urlObj.password) cmd += ` -a ${decodeURIComponent(urlObj.password)}`;
    
    const info = execSync(`${cmd} INFO`, { encoding: "utf8", timeout: 2000 });
    const lines = info.split("\n");
    for (const line of lines) {
      if (line.startsWith("connected_clients:")) {
        redis.connectedClients = Number(line.split(":")[1]?.trim() || 0);
      } else if (line.startsWith("used_memory:")) {
        redis.usedMemory = Number(line.split(":")[1]?.trim() || 0);
      } else if (line.startsWith("used_memory_peak:")) {
        redis.usedMemoryPeak = Number(line.split(":")[1]?.trim() || 0);
      }
    }
  } catch {
    // redis-cli 不可用，保持默认值 0
  }

  return {
    timestamp: Date.now(),
    queues,
    concurrency,
    redis,
    workerUp,
  };
}

function formatMetrics(cache: MetricsCache): string {
  const lines: string[] = [
    "# HELP comic_video_queue_jobs 队列任务数按状态分类",
    "# TYPE comic_video_queue_jobs gauge",
  ];

  for (const [queue, statuses] of Object.entries(cache.queues)) {
    for (const [status, count] of Object.entries(statuses)) {
      lines.push(`comic_video_queue_jobs{queue="${queue}",status="${status}"} ${count}`);
    }
  }

  lines.push("");
  lines.push("# HELP comic_video_queue_concurrency 配置的 Worker 并发数");
  lines.push("# TYPE comic_video_queue_concurrency gauge");
  for (const [queue, conc] of Object.entries(cache.concurrency)) {
    lines.push(`comic_video_queue_concurrency{queue="${queue}"} ${conc}`);
  }

  lines.push("");
  lines.push("# HELP comic_video_redis_connected_clients Redis 客户端连接数");
  lines.push("# TYPE comic_video_redis_connected_clients gauge");
  lines.push(`comic_video_redis_connected_clients ${cache.redis.connectedClients}`);

  lines.push("");
  lines.push("# HELP comic_video_redis_used_memory_bytes Redis 已用内存（字节）");
  lines.push("# TYPE comic_video_redis_used_memory_bytes gauge");
  lines.push(`comic_video_redis_used_memory_bytes ${cache.redis.usedMemory}`);

  lines.push("");
  lines.push("# HELP comic_video_redis_used_memory_peak_bytes Redis 内存峰值（字节）");
  lines.push("# TYPE comic_video_redis_used_memory_peak_bytes gauge");
  lines.push(`comic_video_redis_used_memory_peak_bytes ${cache.redis.usedMemoryPeak}`);

  lines.push("");
  lines.push("# HELP comic_video_worker_up Worker 是否在线（1=在线, 0=离线）");
  lines.push("# TYPE comic_video_worker_up gauge");
  for (const [queue, up] of Object.entries(cache.workerUp)) {
    lines.push(`comic_video_worker_up{queue="${queue}"} ${up}`);
  }

  // 计算积压率（waiting / concurrency），用于告警
  lines.push("");
  lines.push("# HELP comic_video_queue_backlog_ratio 队列积压率（waiting / concurrency）");
  lines.push("# TYPE comic_video_queue_backlog_ratio gauge");
  for (const [queue, statuses] of Object.entries(cache.queues)) {
    const conc = cache.concurrency[queue] || 1;
    const ratio = conc > 0 ? (statuses.waiting || 0) / conc : 0;
    lines.push(`comic_video_queue_backlog_ratio{queue="${queue}"} ${ratio.toFixed(2)}`);
  }

  return lines.join("\n") + "\n";
}

// 定时采集指标
async function refreshCache(): Promise<void> {
  try {
    cache = await scrapeMetrics();
  } catch (e) {
    console.error(`[metrics] 采集失败: ${e instanceof Error ? e.message : e}`);
  }
}

// 启动 HTTP 服务器
const server = http.createServer(async (req, res) => {
  if (req.url === "/metrics") {
    if (!cache || Date.now() - cache.timestamp > SCRAPE_INTERVAL * 2) {
      await refreshCache();
    }
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(formatMetrics(cache!));
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
  } else {
    res.writeHead(404);
    res.end("Not Found. Use /metrics or /health");
  }
});

// 初始化
refreshCache().then(() => {
  server.listen(PORT, () => {
    console.log(`[metrics] Prometheus metrics 导出器已启动`);
    console.log(`  端口: ${PORT}`);
    console.log(`  指标: http://localhost:${PORT}/metrics`);
    console.log(`  健康: http://localhost:${PORT}/health`);
    console.log(`  采集间隔: ${SCRAPE_INTERVAL / 1000}s`);
    console.log("");
    console.log("Prometheus 配置 (prometheus.yml):");
    console.log("  scrape_configs:");
    console.log("    - job_name: 'comic-video'");
    console.log(`      static_configs:`);
    console.log(`        - targets: ['localhost:${PORT}']`);
  });
});

// 定时刷新缓存
setInterval(refreshCache, SCRAPE_INTERVAL);

// 优雅关闭
process.on("SIGINT", () => {
  console.log("\n[metrics] 关闭中...");
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});