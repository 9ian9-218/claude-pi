/**
 * file-lock.ts — 文件锁（等价 fcntl flock 语义）
 *
 * 双层：进程内 promise 队列互斥（proper-lockfile 对同进程二次锁抛 ELOCKED）
 * + proper-lockfile 跨进程文件锁（重试退避对齐 Python file_lock：
 * 10 次、5–100ms 指数退避 + jitter）。
 */
import path from "node:path";
import fs from "node:fs";
import properLockfile from "proper-lockfile";

export const LOCK_RETRIES = 10;
export const LOCK_MIN_TIMEOUT_MS = 5;
export const LOCK_MAX_TIMEOUT_MS = 100;

// 进程内互斥队列（同进程并发安全；跨进程由 proper-lockfile 保证）
const localQueues = new Map<string, Promise<void>>();

/** 获取互斥锁并执行 fn；自动释放（对齐 Python with file_lock(...)） */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  // 1. 进程内排队
  const prev = localQueues.get(lockPath) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const gate = new Promise<void>((r) => {
    releaseLocal = r;
  });
  const tail = prev.then(() => gate, () => gate);
  localQueues.set(lockPath, tail);
  await prev.catch(() => {});

  try {
    // 2. 跨进程文件锁
    const dir = path.dirname(lockPath);
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
  } finally {
    releaseLocal();
    if (localQueues.get(lockPath) === tail) {
      localQueues.delete(lockPath);
    }
  }
}
