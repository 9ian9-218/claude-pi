import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenAI } from "./helpers/mock-openai.ts";
import { PROJECT_ROOT } from "../src/config.ts";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cliEntry = path.join(PROJECT_ROOT, "src", "cli.ts");

let mock: MockOpenAI | null = null;

beforeEach(() => {
  // 隔离会话目录
  process.env.CLAUDE_PI_SESSION_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-modes-"));
});

afterEach(async () => {
  if (mock) await mock.close();
  mock = null;
});

function runCli(args: string[], input: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [tsxCli, cliEntry, ...args],
      {
        cwd: PROJECT_ROOT,
        timeout: 20000,
        env: {
          ...process.env,
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: mock!.baseUrl,
          OPENAI_MODEL: "gpt-test",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ code: (error as { code?: number }).code ?? 1, stdout, stderr });
          return;
        }
        resolve({ code: 0, stdout, stderr });
      },
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

describe("运行模式（S13）", () => {
  it("-p 打印模式：管道 stdin 合并进首轮提示，输出最终回复后退出", async () => {
    mock = await MockOpenAI.create();
    mock.always(() => ({ kind: "sse", chunks: [{ content: "这是最终回复", finishReason: "stop" }] }));
    const { code, stdout } = await runCli(["-p"], "帮我看看这个项目\n");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("这是最终回复");
    // 请求体含管道输入
    const req = mock.requests.find((r) => r.messages.some((m) => m.role === "system"));
    const user = req?.messages.filter((m) => m.role === "user").map((m) => String(m.content));
    expect(user?.some((c) => c.includes("帮我看看这个项目"))).toBe(true);
  });

  it("-p 支持工具调用序列后输出最终回复", async () => {
    mock = await MockOpenAI.create();
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            { index: 0, id: "c1", name: "glob", arguments: '{"pattern":"*.ts"}' },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "分析完成", finishReason: "stop" }] }));
    const { code, stdout } = await runCli(["-p"], "列出文件\n");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("分析完成");
  });

  it("--mode json 输出稳定结构（turns + final）", async () => {
    mock = await MockOpenAI.create();
    mock.always(() => ({ kind: "sse", chunks: [{ content: "JSON 回复", finishReason: "stop" }] }));
    const { code, stdout } = await runCli(["--mode", "json"], "结构化输出\n");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed.turns)).toBe(true);
    expect(parsed.turns[0].role).toBe("user");
    expect(parsed.turns[0].content).toContain("结构化输出");
    expect(parsed.final).toBe("JSON 回复");
  });

  it("--mode json 含工具调用记录（对拍接口）", async () => {
    mock = await MockOpenAI.create();
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            { index: 0, id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "done", finishReason: "stop" }] }));
    const { code, stdout } = await runCli(["--mode", "json"], "读文件\n");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    const assistant = parsed.turns.find((m: { role: string }) => m.role === "assistant");
    expect(assistant.tool_calls).toBeDefined();
    expect(assistant.tool_calls[0].function.name).toBe("read_file");
  });

  it("无输入时报错退出", async () => {
    mock = await MockOpenAI.create();
    const { code, stderr } = await runCli(["-p"], "");
    expect(code).toBe(1);
    expect(stderr).toContain("no input");
  });
});
