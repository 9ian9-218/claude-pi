import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTeamMode, setTeamMode, isMemoryEnabled, writePiSettings, resetSettingsCache, readPiSettings } from "./settings.ts";

let dir: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-settings-"));
  prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = dir;
  resetSettingsCache();
});

afterEach(() => {
  if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
  resetSettingsCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

const settingsPath = () => path.join(dir, "settings.json");

describe("设置读写往返", () => {
  it("team.mode 写入后能读回（此前读侧漏解析，开关是死的）", () => {
    setTeamMode("free");
    expect(getTeamMode()).toBe("free");
    setTeamMode("pipeline");
    expect(getTeamMode()).toBe("pipeline");
  });

  it("memory.enabled 写入后能读回", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({ memory: { enabled: false } }));
    resetSettingsCache();
    expect(isMemoryEnabled()).toBe(false);
  });

  it("写入其他设置不会抹掉 team/memory（手写解析器只认识已知键）", () => {
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ team: { mode: "free" }, memory: { enabled: false } }),
    );
    resetSettingsCache();
    expect(writePiSettings({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } })).toBe(true);
    const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
    expect(raw["team"]).toEqual({ mode: "free" });
    expect(raw["memory"]).toEqual({ enabled: false });
  });

  it("损坏的 settings.json 不阻断读取（走默认值）", () => {
    fs.writeFileSync(settingsPath(), "{ 不是 JSON");
    resetSettingsCache();
    expect(getTeamMode()).toBe("pipeline");
    expect(readPiSettings().retry.enabled).toBe(true);
  });
});