/**
 * session-import.ts — 会话导入（/import 命令的实现层）
 *
 * 读取外部会话 JSONL（portable 导出 / pi exportToJsonl 形状），校验 header
 * 后复制到当前项目的会话目录并打开——继续对话落在副本上，不污染源文件。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager, defaultSessionDir } from "./session-manager.ts";

export class SessionImportError extends Error {}

interface ImportableHeader {
  type: string;
  version: number;
  id: string;
  timestamp?: string;
  cwd?: string;
}

/** 校验并解析导入文件 header；非法抛 SessionImportError */
function parseImportableHeader(filePath: string): ImportableHeader {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new SessionImportError(`文件不存在或不可读：${filePath}`);
  }
  const firstLine = raw.split("\n").find((l) => l.trim());
  if (!firstLine) {
    throw new SessionImportError(`不是有效的会话文件（空文件）：${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    throw new SessionImportError(`不是有效的会话文件（header 非 JSON）：${filePath}`);
  }
  const h = parsed as ImportableHeader;
  if (!h || typeof h !== "object" || h.type !== "session") {
    throw new SessionImportError(`不是有效的会话文件（缺少 session header）：${filePath}`);
  }
  if (typeof h.version !== "number" || typeof h.id !== "string" || !h.id) {
    throw new SessionImportError(`不是有效的会话文件（header 字段不完整）：${filePath}`);
  }
  return h;
}

/** 当前项目会话目录（对齐 session-manager 内部布局 --<cwd 替换>--） */
function sessionsDirFor(cwd: string): string {
  const dirName = `--${cwd.replace(/\//g, "-")}--`;
  return path.join(defaultSessionDir(), dirName);
}

/**
 * 导入会话：校验文件 → 复制到当前项目会话目录 → 打开。
 * 返回导入后的 SessionManager；失败抛 SessionImportError。
 */
export function importSessionFromJsonl(filePath: string, cwd: string): SessionManager {
  parseImportableHeader(filePath);
  const dir = sessionsDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${Math.trunc(Date.now() / 1000)}_${randomUUID()}.jsonl`);
  fs.copyFileSync(filePath, target);
  return SessionManager.open(target);
}