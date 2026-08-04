import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOOKS,
  triggerHooks,
  installBuiltinHooks,
  validateHook,
  logHook,
  largeOutputHook,
} from "./hook.ts";
import { permissionHook } from "./permission.ts";
import { runWithWorkdir } from "./workdir.ts";

let ws: string;
const logs: string[] = [];
const originalLog = console.log;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-hook-"));
  installBuiltinHooks();
  logs.length = 0;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  console.log = originalLog;
});

describe("PreToolUse 挂载（S3）", () => {
  it("事件顺序：validate → permission → log", () => {
    const names = HOOKS["PreToolUse"].map((h) => h.name);
    expect(names).toEqual(["validateHook", "permissionHook", "logHook"]);
  });

  it("未知工具被 validate 阻断（短路，log 不执行）", () => {
    const result = triggerHooks("PreToolUse", { name: "ghost", input: {} });
    expect(result).toBe("Unknown tool: ghost");
    expect(logs.some((l) => l.includes("[HOOK] ghost"))).toBe(false);
  });

  it("schema 校验失败阻断", () => {
    const result = triggerHooks("PreToolUse", { name: "read_file", input: {} });
    expect(String(result)).toContain("Missing required parameter: path");
  });

  it("黑名单命令被 permission 阻断", () => {
    const result = triggerHooks("PreToolUse", {
      name: "run_bash",
      input: { command: "sudo apt update", run_in_background: false },
    });
    expect(String(result)).toContain("deny list");
  });

  it("规则命中被 permission 阻断（validate 先行通过后）", () => {
    const result = triggerHooks("PreToolUse", {
      name: "run_bash",
      input: { command: "rm -rf build", run_in_background: false },
    });
    expect(String(result)).toContain("Permission denied");
    expect(String(result)).toContain("Potentially destructive command");
  });

  it("安全调用通过（返回 undefined），log 执行", () => {
    runWithWorkdir(ws, () => {
      fs.writeFileSync(path.join(ws, "a.txt"), "x");
      const result = triggerHooks("PreToolUse", { name: "read_file", input: { path: "a.txt" } });
      expect(result).toBeUndefined();
      expect(logs.some((l) => l.includes("[HOOK] read_file(...)"))).toBe(true);
    });
  });
});

describe("PostToolUse 挂载（S3）", () => {
  it("超 100k 输出触发大输出告警", () => {
    triggerHooks("PostToolUse", { name: "read_file", input: {} }, "x".repeat(100_001));
    expect(logs.some((l) => l.includes("Large output from read_file"))).toBe(true);
  });

  it("小输出无告警", () => {
    triggerHooks("PostToolUse", { name: "read_file", input: {} }, "small");
    expect(logs.some((l) => l.includes("Large output"))).toBe(false);
  });
});

describe("内置 hook 单元（S3）", () => {
  it("validateHook 对合法调用返回 null", () => {
    runWithWorkdir(ws, () => {
      expect(validateHook({ name: "glob", input: { pattern: "*.ts" } })).toBeNull();
    });
  });

  it("permissionHook 转发 checkPermission 语义", () => {
    expect(
      permissionHook({ name: "run_bash", input: { command: "reboot", run_in_background: false } }),
    ).toContain("deny list");
    expect(
      permissionHook({ name: "run_bash", input: { command: "rm -rf build", run_in_background: false } }),
    ).toContain("Permission denied");
  });

  it("logHook 打印 [HOOK] 前缀", () => {
    logHook({ name: "run_bash", input: {} });
    expect(logs.some((l) => l.includes("[HOOK] run_bash(...)"))).toBe(true);
  });

  it("largeOutputHook 单元行为", () => {
    largeOutputHook({ name: "x", input: {} }, "y".repeat(200_000));
    expect(logs.some((l) => l.includes("Large output from x"))).toBe(true);
  });
});
