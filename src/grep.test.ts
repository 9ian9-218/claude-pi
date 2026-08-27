/**
 * grep 工具测试（基于真实 ripgrep；rg 不可用时整组跳过）。
 * 覆盖：路径输出格式、ignore_case/literal/glob、limit 截断、字节截断、
 * 行截断提示、无匹配、错误路径、逃逸拦截。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeToolCall, validateArgs, getToolParameters, type ToolCallLike } from "./tool.ts";
import { runWithWorkdir } from "./workdir.ts";
import { runGrepSearch } from "./grep.ts";
import { resolveRipgrep, downloadRipgrep } from "./ripgrep.ts";

let rgPath: string | null = null;
try {
  rgPath = resolveRipgrep();
  if (rgPath === null) rgPath = await downloadRipgrep();
} catch {
  rgPath = null;
}

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-grep-"));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

function mkCall(name: string, args: Record<string, unknown>): ToolCallLike {
  return { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

describe.skipIf(rgPath === null)("grep 工具（S1，需 ripgrep）", () => {
  it("按 pattern 返回 path:line: text（相对 workdir）", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "a.txt"), "hello world\nno match here\nhello again");
      const r = await executeToolCall(mkCall("grep", { pattern: "hello" }));
      expect(r).toContain("a.txt:1: hello world");
      expect(r).toContain("a.txt:3: hello again");
      expect(r).not.toContain("a.txt:2");
    });
  });

  it("path 指定子目录/文件时限制搜索范围", async () => {
    await runWithWorkdir(ws, async () => {
      fs.mkdirSync(path.join(ws, "sub"));
      fs.writeFileSync(path.join(ws, "sub", "b.ts"), "const x = 1\n// hello");
      fs.writeFileSync(path.join(ws, "root.txt"), "hello");
      const r = await executeToolCall(mkCall("grep", { pattern: "hello", path: "sub" }));
      expect(r).toContain("sub/b.ts:2:");
      expect(r).not.toContain("root.txt");
    });
  });

  it("ignore_case 忽略大小写", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "c.txt"), "Hello World");
      expect(await executeToolCall(mkCall("grep", { pattern: "hello", ignore_case: true }))).toContain(
        "c.txt:1: Hello World",
      );
      expect(await executeToolCall(mkCall("grep", { pattern: "hello" }))).toBe("No matches found");
    });
  });

  it("literal=true 把正则特殊字符当字面量", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "d.txt"), "price $5.00\nx.y");
      const r = await executeToolCall(mkCall("grep", { pattern: "$5.00", literal: true }));
      expect(r).toContain("d.txt:1: price $5.00");
      expect(r).not.toContain("x.y");
    });
  });

  it("glob 过滤文件", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "keep.ts"), "needle");
      fs.writeFileSync(path.join(ws, "skip.md"), "needle");
      const r = await executeToolCall(mkCall("grep", { pattern: "needle", glob: "*.ts" }));
      expect(r).toContain("keep.ts:1: needle");
      expect(r).not.toContain("skip.md");
    });
  });

  it("达到 limit 停止并提示", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "e.txt"), Array.from({ length: 50 }, (_, i) => `match ${i}`).join("\n"));
      const r = await executeToolCall(mkCall("grep", { pattern: "match", limit: 5 }));
      const lines = r.split("\n").filter((l) => l.includes(":"));
      expect(lines).toHaveLength(5);
      expect(r).toContain("[5 matches limit reached. Use limit=10 for more");
    });
  });

  it("长行截断并提示用 read_file", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "f.txt"), "x".repeat(2000));
      const r = await executeToolCall(mkCall("grep", { pattern: "x" }));
      expect(r).toContain("f.txt:1:");
      expect(r).toContain("…");
      expect(r).toContain("Some lines truncated to 500 chars. Use read_file to see full lines");
    });
  });

  it("字节上限截断（50KB，直接测 runGrepSearch 避开落盘层）", async () => {
    const lines = Array.from({ length: 3000 }, () => "y".repeat(40)); // ~120KB
    fs.writeFileSync(path.join(ws, "big.txt"), lines.join("\n"));
    const r = await runGrepSearch({ pattern: "y", limit: 100000 }, { workdir: ws, rgPath: rgPath! });
    expect(r).toContain("50KB output limit reached");
    expect(Buffer.byteLength(r, "utf8")).toBeLessThan(60 * 1024);
  });

  it("无匹配返回 No matches found", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "g.txt"), "nothing here");
      expect(await executeToolCall(mkCall("grep", { pattern: "zzz" }))).toBe("No matches found");
    });
  });

  it("path 逃逸工作区被拒绝", async () => {
    await runWithWorkdir(ws, async () => {
      expect(await executeToolCall(mkCall("grep", { pattern: "x", path: "../evil" }))).toContain(
        "Path escapes workspace",
      );
    });
  });

  it("path 不存在返回错误", async () => {
    await runWithWorkdir(ws, async () => {
      const r = await executeToolCall(mkCall("grep", { pattern: "x", path: "nope-dir" }));
      expect(r).toContain("Error:");
    });
  });

  it("缺 pattern 时 schema 校验拦截（validateArgs 层）", () => {
    const schema = getToolParameters("grep");
    expect(schema).not.toBeNull();
    expect(validateArgs({}, schema!)).toContain("Missing required parameter: pattern");
  });
});