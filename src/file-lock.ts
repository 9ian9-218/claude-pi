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
import { spawn } from "node:child_process";

/** Linux kernel locks are released on crash; no stale-directory timeout is needed. */
async function withKernelLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
  const executable = ["/usr/bin/flock", "/bin/flock"].find(p => fs.existsSync(p));
  if (!executable) throw new Error("Concurrent writes require system flock on Linux");
  const child = spawn(executable, ["--exclusive", "--timeout", "60", "--close", lockPath, "/bin/sh", "-c", "printf 'LOCKED\\n'; cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  child.stdin.on("error", () => { /* Acquisition failure is reported by close/error below. */ });
  const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", b => { output += b; if (output.includes("LOCKED\n")) resolve(); });
      child.once("error", reject);
      child.once("close", code => reject(new Error(`Could not acquire kernel lock (${code})`)));
    });
    return await fn();
  } finally { child.stdin.end(); await closed; }
}

export const LOCK_RETRIES = 80;
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
    if (process.platform === "linux") return await withKernelLock(lockPath, fn);
    const release = await properLockfile.lock(lockPath, {
      retries: {
        retries: LOCK_RETRIES,
        factor: 2,
        minTimeout: LOCK_MIN_TIMEOUT_MS,
        maxTimeout: LOCK_MAX_TIMEOUT_MS,
        randomize: true,
      },
      // Git snapshot creation can briefly block the event loop. Do not expire a
      // live writer while its heartbeat is delayed by a synchronous Git call.
      stale: 120_000,
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
