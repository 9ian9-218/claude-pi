import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { MockOpenAI } from "./helpers/mock-openai.ts";
import { PROJECT_ROOT } from "../src/config.ts";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cliEntry = path.join(PROJECT_ROOT, "src", "cli.ts");

let mock: MockOpenAI | null = null;

afterEach(async () => {
  if (mock) await mock.close();
  mock = null;
});

function runRepl(input: string, timeoutMs = 20000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [tsxCli, cliEntry],
      {
        cwd: PROJECT_ROOT,
        timeout: timeoutMs,
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

describe("REPL（S4）", () => {
  it("输入问题→流式回复可见，q 退出码 0", async () => {
    mock = await MockOpenAI.create();
    mock.always(() => ({ kind: "sse", chunks: [{ content: "Hello!", finishReason: "stop" }] }));
    const { code, stdout } = await runRepl("你好\nq\n");
    expect(code).toBe(0);
    expect(stdout).toContain("User >");
    expect(stdout).toContain("Model >");
    expect(stdout).toContain("Hello!");
  });

  it("/new 清空会话后上下文不含旧消息", async () => {
    mock = await MockOpenAI.create();
    mock.always(() => ({ kind: "sse", chunks: [{ content: "reply", finishReason: "stop" }] }));
    const { code, stdout } = await runRepl("第一轮\n/new\n第二轮\nq\n");
    expect(code).toBe(0);
    expect(stdout.match(/reply/g)?.length).toBe(2);
    // 第二次请求的上下文只含新会话内容，证明 /new 已清空
    const second = mock.requests[1];
    const userContents = second.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    expect(userContents).toEqual(["第二轮"]);
  });

  it("EOF（管道结束）退出码 0", async () => {
    mock = await MockOpenAI.create();
    const { code } = await runRepl("");
    expect(code).toBe(0);
  });

  it("exit 命令退出", async () => {
    mock = await MockOpenAI.create();
    const { code } = await runRepl("exit\n");
    expect(code).toBe(0);
  });
});
