import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenAI } from "./helpers/mock-openai.ts";
import { createTestAgentDir } from "./helpers/test-client.ts";
import { PROJECT_ROOT } from "../src/config.ts";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cliEntry = path.join(PROJECT_ROOT, "src", "cli.ts");

let mock: MockOpenAI | null = null;
let workdirs: string[] = [];
let agentDirs: string[] = [];

beforeEach(() => {
  workdirs = [];
  agentDirs = [];
});

afterEach(async () => {
  if (mock) await mock.close();
  mock = null;
  for (const d of workdirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  for (const d of agentDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function runRepl(input: string, timeoutMs = 20000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // 每个测试独立临时 cwd：会话按 cwd 组织，天然隔离
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-repl-"));
    workdirs.push(workdir);
    const child = execFile(
      process.execPath,
      [tsxCli, cliEntry],
      {
        cwd: workdir,
        timeout: timeoutMs,
        env: {
          ...process.env,
          // 临时 pi 配置目录（models.json 指向 mock server）
          PI_CODING_AGENT_DIR: createTestAgentDir(mock!.baseUrl),
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

describe("REPL（S4）", () => {
  it("输入问题→流式回复可见，q 退出码 0", { timeout: 30_000 }, async () => {
    mock = await MockOpenAI.create();
    mock.always(() => ({ kind: "sse", chunks: [{ content: "Hello!", finishReason: "stop" }] }));
    const { code, stdout } = await runRepl("你好\nq\n");
    expect(code).toBe(0);
    expect(stdout).toContain("User >");
    expect(stdout).toContain("Model >");
    expect(stdout).toContain("Hello!");
  });

  it("/new 清空会话后上下文不含旧消息", { timeout: 30_000 }, async () => {
    mock = await MockOpenAI.create();
    mock.always(() => ({ kind: "sse", chunks: [{ content: "reply", finishReason: "stop" }] }));
    const { code, stdout } = await runRepl("第一轮\n/new\n第二轮\nq\n");
    expect(code).toBe(0);
    expect(stdout.match(/reply/g)?.length).toBe(2);
    // 找到含 "第二轮" 的主调用请求，验证上下文不含旧消息（/new 已清空）
    const second = mock.requests.find((r) =>
      r.messages.some((m) => m.role === "user" && m.content === "第二轮"),
    );
    expect(second).toBeDefined();
    const userContents = second!.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    expect(userContents).toContain("第二轮");
    // /new 后上下文不含旧会话消息
    expect(userContents.some((c) => c === "第一轮")).toBe(false);
    expect(userContents.some((c) => c === "你好")).toBe(false);
  });

  it("EOF（管道结束）退出码 0", { timeout: 30_000 }, async () => {
    mock = await MockOpenAI.create();
    const { code } = await runRepl("");
    expect(code).toBe(0);
  });

  it("exit 命令退出", { timeout: 30_000 }, async () => {
    mock = await MockOpenAI.create();
    const { code } = await runRepl("exit\n");
    expect(code).toBe(0);
  });
});
