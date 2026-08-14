/**
 * Next.js instrumentation — 服务启动时执行一次
 * Node.js 专属逻辑（全局错误兜底）按 runtime 动态导入，避免 Edge Runtime 编译告警。
 * 参考 Next.js 16 官方约定：instrumentation.ts 按 NEXT_RUNTIME 条件加载独立模块。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
