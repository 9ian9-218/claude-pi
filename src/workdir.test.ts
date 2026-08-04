import { describe, it, expect } from "vitest";
import { getWorkdir, runWithWorkdir, setWorktreeOverride } from "./workdir.ts";

describe("workdir（对齐 get_workdir 线程本地语义）", () => {
  it("默认返回 process.cwd()", () => {
    expect(getWorkdir()).toBe(process.cwd());
  });

  it("runWithWorkdir 内返回注入目录，退出后恢复", () => {
    expect(
      runWithWorkdir("/tmp/ws-a", () => {
        expect(getWorkdir()).toBe("/tmp/ws-a");
        return "inner";
      }),
    ).toBe("inner");
    expect(getWorkdir()).toBe(process.cwd());
  });

  it("异步上下文内保持注入目录", async () => {
    await runWithWorkdir("/tmp/ws-b", async () => {
      await new Promise((r) => setTimeout(r, 10));
      expect(getWorkdir()).toBe("/tmp/ws-b");
    });
    expect(getWorkdir()).toBe(process.cwd());
  });

  it("嵌套覆盖：内层覆盖外层，退出后恢复外层", () => {
    runWithWorkdir("/tmp/ws-outer", () => {
      runWithWorkdir("/tmp/ws-inner", () => {
        expect(getWorkdir()).toBe("/tmp/ws-inner");
      });
      expect(getWorkdir()).toBe("/tmp/ws-outer");
    });
  });

  it("setWorktreeOverride 更新当前上下文目录，置 null 恢复（claim/complete 语义）", () => {
    runWithWorkdir(process.cwd(), () => {
      setWorktreeOverride("/tmp/ws-wt");
      expect(getWorkdir()).toBe("/tmp/ws-wt");
      setWorktreeOverride(null);
      expect(getWorkdir()).toBe(process.cwd());
    });
  });

  it("不同上下文互不干扰（teammate 安全）", async () => {
    const results: string[] = [];
    await Promise.all([
      runWithWorkdir("/tmp/ws-a", async () => {
        await new Promise((r) => setTimeout(r, 20));
        setWorktreeOverride("/tmp/ws-a2");
        await new Promise((r) => setTimeout(r, 20));
        results.push(getWorkdir());
      }),
      runWithWorkdir("/tmp/ws-b", async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(getWorkdir());
      }),
    ]);
    expect(results.sort()).toEqual(["/tmp/ws-a2", "/tmp/ws-b"]);
  });
});
