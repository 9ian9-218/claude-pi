import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cliEntry = path.join(PROJECT_ROOT, "src", "cli.ts");

function runCli(args: string[], timeoutMs = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
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
  });
}

describe("CLI 入口（S3）", () => {
  it("--version 输出版本号（与 package.json 一致）", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
    const { code, stdout } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it("无参数启动打印 banner 并退出码 0", async () => {
    const { code, stdout } = await runCli([]);
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
