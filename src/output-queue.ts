/**
 * output-queue.ts — 串行化输出（对齐 console_lock.py）
 *
 * 多 Agent loop 并发输出时，保证"一次输出块"不交错。
 * Node 单事件循环下用 promise 链互斥即可。
 */
let queue: Promise<void> = Promise.resolve();

export function lockedPrint(...args: unknown[]): void {
  enqueueOutput(() => {
    console.log(...args);
  });
}

export function lockedStdoutWrite(text: string): void {
  enqueueOutput(() => {
    process.stdout.write(text);
  });
}

export function enqueueOutput(fn: () => void): void {
  queue = queue.then(async () => {
    fn();
  });
}

/** 等待队列排空（测试用） */
export function drainOutputQueue(): Promise<void> {
  return queue;
}
