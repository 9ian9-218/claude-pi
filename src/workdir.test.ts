import { describe, it, expect } from "vitest";
import { getWorkdir, runWithWorkdir } from "./workdir.ts";

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
});
