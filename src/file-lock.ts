/**
 * file-lock.ts — 文件锁（等价 fcntl flock 语义；proper-lockfile，pi 同款）
 *
 * 邮箱/tasks 等共享文件写操作用。重试退避对齐 Python file_lock：
 * 10 次重试、5–100ms 指数退避 + jitter。
 */
import path from "node:path";
import properLockfile from "proper-lockfile";

export const LOCK_RETRIES = 10;
export const LOCK_MIN_TIMEOUT_MS = 5;
export const LOCK_MAX_TIMEOUT_MS = 100;

/** 获取互斥锁并执行 fn；自动释放（对齐 Python with file_lock(...)） */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const dir = path.dirname(lockPath);
  const fs = await import("node:fs");
  await fs.promises.mkdir(dir, { recursive: true });
  // proper-lockfile 要求目标文件存在（mtime stale 检测）
  await fs.promises.writeFile(lockPath, "", { flag: "a" });
  const release = await properLockfile.lock(lockPath, {
    retries: {
      retries: LOCK_RETRIES,
      factor: 2,
      minTimeout: LOCK_MIN_TIMEOUT_MS,
      maxTimeout: LOCK_MAX_TIMEOUT_MS,
      randomize: true,
    },
    stale: 30_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
