import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkDenyList,
  checkRules,
  DENY_LIST,
} from "./permission.ts";
import { permissionHookWithBubble } from "./permission-sync.ts";
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

  it("删除绝对路径子目录不误判为 `rm -rf /`", () => {
    // 回归：子串匹配曾把任何绝对路径删除都报成 "'rm -rf /' is on the deny list"
    expect(checkDenyList("rm -rf /tmp/build-cache")).toBeNull();
    expect(checkDenyList("rm -rf /home/user/out")).toBeNull();
    expect(checkDenyList("rm -rf /")).toContain("deny list");
    expect(checkDenyList("rm -rf / ; echo done")).toContain("deny list");
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

describe("PermissionGate 管线（唯一实现 checkPermissionWithBubble）", () => {
  it("run_bash 黑名单命令被拒（Gate1 不弹 askUser）", async () => {
    expect(
      await permissionHookWithBubble({ name: "run_bash", input: { command: "sudo apt install x" } }),
    ).toContain("deny list");
  });

  it("规则命中 → 默认 askUserImpl 拒绝（Gate2+3）", async () => {
    expect(
      await permissionHookWithBubble({ name: "write_file", input: { path: "../evil", content: "x" } }),
    ).toContain("Permission denied");
  });

  it("安全操作通过返回 null", async () => {
    await runWithWorkdir(ws, async () => {
      expect(
        await permissionHookWithBubble({ name: "read_file", input: { path: "src/index.ts" } }),
      ).toBeNull();
      expect(
        await permissionHookWithBubble({ name: "run_bash", input: { command: "ls" } }),
      ).toBeNull();
    });
  });
});
