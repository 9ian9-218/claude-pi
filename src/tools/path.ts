/**
 * path.ts — 路径校验（从 tool.ts 拆出）
 * 检查路径是否在工作区内；safePath 解析并抛错。
 */
import fs from "node:fs";
import path from "node:path";
import { getWorkdir } from "../workdir.ts";

// ── 路径校验 ──────────────────────────────────────────────────────────────

/**
 * 解析软链接后的绝对路径。
 * 目标可能尚不存在（新建文件），故逐级向上找最近的存在祖先做 realpath，再拼回剩余段。
 */
export function realpathDeep(target: string): string {
  const rest: string[] = [];
  let cur = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.slice().reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return target;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * 检查路径是否在工作区内，返回错误信息或 null。
 * 走 realpath：纯词法比较会被工作区内的软链接绕过（指向 /etc/passwd 的链接词法上仍在工作区内）。
 */
export function checkPath(p: string): string | null {
  const wd = realpathDeep(path.resolve(getWorkdir()));
  const target = realpathDeep(path.resolve(wd, p));
  if (target !== wd && !target.startsWith(wd + path.sep)) {
    return `Path escapes workspace: ${p}`;
  }
  return null;
}

/** 解析并返回工作区内安全路径（逃逸时抛错） */
export function safePath(p: string): string {
  const err = checkPath(p);
  if (err !== null) throw new Error(err);
  return path.resolve(getWorkdir(), p);
}

// ── run_bash ──────────────────────────────────────────────────────────────
