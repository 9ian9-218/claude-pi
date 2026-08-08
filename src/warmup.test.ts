import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { warmUp, resetWarmUp } from "./warmup.ts";
import { setModelRuntimeOverride, resetAiRuntime } from "./ai-runtime.ts";

describe("warmup（架构 A）", () => {
  beforeEach(() => {
    resetAiRuntime();
    // 注入 stub 运行时，避免测试环境真实 ModelRuntime.create 挂起
    setModelRuntimeOverride({
      getAvailableSnapshot: () => [],
    } as never);
  });

  afterEach(() => {
    resetWarmUp();
    resetAiRuntime();
  });

  it("幂等：多次调用共享同一次预热", async () => {
    const p1 = warmUp();
    const p2 = warmUp();
    expect(p1).toBe(p2); // 预热中：共享同一 promise
    await p1;
    // 预热完成：不再重复执行（立即返回已 resolve 的 promise）
    const t0 = performance.now();
    await warmUp();
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("运行时 create 抛错时静默失败（不抛、不拒绝）", async () => {
    resetAiRuntime();
    // 无 override → getModelRuntime 走真实路径（无凭据环境会挂起或抛错）
    // 有超时保护，最终 resolve（不 reject）
    await expect(warmUp()).resolves.toBeUndefined();
  });

  it("预热完成后再次调用立即返回", async () => {
    await warmUp();
    const after = warmUp();
    expect(after).toBeDefined();
    await after;
  });
});
