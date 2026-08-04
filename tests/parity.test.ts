import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";

const runner = path.join(PROJECT_ROOT, "scripts", "parity", "parity-runner.ts");
const tsxCli = path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function pythonAvailable(): boolean {
  try {
    execFileSync("python3", ["-c", "import openai"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("对拍测试（S18）", () => {
  const hasPython = pythonAvailable();
  it.skipIf(!hasPython)("场景：对话 + 工具调用（Python REPL vs --mode json）", async () => {
    const result = execFileSync(process.execPath, [tsxCli, runner], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result).toContain("2 通过");
    expect(result).not.toContain("失败");
  }, 130_000);
});
