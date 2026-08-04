/**
 * permission.ts — 权限检查（对齐 src/check_permissions.py）
 *
 * 三道门权限管线：Gate 1 硬拒绝黑名单（run_bash）→ Gate 2 规则匹配
 * → Gate 3 用户确认。
 *
 * 02b：Gate 3（用户确认）未接入——规则命中直接拒绝，返回 None 表示通过。
 * 15a：TUI 权限弹窗接入 Gate 3。
 */
import path from "node:path";
import { getWorkdir } from "./workdir.ts";

export const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];

export interface PermissionRule {
  tools: string[];
  check: (args: Record<string, unknown>) => boolean;
  message: string;
}

function escapesWorkspace(p: unknown): boolean {
  if (typeof p !== "string") return false;
  const wd = path.resolve(getWorkdir());
  const target = path.resolve(wd, p);
  return target !== wd && !target.startsWith(wd + path.sep);
}

export const PERMISSION_RULES: PermissionRule[] = [
  {
    tools: ["write_file", "edit_file"],
    check: (args) => escapesWorkspace(args["path"]),
    message: "Writing outside workspace",
  },
  {
    tools: ["run_bash"],
    check: (args) => {
      const cmd = typeof args["command"] === "string" ? args["command"] : "";
      return ["rm ", "> /etc/", "chmod 777"].some((kw) => cmd.includes(kw));
    },
    message: "Potentially destructive command",
  },
  {
    tools: ["read_file"],
    check: (args) => {
      const p = typeof args["path"] === "string" ? args["path"] : "";
      return [".env", "credentials", "secret", "token"].some((s) => p.includes(s));
    },
    message: "Reading potentially sensitive file",
  },
];

export function checkDenyList(command: string): string | null {
  for (const pattern of DENY_LIST) {
    if (command.includes(pattern)) {
      return `Blocked: '${pattern}' is on the deny list`;
    }
  }
  return null;
}

export function checkRules(toolName: string, args: Record<string, unknown>): string | null {
  for (const rule of PERMISSION_RULES) {
    if (rule.tools.includes(toolName) && rule.check(args)) {
      return rule.message;
    }
  }
  return null;
}

/** Gate 3：用户确认（15a 接入 TUI 弹窗；02b 默认拒绝） */
export function askUser(toolName: string, args: Record<string, unknown>, reason: string): "allow" | "deny" {
  console.log(`\n\x1b[33m⚠  ${reason}\x1b[0m`);
  console.log(`   Tool: ${toolName}(${JSON.stringify(args)})`);
  return "deny";
}

/** 三道门权限管线：返回 null 通过，返回字符串拒绝原因 */
export function checkPermission(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === "run_bash") {
    const reason = checkDenyList(typeof args["command"] === "string" ? args["command"] : "");
    if (reason) {
      console.log(`\n\x1b[31m⛔ ${reason}\x1b[0m`);
      return reason;
    }
  }

  const reason = checkRules(toolName, args);
  if (reason) {
    const decision = askUser(toolName, args, reason);
    if (decision === "deny") {
      return `Permission denied: ${reason}`;
    }
  }
  return null;
}

/** PreToolUse hook：block 需含 name 与 input */
export function permissionHook(block: { name: string; input: Record<string, unknown> }): string | null {
  return checkPermission(block.name, block.input);
}
