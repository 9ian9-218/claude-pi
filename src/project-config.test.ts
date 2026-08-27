/**
 * project-config.test.ts — 项目级配置（.agent/config.json）读写
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setProjectConfigRootForTest,
  readProjectConfig,
  writeProjectConfig,
  getExportMode,
  ExportMode,
} from "./project-config.ts";

describe("project-config", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-projcfg-"));
    setProjectConfigRootForTest(tmp);
  });

  afterEach(() => {
    setProjectConfigRootForTest(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("默认导出模式为 analysis（缺文件时）", () => {
    expect(readProjectConfig()).toEqual({});
    expect(getExportMode()).toBe("analysis");
  });

  it("writeProjectConfig 合并写入并回读", () => {
    writeProjectConfig({ export: { mode: "portable" } });
    const cfg = readProjectConfig();
    expect(cfg.export?.mode).toBe("portable");
    expect(getExportMode()).toBe("portable");
  });

  it("写入保留既有键（部分合并）", () => {
    writeProjectConfig({ export: { mode: "portable" } });
    writeProjectConfig({ foo: { bar: 1 } });
    const cfg = readProjectConfig();
    expect(cfg.export?.mode).toBe("portable");
    expect((cfg.foo as { bar: number }).bar).toBe(1);
  });

  it("非法导出模式回退默认 analysis", () => {
    // 直接写坏配置（绕过类型检查）：防御运行时损坏/手改文件
    fs.mkdirSync(path.join(tmp, ".agent"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".agent", "config.json"), JSON.stringify({ export: { mode: "bogus" } }));
    expect(getExportMode()).toBe("analysis" satisfies ExportMode);
  });

  it("损坏的配置文件回退默认且不抛错", () => {
    fs.mkdirSync(path.join(tmp, ".agent"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".agent", "config.json"), "{ not json");
    expect(readProjectConfig()).toEqual({});
    expect(getExportMode()).toBe("analysis");
  });
});