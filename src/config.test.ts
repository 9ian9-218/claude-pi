import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROJECT_ROOT,
  resolveAgentDirs,
  ensureAgentDirs,
  loadEnvFile,
} from "./config.ts";

const originalEnv = { ...process.env };

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-config-"));
}

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("resolveAgentDirs", () => {
  it("把 .agent 数据根解析到给定根目录下", () => {
    const root = makeTmpRoot();
    const dirs = resolveAgentDirs(root);
    expect(dirs.agentsDir).toBe(path.join(root, ".agent"));
    expect(dirs.teamsDir).toBe(path.join(root, ".agent", "teams"));
    expect(dirs.memoryDir).toBe(path.join(root, ".agent", "memory"));
    expect(dirs.tasksDir).toBe(path.join(root, ".agent", "tasks"));
    expect(dirs.skillsDir).toBe(path.join(root, ".agent", "skills"));
    expect(dirs.worktreesDir).toBe(path.join(root, ".agent", "worktrees"));
    expect(dirs.sessionsDir).toBe(path.join(root, ".agent", "sessions"));
    expect(dirs.extensionsDir).toBe(path.join(root, ".agent", "extensions"));
  });

  it("PROJECT_ROOT 指向仓库根（含 package.json）", () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, "package.json"))).toBe(true);
  });
});

describe("ensureAgentDirs", () => {
  it("创建 .agent 数据根下全部目录", () => {
    const root = makeTmpRoot();
    const dirs = ensureAgentDirs(root);
    for (const d of Object.values(dirs)) {
      expect(fs.statSync(d).isDirectory()).toBe(true);
    }
  });

  it("重复调用幂等", () => {
    const root = makeTmpRoot();
    ensureAgentDirs(root);
    expect(() => ensureAgentDirs(root)).not.toThrow();
  });
});

describe("loadEnvFile", () => {
  it("从指定根的 .env 加载变量", () => {
    const root = makeTmpRoot();
    fs.writeFileSync(
      path.join(root, ".env"),
      "OPENAI_BASE_URL=https://example.com/v1\nOPENAI_MODEL=gpt-test\n",
    );
    loadEnvFile(root);
    expect(process.env.OPENAI_BASE_URL).toBe("https://example.com/v1");
    expect(process.env.OPENAI_MODEL).toBe("gpt-test");
  });

  it("缺 .env 文件时不抛错", () => {
    const root = makeTmpRoot();
    expect(() => loadEnvFile(root)).not.toThrow();
  });
});
