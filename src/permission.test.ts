import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkDenyList,
  checkRules,
  checkPermission,
  DENY_LIST,
} from "./permission.ts";
import { runWithWorkdir } from "./workdir.ts";

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-perm-"));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("checkDenyList（S2）", () => {
  it("黑名单模式命中返回拒绝原因", () => {
    for (const pattern of DENY_LIST) {
      const reason = checkDenyList(`echo x && ${pattern}`);
      expect(reason).not.toBeNull();
      expect(reason).toContain("deny list");
    }
  });

  it("普通命令通过", () => {
    expect(checkDenyList("ls -la")).toBeNull();
  });
});

describe("checkRules（S2）", () => {
  it("write/edit 逃逸工作区触发规则", () => {
    runWithWorkdir(ws, () => {
      expect(checkRules("write_file", { path: "../evil.txt", content: "x" })).toContain(
        "Writing outside workspace",
      );
      expect(checkRules("edit_file", { path: "../evil.txt" })).toContain(
        "Writing outside workspace",
      );
      expect(checkRules("write_file", { path: "ok.txt", content: "x" })).toBeNull();
    });
  });

  it("run_bash 危险命令触发规则", () => {
    expect(checkRules("run_bash", { command: "rm -rf build" })).toContain(
      "Potentially destructive command",
    );
    expect(checkRules("run_bash", { command: "echo hi" })).toBeNull();
  });

  it("read_file 敏感文件触发规则", () => {
    expect(checkRules("read_file", { path: ".env" })).toContain(
      "Reading potentially sensitive file",
    );
    expect(checkRules("read_file", { path: "src/index.ts" })).toBeNull();
  });
});

describe("checkPermission 管线（S2，02b：规则命中直接拒绝）", () => {
  it("run_bash 黑名单命令被拒", () => {
    expect(checkPermission("run_bash", { command: "sudo apt install x" })).toContain(
      "deny list",
    );
  });

  it("规则命中被拒（15a 前为直接拒绝）", () => {
    expect(checkPermission("write_file", { path: "../evil", content: "x" })).toContain(
      "Permission denied",
    );
  });

  it("安全操作通过返回 null", () => {
    runWithWorkdir(ws, () => {
      expect(checkPermission("read_file", { path: "src/index.ts" })).toBeNull();
      expect(checkPermission("run_bash", { command: "ls" })).toBeNull();
    });
  });
});
