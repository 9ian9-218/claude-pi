import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cliEntry = path.join(PROJECT_ROOT, "src", "cli.ts");

/**
 * 测试用的隔离配置目录：CLI 路径在 REPL/TUI 启动后会做模型目录自动刷新，
 * 若不隔离就会读写真实 ~/.claude-pi 并向 pi.dev 发包。PI_OFFLINE=1 关掉网络。
 */
const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-cli-agent-"));

function runCli(args: string[], timeoutMs = 15000, input = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [tsxCli, cliEntry, ...args],
      {
        cwd: PROJECT_ROOT,
        timeout: timeoutMs,
        env: { ...process.env, PI_CODING_AGENT_DIR: testAgentDir, PI_OFFLINE: "1" },
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code !== undefined && !("signal" in error)) {
          // execFile 以非零码退出也进入 error 分支
          resolve({ code: (error as { code?: number }).code ?? 1, stdout, stderr });
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        resolve({ code: 0, stdout, stderr });
      },
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

describe("CLI 入口（S3）", () => {
  it("--version 输出版本号（与 package.json 一致）", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
    const { code, stdout } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it("无参数启动打印 banner 并退出码 0（EOF 退出 REPL）", async () => {
    const { code, stdout } = await runCli([], 15000, "q\n");
    expect(code).toBe(0);
    expect(stdout).toContain("claude-pi");
  });

  it("启动时创建 .agent 数据根目录树", async () => {
    await runCli(["--version"]);
    const dirs = [".agent", ".agent/sessions", ".agent/teams", ".agent/extensions"];
    for (const d of dirs) {
      expect(fs.statSync(path.join(PROJECT_ROOT, d)).isDirectory()).toBe(true);
    }
  });

  it(
    "--refresh-models：离线模式不发网络请求，报告前后模型数并退出 0",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-models-"));
      fs.writeFileSync(path.join(dir, "models.json"), '{"providers":{}}');
      fs.writeFileSync(path.join(dir, "settings.json"), "{}");
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const child = execFile(
          process.execPath,
          [tsxCli, cliEntry, "--refresh-models"],
          {
            cwd: PROJECT_ROOT,
            timeout: 30000,
            // PI_OFFLINE 保证测试不触网；临时配置目录避免动到真实 store
            env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1" },
          },
          (error, stdout, stderr) => {
            resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
          },
        );
        child.stdin?.end();
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("离线模式");
      expect(result.stderr).toMatch(/可用模型 \d+ → \d+/);
      // 脚本接口契约：该输出不得污染 stdout
      expect(result.stdout).toBe("");
      fs.rmSync(dir, { recursive: true, force: true });
    },
    40000,
  );
});

describe("分发与崩溃兜底（隐患 04/05）", () => {
  it(
    "bin shim：node 直接跑 bin/cpi.js --version（tsx 在 dependencies）",
    async () => {
    const binPath = path.join(PROJECT_ROOT, "bin", "cpi.js");
    const { code, stdout } = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        const child = execFile(
          process.execPath,
          [binPath, "--version"],
          { cwd: PROJECT_ROOT, timeout: 15000 },
          (error, stdout, stderr) => {
            resolve({ code: error ? (error as { code?: number }).code ?? 0 : 0, stdout, stderr });
          },
        );
        child.stdin?.end();
      },
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
    expect(pkg.bin.cpi).toBe("bin/cpi.js");
    expect(pkg.dependencies.tsx).toBeDefined(); // tsx 运行时依赖（原在 devDependencies）
    },
    30000,
  );

  it(
    "fatal 兜底：未捕获异常 → 提示 + 退出码 1（不静默退出）",
    async () => {
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "claude-pi-fatal-"));
    const script = path.join(dir, "boom.ts");
    fs.writeFileSync(
      script,
      [
        'import { installFatalHandlers } from "/home/z9ian9/myproject/claude-pi/src/fatal.ts";',
        "installFatalHandlers();",
        'setTimeout(() => { throw new Error("boom-test"); }, 20);',
      ].join("\n"),
    );
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        const child = execFile(
          process.execPath,
          [tsxCli, script],
          { cwd: PROJECT_ROOT, timeout: 15000 },
          (error, stdout, stderr) => {
            resolve({ code: error ? (error as { code?: number }).code ?? 0 : 0, stdout, stderr });
          },
        );
        child.stdin?.end();
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("boom-test");
    expect(result.stderr).toContain("uncaughtException");
    fs.rmSync(dir, { recursive: true, force: true });
    },
    30000,
  );
});
