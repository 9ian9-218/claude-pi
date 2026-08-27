/**
 * settings-independent.test.ts — cpi 独立配置（不再与 pi 共享 ~/.pi/agent）
 *
 * 全局配置目录改为 ~/.claude-pi（PI_CODING_AGENT_DIR 仍可覆盖）；
 * 支持写入 settings.json；提供从 ~/.pi/agent 的一次性迁移。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAgentDir,
  readPiSettings,
  writePiSettings,
  migrateFromPi,
  migrateNeeded,
  resetSettingsCache,
} from "./settings.ts";

const ORIG_ENV = process.env.PI_CODING_AGENT_DIR;

describe("settings 独立配置", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-settings-"));
    process.env.PI_CODING_AGENT_DIR = tmp;
  });

  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = ORIG_ENV;
    resetSettingsCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("无 env 覆盖时默认配置目录为 ~/.claude-pi（不再指向 ~/.pi/agent）", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    expect(getAgentDir()).toBe(path.join(os.homedir(), ".claude-pi"));
  });

  it("readPiSettings 从独立目录读取（不再读 ~/.pi/agent）", () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "settings.json"),
      JSON.stringify({ retry: { enabled: false, maxRetries: 5 }, defaultModel: "openai/gpt-4o" }),
    );
    const s = readPiSettings();
    expect(s.retry.enabled).toBe(false);
    expect(s.retry.maxRetries).toBe(5);
    expect(s.defaultModel).toBe("openai/gpt-4o");
  });

  it("writePiSettings 合并写盘并可回读（保留既有键）", () => {
    writePiSettings({ retry: { enabled: false } } as never);
    writePiSettings({ defaultModel: "deepseek/deepseek-chat" } as never);
    const s = readPiSettings();
    expect(s.retry.enabled).toBe(false);
    expect(s.defaultModel).toBe("deepseek/deepseek-chat");
  });

  it("migrateNeeded：旧 ~/.pi/agent 有配置且新位置缺失时为 true，复制后为 false", () => {
    // 模拟旧 pi 目录（用第二个临时目录替代 ~/.pi/agent，避免碰真实主目录）
    const oldDir = path.join(tmp, "..", "pi-agent-fake");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "auth.json"), '{"key":"x"}');
    fs.writeFileSync(path.join(oldDir, "models.json"), "{}");
    fs.writeFileSync(path.join(oldDir, "settings.json"), '{"retry":{}}');
    const res = migrateFromPi(oldDir);
    expect(res).toBe(true);
    expect(fs.existsSync(path.join(tmp, "auth.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "models.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "settings.json"))).toBe(true);
    // 文件已存在 → 不再需要迁移
    expect(migrateNeeded(oldDir, tmp)).toBe(false);
    fs.rmSync(oldDir, { recursive: true, force: true });
  });
});