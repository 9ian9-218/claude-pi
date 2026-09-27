/**
 * permission.ts — 权限检查（对齐 src/check_permissions.py）
 *
 * 三道门权限管线：Gate 1 硬拒绝黑名单（run_bash）→ Gate 2 规则匹配
 * → Gate 3 用户确认。
 *
 * 02b：Gate 3（用户确认）未接入——规则命中直接拒绝，返回 None 表示通过。
 * 15a：TUI 权限弹窗接入 Gate 3。
 */
import { checkPath } from "./tools/path.ts";

export const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];

export interface PermissionRule {
  tools: string[];
  check: (args: Record<string, unknown>) => boolean;
  message: string;
}

function escapesWorkspace(p: unknown): boolean {
  if (typeof p !== "string") return false;
  // 与工具侧同一实现（含软链接解析）：两处各写一份会让判定悄悄分叉
  return checkPath(p) !== null;
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

/**
 * 黑名单匹配：子串命中 + 边界校验。
 *
 * 直接 includes 会把 `rm -rf /` 匹配到 `rm -rf /tmp/build`（绝对路径的删除全被
 * 误杀，且提示信息指向 `rm -rf /`，用户无法理解）。以 `/` 结尾的 pattern 要求
 * 其后不再跟路径字符，只有真正删除根目录才命中。
 */
export function checkDenyList(command: string): string | null {
  for (const pattern of DENY_LIST) {
    let from = 0;
    for (;;) {
      const at = command.indexOf(pattern, from);
      if (at < 0) break;
      const next = command[at + pattern.length];
      const endsPath = pattern.endsWith("/") && next !== undefined && /[A-Za-z0-9._~-]/.test(next);
      if (!endsPath) {
        return `Blocked: '${pattern}' is on the deny list`;
      }
      from = at + pattern.length;
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

/**
 * permission.ts — 权限规则数据（PermissionGate 的唯一规则面）
 *
 * 生产 PermissionGate 的唯一实现是 permission-sync 的 checkPermissionWithBubble
 * （按身份分流：lead 本地 askUser / subagent 同步冒泡 / teammate 邮箱冒泡），
 * 本模块只承载规则数据不承载流程。
 */
