/**
 * Next.js instrumentation — 服务启动时执行一次
 * 注册全局未处理 rejection / 未捕获异常兜底，作为生产环境最后防线。
 * 上游（Worker/Queue 的 error 事件、API 路由 try/catch）应已处理绝大多数错误，
 * 此处仅捕获漏网之鱼，避免进程静默崩溃或日志丢失。
 */
export async function register(): Promise<void> {
  // 未处理的 Promise rejection（如 fire-and-forget 调用抛错）
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : "";
    console.error(`[global] unhandledRejection: ${msg}${stack ? `\n${stack}` : ""}`);
  });

  // 未捕获的同步异常（如 EventEmitter 无 listener 的 error 事件）
  // 按Node.js最佳实践：记录后退出，交由进程管理器（pm2/docker/systemd）重启；
  // 继续运行可能导致状态不一致。开发环境同样退出以便及早发现问题。
  process.on("uncaughtException", (err) => {
    console.error(`[global] uncaughtException: ${err.message}\n${err.stack ?? ""}`);
    // 给日志一点 flush 时间再退出
    setImmediate(() => process.exit(1));
  });
}
