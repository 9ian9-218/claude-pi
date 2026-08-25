/**
 * fatal.ts — 进程级崩溃兜底（工程隐患 04）
 *
 * 顶层捕获 uncaughtException / unhandledRejection：会话数据已逐条同步落盘，
 * 兜底只需记录原因 + 提示 + 退出码 1（而非带未保存状态静默退出或挂死）。
 */

/** 兜底处理：打印错误与提示，退出码 1 */
export function handleFatalError(err: unknown, kind: "uncaughtException" | "unhandledRejection"): void {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`\n\x1b[31m[${kind}] ${detail}\x1b[0m`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack.split("\n").slice(0, 8).join("\n"));
  }
  console.error("\n会话数据已逐条落盘，可用 cpi --session <id> 恢复。");
  process.exit(1);
}

/** 安装顶层兜底（cli 入口调用一次） */
export function installFatalHandlers(): void {
  process.on("uncaughtException", (err) => handleFatalError(err, "uncaughtException"));
  process.on("unhandledRejection", (reason) => handleFatalError(reason, "unhandledRejection"));
}
