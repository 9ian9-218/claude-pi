import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateArgs,
  checkPath,
  safePath,
  getToolParameters,
  executeToolCall,
  getOpenaiTools,
  buildTool,
  CURRENT_TODOS,
  type ToolCallLike,
} from "./tool.ts";
import { runWithWorkdir } from "./workdir.ts";
import { setSkillsDir } from "./skill-load.ts";

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-tool-"));
  // 清空 todo 模块状态（避免同文件测试间泄漏）
  CURRENT_TODOS.splice(0, CURRENT_TODOS.length);
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("validateArgs（S1）", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "integer" },
      flag: { type: "boolean" },
    },
    required: ["path"],
    additionalProperties: false,
  };

  it("缺 required 参数报错", async () => {
    expect(validateArgs({}, schema)).toContain("Missing required parameter: path");
  });

  it("额外参数报错（additionalProperties=false）", async () => {
    expect(validateArgs({ path: "a", extra: 1 }, schema)).toContain(
      "Unexpected parameters: extra",
    );
  });

  it("类型不匹配报错", async () => {
    expect(validateArgs({ path: "a", limit: "x" }, schema)).toContain(
      "Parameter 'limit' must be an integer",
    );
    expect(validateArgs({ path: "a", flag: "yes" }, schema)).toContain(
      "Parameter 'flag' must be a boolean",
    );
  });

  it("全部合法返回 null", async () => {
    expect(validateArgs({ path: "a", limit: 3, flag: true }, schema)).toBeNull();
  });

  it("path 参数逃逸工作区报错", async () => {
    expect(validateArgs({ path: "../evil" }, schema)).toContain("Path escapes workspace");
  });
});

describe("checkPath / safePath（S1）", () => {
  it("checkPath 拒绝逃逸路径，接受工作区内路径", async () => {
    await runWithWorkdir(ws, async () => {
      expect(checkPath("a/b.txt")).toBeNull();
      expect(checkPath("..")).toContain("Path escapes workspace");
      expect(checkPath("../x")).toContain("Path escapes workspace");
      expect(checkPath("/etc/passwd")).toContain("Path escapes workspace");
    });
  });

  it("safePath 返回解析后的绝对路径，逃逸时抛错", async () => {
    await runWithWorkdir(ws, async () => {
      expect(safePath("a.txt")).toBe(path.join(ws, "a.txt"));
      expect(() => safePath("../x")).toThrow("Path escapes workspace");
    });
  });
});

describe("内置工具执行（S1）", () => {
  it("read_file / write_file / edit_file 闭环", async () => {
    await runWithWorkdir(ws, async () => {
      const w = await executeToolCall(mkCall("write_file", { path: "a.txt", content: "hello\nworld" }));
      expect(w).toContain("Wrote 11 bytes");
      const r = await executeToolCall(mkCall("read_file", { path: "a.txt" }));
      expect(r).toContain("<path>a.txt</path>");
      expect(r).toContain("1: hello\n2: world");
      expect(r).toContain("(End of file - total 2 lines)");
      const e = await executeToolCall(
        mkCall("edit_file", { path: "a.txt", old_text: "world", new_text: "TS" }),
      );
      expect(e).toContain("Edited a.txt\nCheckpoint:");
      expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("hello\nTS");
    });
  });

  it("read_file offset/limit 分页：只返回指定窗口并提示继续", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "big.txt"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
      const r = await executeToolCall(mkCall("read_file", { path: "big.txt", offset: 3, limit: 2 }));
      expect(r).toContain("3: line 3\n4: line 4");
      expect(r).not.toContain("1: line 1");
      expect(r).not.toContain("5: line 5");
      expect(r).toContain("(Showing lines 3-4. Use offset=5 to continue.)");
      expect(r).not.toContain("total 10");
    });
  });

  it("read_file 读完整个文件时显示总行数", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "small.txt"), "1\n2\n3");
      const r = await executeToolCall(mkCall("read_file", { path: "small.txt", offset: 2 }));
      expect(r).toContain("2: 2\n3: 3");
      expect(r).toContain("(End of file - total 3 lines)");
    });
  });

  it("read_file 大文件默认 limit=2000：不读完整文件即返回", async () => {
    await runWithWorkdir(ws, async () => {
      const lines = Array.from({ length: 5000 }, (_, i) => `l${i + 1}`);
      fs.writeFileSync(path.join(ws, "huge.txt"), lines.join("\n"));
      const r = await executeToolCall(mkCall("read_file", { path: "huge.txt" }));
      expect(r).toContain("1: l1");
      // 2000 Token 的 L3 阈值会落盘这段输出，行数边界应检查完整产物。
      const outputPath = r.match(/^Full output: (.+)$/m)?.[1];
      expect(outputPath).toBeDefined();
      const fullOutput = fs.readFileSync(outputPath!, "utf8");
      expect(fullOutput).toContain("2000: l2000");
      expect(fullOutput).not.toContain("l2001");
      expect(fullOutput).toContain("(Showing lines 1-2000. Use offset=2001 to continue.)");
    });
  });

  it("read_file offset 超出文件末尾时报错", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "a.txt"), "x\ny");
      const r = await executeToolCall(mkCall("read_file", { path: "a.txt", offset: 99 }));
      expect(r).toContain("offset 99 is beyond end of file (2 lines total)");
    });
  });

  it("read_file 空文件输出 total 0 lines", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "empty.txt"), "");
      const r = await executeToolCall(mkCall("read_file", { path: "empty.txt" }));
      expect(r).toContain("(End of file - total 0 lines)");
      expect(r).toContain("<type>file</type>");
    });
  });

  it("edit_file 文本不存在时报错", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "a.txt"), "x");
      const r = await executeToolCall(
        mkCall("edit_file", { path: "a.txt", old_text: "nope", new_text: "y" }),
      );
      expect(r).toContain("text not found");
    });
  });

  it("read_file 不存在时报错", async () => {
    await runWithWorkdir(ws, async () => {
      expect(await executeToolCall(mkCall("read_file", { path: "missing.txt" }))).toContain("Error:");
    });
  });

  it("glob 按模式返回工作区内文件", async () => {
    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "x.ts"), "");
      fs.writeFileSync(path.join(ws, "y.md"), "");
      const r = await executeToolCall(mkCall("glob", { pattern: "*.ts" }));
      expect(r).toBe("x.ts");
    });
  });

  it("run_bash 执行命令并合并输出", async () => {
    await runWithWorkdir(ws, async () => {
      const r = await executeToolCall(mkCall("run_bash", { command: "echo hi && echo err >&2", run_in_background: false }));
      expect(r).toContain("hi");
      expect(r).toContain("err");
    });
  });

  it("run_bash 无输出返回 (no output)", async () => {
    await runWithWorkdir(ws, async () => {
      expect(await executeToolCall(mkCall("run_bash", { command: "true", run_in_background: false }))).toBe(
        "(no output)",
      );
    });
  });

  it("todo_write 校验字段与状态", async () => {
    await runWithWorkdir(ws, async () => {
      const bad = await executeToolCall(
        mkCall("todo_write", { todos: [{ content: "x" }] }),
      );
      expect(bad).toContain("Missing required parameter: status");
      const badStatus = await executeToolCall(
        mkCall("todo_write", { todos: [{ content: "x", status: "weird" }] }),
      );
      expect(badStatus).toContain("value is not in enum");
      const ok = await executeToolCall(
        mkCall("todo_write", {
          todos: [
            { content: "step1", status: "in_progress" },
            { content: "step2", status: "pending" },
          ],
        }),
      );
      expect(ok).toContain("## Tasks Progress");
      expect(ok).toContain("step1");
      expect(ok).toContain("step2");
    });
  });

  it("空 todos 返回 No tasks yet.（08 接入任务同步）", async () => {
    await runWithWorkdir(ws, async () => {
      expect(await executeToolCall(mkCall("todo_write", { todos: [] }))).toBe("No tasks yet.");
    });
  });
});

describe("executeToolCall 管线（S1）", () => {
  it("未知工具返回错误", async () => {
    expect(await executeToolCall(mkCall("ghost", {}))).toContain("Unknown tool: ghost");
  });

  it("非法 JSON 参数返回错误", async () => {
    const r = await executeToolCall({ function: { name: "read_file", arguments: "{bad" } });
    expect(r).toContain("Invalid arguments JSON");
  });

  it("非对象参数返回错误", async () => {
    const r = await executeToolCall({ function: { name: "read_file", arguments: "[1,2]" } });
    expect(r).toContain("Arguments must be a JSON object");
  });

  it("非字符串结果 JSON 序列化", async () => {
    const tool = buildTool({
      name: "echo_obj",
      description: "t",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      execute: () => ({ status: "success", message: "ok" }),
      isReadOnly: true,
    });
    const r = tool.run({});
    expect(typeof r).toBe("object");
    expect(JSON.stringify(r)).toContain('"status":"success"');
  });
});

describe("getToolParameters / getOpenaiTools（S1）", () => {
  it("getToolParameters 返回内置工具 schema", async () => {
    const schema = getToolParameters("read_file");
    expect(schema?.required).toContain("path");
    expect(getToolParameters("ghost")).toBeNull();
  });

  it("getOpenaiTools 返回 OpenAI 格式工具列表（含 strict）", async () => {
    const tools = getOpenaiTools(false);
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("run_bash");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).toContain("todo_write");
    expect(tools.every((t) => t.function.strict === true)).toBe(true);
  });
});

function mkCall(name: string, args: Record<string, unknown>): ToolCallLike {
  return { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

describe("load_skill 工具（S7）", () => {
  it("按名返回 skill 全文，未知名报错", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-tool-skill-"));
    fs.mkdirSync(path.join(dir, "pdf"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "pdf", "SKILL.md"),
      "---\nname: pdf\ndescription: pdf 处理\n---\n\n# PDF\nfull skill body",
    );
    setSkillsDir(dir);
    try {
      const ok = await executeToolCall(mkCall("load_skill", { name: "pdf" }));
      expect(ok).toContain("full skill body");
      const missing = await executeToolCall(mkCall("load_skill", { name: "nope" }));
      expect(missing).toContain("Skill not found: nope");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run_bash 大输出（L3 CC 式）", () => {
  it(">30K 字符且 >6K tokens：截断叠加落盘（返回引用，不内联全量）", async () => {
    await runWithWorkdir(ws, async () => {
      const r = await executeToolCall(
        mkCall("run_bash", { command: "python3 -c \"print('l' * 35000)\"", run_in_background: false }),
      );
      expect(r).toContain("<persisted-output>");
      expect(r).toContain("Full output:");
      expect(r.length).toBeLessThan(35_000);
    });
  });

  it(">6K tokens 完整落盘 + 引用预览（小于 30K 时不截断）", async () => {
    await runWithWorkdir(ws, async () => {
      // 'y'*25000 ≈ 7000 tokens > PERSIST_THRESHOLD(6000)；且 25000 < 30K 不触发字符截断
      const r = await executeToolCall(
        mkCall("run_bash", { command: "python3 -c \"print('y' * 25000)\"", run_in_background: false }),
      );
      expect(r).toContain("<persisted-output>");
      expect(r).toContain("Full output:");
      expect(fs.readdirSync(path.join(ws, ".task_outputs", "tool-results")).length).toBeGreaterThan(0);
    });
  });
});
