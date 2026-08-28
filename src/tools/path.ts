/**
 * path.ts — 路径校验（从 tool.ts 拆出）
 * 检查路径是否在工作区内；safePath 解析并抛错。
 */
import path from "node:path";
import { getWorkdir } from "../workdir.ts";

// ── 路径校验 ──────────────────────────────────────────────────────────────

/** 检查路径是否在工作区内，返回错误信息或 null */
export function checkPath(p: string): string | null {
  const wd = path.resolve(getWorkdir());
  const target = path.resolve(wd, p);
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
