import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cliEntry = path.join(PROJECT_ROOT, "src", "cli.ts");

function runCli(args: string[], timeoutMs = 15000, input = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [tsxCli, cliEntry, ...args],
      { cwd: PROJECT_ROOT, timeout: timeoutMs },
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
