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
  type ToolCallLike,
} from "./tool.ts";
import { runWithWorkdir } from "./workdir.ts";

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-tool-"));
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

  it("缺 required 参数报错", () => {
    expect(validateArgs({}, schema)).toContain("Missing required parameter: path");
  });

  it("额外参数报错（additionalProperties=false）", () => {
    expect(validateArgs({ path: "a", extra: 1 }, schema)).toContain(
      "Unexpected parameters: extra",
    );
  });

  it("类型不匹配报错", () => {
    expect(validateArgs({ path: "a", limit: "x" }, schema)).toContain(
      "Parameter 'limit' must be an integer",
    );
    expect(validateArgs({ path: "a", flag: "yes" }, schema)).toContain(
      "Parameter 'flag' must be a boolean",
    );
  });

  it("全部合法返回 null", () => {
    expect(validateArgs({ path: "a", limit: 3, flag: true }, schema)).toBeNull();
  });

  it("path 参数逃逸工作区报错", () => {
    expect(validateArgs({ path: "../evil" }, schema)).toContain("Path escapes workspace");
  });
});

describe("checkPath / safePath（S1）", () => {
  it("checkPath 拒绝逃逸路径，接受工作区内路径", () => {
    runWithWorkdir(ws, () => {
      expect(checkPath("a/b.txt")).toBeNull();
      expect(checkPath("..")).toContain("Path escapes workspace");
      expect(checkPath("../x")).toContain("Path escapes workspace");
      expect(checkPath("/etc/passwd")).toContain("Path escapes workspace");
    });
  });

  it("safePath 返回解析后的绝对路径，逃逸时抛错", () => {
    runWithWorkdir(ws, () => {
      expect(safePath("a.txt")).toBe(path.join(ws, "a.txt"));
      expect(() => safePath("../x")).toThrow("Path escapes workspace");
    });
  });
});

describe("内置工具执行（S1）", () => {
  it("read_file / write_file / edit_file 闭环", () => {
    runWithWorkdir(ws, () => {
      const w = executeToolCall(mkCall("write_file", { path: "a.txt", content: "hello\nworld" }));
      expect(w).toContain("Wrote 11 bytes");
      const r = executeToolCall(mkCall("read_file", { path: "a.txt" }));
      expect(r).toBe("hello\nworld");
      const e = executeToolCall(
        mkCall("edit_file", { path: "a.txt", old_text: "world", new_text: "TS" }),
      );
      expect(e).toBe("Edited a.txt");
      expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("hello\nTS");
    });
  });

  it("edit_file 文本不存在时报错", () => {
    runWithWorkdir(ws, () => {
      fs.writeFileSync(path.join(ws, "a.txt"), "x");
      const r = executeToolCall(
        mkCall("edit_file", { path: "a.txt", old_text: "nope", new_text: "y" }),
      );
      expect(r).toContain("text not found");
    });
  });

  it("read_file 不存在时报错", () => {
    runWithWorkdir(ws, () => {
      expect(executeToolCall(mkCall("read_file", { path: "missing.txt" }))).toContain("Error:");
    });
  });

  it("glob 按模式返回工作区内文件", () => {
    runWithWorkdir(ws, () => {
      fs.writeFileSync(path.join(ws, "x.ts"), "");
      fs.writeFileSync(path.join(ws, "y.md"), "");
      const r = executeToolCall(mkCall("glob", { pattern: "*.ts" }));
      expect(r).toBe("x.ts");
    });
  });

  it("run_bash 执行命令并合并输出", () => {
    runWithWorkdir(ws, () => {
      const r = executeToolCall(mkCall("run_bash", { command: "echo hi && echo err >&2", run_in_background: false }));
      expect(r).toContain("hi");
      expect(r).toContain("err");
    });
  });

  it("run_bash 无输出返回 (no output)", () => {
    runWithWorkdir(ws, () => {
      expect(executeToolCall(mkCall("run_bash", { command: "true", run_in_background: false }))).toBe(
        "(no output)",
      );
    });
  });

  it("todo_write 校验字段与状态", () => {
    runWithWorkdir(ws, () => {
      const bad = executeToolCall(
        mkCall("todo_write", { todos: [{ content: "x" }] }),
      );
      expect(bad).toContain("missing 'content' or 'status'");
      const badStatus = executeToolCall(
        mkCall("todo_write", { todos: [{ content: "x", status: "weird" }] }),
      );
      expect(badStatus).toContain("invalid status");
      const ok = executeToolCall(
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

  it("空 todos 返回 No tasks yet.（08 接入任务同步）", () => {
    runWithWorkdir(ws, () => {
      expect(executeToolCall(mkCall("todo_write", { todos: [] }))).toBe("No tasks yet.");
    });
  });
});

describe("executeToolCall 管线（S1）", () => {
  it("未知工具返回错误", () => {
    expect(executeToolCall(mkCall("ghost", {}))).toContain("Unknown tool: ghost");
  });

  it("非法 JSON 参数返回错误", () => {
    const r = executeToolCall({ function: { name: "read_file", arguments: "{bad" } });
    expect(r).toContain("Invalid arguments JSON");
  });

  it("非对象参数返回错误", () => {
    const r = executeToolCall({ function: { name: "read_file", arguments: "[1,2]" } });
    expect(r).toContain("Arguments must be a JSON object");
  });

  it("非字符串结果 JSON 序列化", () => {
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
  it("getToolParameters 返回内置工具 schema", () => {
    const schema = getToolParameters("read_file");
    expect(schema?.required).toContain("path");
    expect(getToolParameters("ghost")).toBeNull();
  });

  it("getOpenaiTools 返回 OpenAI 格式工具列表（含 strict）", () => {
    const tools = getOpenaiTools(false);
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("run_bash");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("glob");
    expect(names).toContain("todo_write");
    expect(tools.every((t) => t.function.strict === true)).toBe(true);
  });
});

function mkCall(name: string, args: Record<string, unknown>): ToolCallLike {
  return { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}
