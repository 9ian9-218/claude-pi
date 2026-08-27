/**
 * session-export.ts — 会话导出（/export 命令的实现层）
 *
 * 双模式：
 * - analysis（测试/分析）：导出整棵会话树为 JSONL 事件流（meta 首行 +
 *   每 entry 一行事件 {type,id,parentId,time,data}），message 带运行时
 *   补记的 durationMs/usage/toolError，大输出从 .task_outputs 合并全文，
 *   旧会话无 durationMs 时按相邻 entry 时间差推导 inferred。
 * - portable（会话移植）：仅导出当前活动分支，pi exportToJsonl 式线性化
 *   JSONL（header + 链式 parentId），剥离全部性能字段，供 /import 读取。
 */
import fs from "node:fs";
import path from "node:path";
import { AGENT_ROOT } from "./config.ts";
import type { SessionManager, SessionEntry } from "./session-manager.ts";
import type { ChatMessage } from "./client.ts";
import { computeUsageTotals } from "./usage-stats.ts";
import type { ExportMode } from "./project-config.ts";

export const TRACE_FORMAT = "cpi-trace";
export const TRACE_VERSION = 1;

// ── 参数解析（TUI /export 复用）──────────────────────────────────────────

export interface ExportArgs {
  mode?: ExportMode;
  path?: string;
}

/** 解析 /export 参数：--analysis|--portable（临时覆盖设置）+ 可选输出路径 */
export function parseExportArgs(rest: string): ExportArgs {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const args: ExportArgs = {};
  for (const t of tokens) {
    if (t === "--analysis") args.mode = "analysis";
    else if (t === "--portable") args.mode = "portable";
    else if (!args.path) args.path = t;
  }
  return args;
}

/** analysis 默认路径：.agent/exports/trace-<sessionId>-<ts>.jsonl */
export function analysisDefaultPath(sessionId: string): string {
  const dir = path.join(AGENT_ROOT, ".agent", "exports");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `trace-${sessionId}-${Math.trunc(Date.now() / 1000)}.jsonl`);
}

/** portable 默认路径（对齐 pi exportSessionToJsonl）：cwd/session-<ISO替换>.jsonl */
export function portableDefaultPath(cwd: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(cwd, `session-${stamp}.jsonl`);
}

// ── 大输出合并（analysis）─────────────────────────────────────────────────

const PERSISTED_RE =
  /<persisted-output>\nFull output: (.+)\nPreview:\n[\s\S]*?<\/persisted-output>/g;

/**
 * 把工具输出中的 <persisted-output> 预览引用替换为 .task_outputs 中的全文
 * （引用文件缺失时保留原文，不抛错）。
 */
export function expandPersistedOutputs(content: string): string {
  return content.replace(PERSISTED_RE, (_whole, filePath: string) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return _whole;
    }
  });
}

// ── analysis：整树事件流 ─────────────────────────────────────────────────

interface TraceEventData {
  [key: string]: unknown;
}

function messageData(msg: ChatMessage, entry: SessionMessageEntryLike): TraceEventData {
  const d: TraceEventData = { role: msg.role };
  if (msg.content !== undefined && msg.content !== null) {
    d.content = expandPersistedOutputs(String(msg.content));
  }
  if (msg.tool_calls) d.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) d.tool_call_id = msg.tool_call_id;
  if (msg.usage) d.usage = msg.usage;
  const m = msg as ChatMessage & { durationMs?: number; toolError?: boolean };
  if (typeof m.durationMs === "number") d.durationMs = m.durationMs;
  if (m.toolError === true) d.toolError = true;
  if (typeof (msg as { durationMsInferred?: number }).durationMsInferred === "number") {
    d.durationMsInferred = (msg as { durationMsInferred?: number }).durationMsInferred;
  }
  return d;
}

interface SessionMessageEntryLike {
  message: ChatMessage;
}

function eventLine(entry: SessionEntry, inferredDurationMs?: number): object {
  const time = Date.parse(entry.timestamp) || 0;
  const base = { type: entry.type, id: entry.id, parentId: entry.parentId, time };
  switch (entry.type) {
    case "message": {
      const msg = (entry as SessionMessageEntryLike).message;
      const data = messageData(msg, entry);
      if (inferredDurationMs !== undefined) {
        data.durationMsInferred = Math.max(0, inferredDurationMs);
      }
      return { ...base, data };
    }
    case "compaction": {
      const c = entry as {
        summary: string;
        tokensBefore: number;
        retainedTail?: ChatMessage[];
        usage?: unknown;
      };
      return {
        ...base,
        data: {
          summary: c.summary,
          tokensBefore: c.tokensBefore,
          ...(c.retainedTail ? { retainedTail: c.retainedTail.map((m) => stripPerf(m)) } : {}),
          ...(c.usage ? { usage: c.usage } : {}),
        },
      };
    }
    case "branch_summary":
    case "model_change":
    case "thinking_change":
    case "session_info":
    case "label": {
      const rec = { ...(entry as unknown as Record<string, unknown>) };
      delete rec.id;
      delete rec.parentId;
      delete rec.timestamp;
      delete rec.type;
      return { ...base, data: rec };
    }
    case "custom": {
      const c = entry as { customType: string; data?: unknown };
      return {
        ...base,
        data: {
          customType: c.customType,
          ...(c.data !== undefined ? { data: c.data } : {}),
        },
      };
    }
    default:
      return base;
  }
}

/** 导出整树 analysis trace，返回输出路径 */
export function exportSessionToAnalysisTrace(session: SessionManager, outputPath?: string): string {
  const entries = session.getEntries();
  const header = session.getHeader();
  const path_ = outputPath ?? analysisDefaultPath(session.getSessionId());
  const usageTotals = computeUsageTotals(entries);
  const lines: string[] = [
    JSON.stringify({
      type: "meta",
      tool: TRACE_FORMAT,
      format: "analysis",
      version: TRACE_VERSION,
      sessionId: header.id,
      cwd: header.cwd,
      createdAt: header.timestamp,
      ...(header.parentSession ? { parentSession: header.parentSession } : {}),
      entryCount: entries.length,
      usageTotals,
    }),
  ];
  for (let i = 0; i < entries.length; i++) {
    // 旧会话回退：message 无 durationMs 时按与下一 entry 的时间差推导
    let inferred: number | undefined;
    const e = entries[i];
    if (e.type === "message") {
      const m = (e as SessionMessageEntryLike).message as ChatMessage & {
        durationMs?: number;
      };
      const next = entries[i + 1];
      if (typeof m.durationMs !== "number" && next) {
        const diff = Date.parse(next.timestamp) - Date.parse(e.timestamp);
        if (Number.isFinite(diff) && diff > 0) inferred = diff;
      }
    }
    lines.push(JSON.stringify(eventLine(e, inferred)));
  }
  fs.mkdirSync(path.dirname(path_), { recursive: true });
  fs.writeFileSync(path_, lines.join("\n") + "\n");
  return path_;
}

// ── portable：活动分支线性化（pi exportToJsonl 形状）─────────────────────

/** 剥离性能字段（portable 只含会话内容） */
function stripPerf(m: ChatMessage): ChatMessage {
  const { durationMs: _d, toolError: _t, ...rest } = m as ChatMessage & {
    durationMs?: number;
    toolError?: boolean;
  };
  void _d; void _t;
  return rest;
}

/** 导出当前活动分支为 pi 式线性化 JSONL（可被 /import 读取），返回输出路径 */
export function exportSessionToPortable(session: SessionManager, outputPath?: string): string {
  const branch = session.getBranch();
  const header = session.getHeader();
  const path_ = outputPath ?? portableDefaultPath(header.cwd);
  const timestamp = new Date().toISOString();
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 1,
      id: header.id,
      timestamp,
      cwd: header.cwd,
      ...(header.parentSession ? { parentSession: header.parentSession } : {}),
    }),
  ];
  let parentId: string | null = null;
  for (const entry of branch) {
    if (entry.type === "message") {
      lines.push(
        JSON.stringify({
          ...entry,
          parentId,
          message: stripPerf((entry as SessionMessageEntryLike).message),
        }),
      );
    } else {
      lines.push(JSON.stringify({ ...entry, parentId }));
    }
    parentId = entry.id;
  }
  fs.mkdirSync(path.dirname(path_), { recursive: true });
  fs.writeFileSync(path_, lines.join("\n") + "\n");
  return path_;
}