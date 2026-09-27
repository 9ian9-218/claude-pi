import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  refreshModelCatalog,
  modelNetworkEnabled,
  setModelRuntimeOverride,
  resetAiRuntime,
} from "./ai-runtime.ts";

interface RefreshOpts {
  allowNetwork?: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

/**
 * ModelRuntime stub：记录 refresh 调用参数，可模拟快照变化 / 出错 / 挂起。
 * onRefresh 在返回结果前执行，用来模拟「刷新把新模型加进了模型表」。
 */
function stubRuntime(init: {
  snapshot?: unknown[];
  onRefresh?: (opts: RefreshOpts, setSnapshot: (next: unknown[]) => void) => void | Promise<void>;
  refreshImpl?: (opts: RefreshOpts) => Promise<unknown>;
} = {}) {
  let snapshot = init.snapshot ?? [{ id: "a" }, { id: "b" }];
  const calls: RefreshOpts[] = [];
  const setSnapshot = (next: unknown[]) => {
    snapshot = next;
  };
  const runtime = {
    getAvailableSnapshot: () => snapshot,
    getError: () => undefined,
    refresh: async (opts: RefreshOpts = {}) => {
      calls.push(opts);
      if (init.refreshImpl) return init.refreshImpl(opts);
      if (init.onRefresh) await init.onRefresh(opts, setSnapshot);
      return { aborted: false, errors: new Map() };
    },
  } as never;
  return { calls, setSnapshot, runtime };
}

const ORIGINAL_OFFLINE = process.env.PI_OFFLINE;

describe("refreshModelCatalog（模型目录自动更新）", () => {
  beforeEach(() => {
    delete process.env.PI_OFFLINE;
    resetAiRuntime();
  });

  afterEach(() => {
    if (ORIGINAL_OFFLINE === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = ORIGINAL_OFFLINE;
    resetAiRuntime();
  });

  it("默认联网刷新，透传 force", async () => {
    const s = stubRuntime();
    setModelRuntimeOverride(s.runtime);
    const r = await refreshModelCatalog({ force: true });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.allowNetwork).toBe(true);
    expect(s.calls[0]?.force).toBe(true);
    expect(r.network).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("远端新增的模型反映在 after 上（before/after 计数）", async () => {
    const s = stubRuntime({
      onRefresh: (_opts, set) => set([{ id: "a" }, { id: "b" }, { id: "deepseek-v4.1-flash" }]),
    });
    setModelRuntimeOverride(s.runtime);
    const r = await refreshModelCatalog();
    expect(r.before).toBe(2);
    expect(r.after).toBe(3);
  });

  it("PI_OFFLINE 存在时不发网络请求（仅应用本地 overlay）", async () => {
    process.env.PI_OFFLINE = "1";
    expect(modelNetworkEnabled()).toBe(false);
    const s = stubRuntime();
    setModelRuntimeOverride(s.runtime);
    const r = await refreshModelCatalog();
    expect(s.calls[0]?.allowNetwork).toBe(false);
    expect(r.network).toBe(false);
  });

  it("provider 级错误被收集但不抛", async () => {
    const s = stubRuntime({
      refreshImpl: async () => ({
        aborted: false,
        errors: new Map([["opencode-go", new Error("catalog unreachable")]]),
      }),
    });
    setModelRuntimeOverride(s.runtime);
    const r = await refreshModelCatalog();
    expect(r.errors).toEqual(["opencode-go: catalog unreachable"]);
    expect(r.after).toBe(2);
  });

  it("refresh 抛错时降级为 errors，不向上抛", async () => {
    const s = stubRuntime({
      refreshImpl: async () => {
        throw new Error("network down");
      },
    });
    setModelRuntimeOverride(s.runtime);
    await expect(refreshModelCatalog()).resolves.toMatchObject({ errors: ["network down"] });
  });

  it("超时被标记且不挂住调用方", async () => {
    const s = stubRuntime({
      refreshImpl: (opts) =>
        new Promise((_resolve, reject) => {
          // 模拟网络挂起：只在中止时结束
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    setModelRuntimeOverride(s.runtime);
    const t0 = performance.now();
    const r = await refreshModelCatalog({ timeoutMs: 50 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.timedOut).toBe(true);
  });
});
