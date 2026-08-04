/**
 * session-manager.ts — 树形会话（ADR-0004：形状同 pi v3、版本自管、自实现）
 *
 * JSONL 文件内建树：entry 带 id/parentId，原地分支；上下文从 leaf 回溯。
 * entry 子集：session/message/compaction/branch_summary/model_change/
 * session_info/label/custom。compaction 带 retainedTail 检查点。
 * 存储：.agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, resolveAgentDirs } from "./config.ts";
import { formatCompactedUserMessage } from "./prompt.ts";
import type { ChatMessage } from "./client.ts";

export const CURRENT_SESSION_VERSION = 1;

// ── Entry 类型 ────────────────────────────────────────────────────────────

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: ChatMessage;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  tokensBefore: number;
  retainedTail?: ChatMessage[];
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label?: string;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: T;
}

export type SessionEntry =
  | SessionMessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | ModelChangeEntry
  | SessionInfoEntry
  | LabelEntry
  | CustomEntry;

// ── 工具 ──────────────────────────────────────────────────────────────────

function genId(): string {
  return randomBytes(4).toString("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function sessionDirFor(cwd: string): string {
  const dirName = `--${cwd.replace(/\//g, "-")}--`;
  return path.join(defaultSessionDir(), dirName);
}

let sessionRoot: string | null = null;

export function setSessionRoot(dir: string): void {
  sessionRoot = dir;
}

export function defaultSessionDir(): string {
  if (sessionRoot) return sessionRoot;
  const envRoot = process.env.CLAUDE_PI_SESSION_ROOT;
  if (envRoot) return envRoot;
  return resolveAgentDirs(PROJECT_ROOT).sessionsDir;
}

function newSessionPath(cwd: string): string {
  const dir = sessionDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${Math.trunc(Date.now() / 1000)}_${randomUUID()}.jsonl`;
  return path.join(dir, file);
}

// ── SessionManager ────────────────────────────────────────────────────────

export class SessionManager {
  private header: SessionHeader;
  private entries: SessionEntry[] = [];
  private leafId: string | null = null;
  private readonly filePath: string | null;
  private readonly inMemory: boolean;

  private constructor(header: SessionHeader, filePath: string | null, inMemory: boolean) {
    this.header = header;
    this.filePath = filePath;
    this.inMemory = inMemory;
  }

  // ── 静态构造 ────────────────────────────────────────────────────────────

  static create(cwd: string, sessionDir?: string): SessionManager {
    const filePath = sessionDir ? path.join(sessionDir, `${Math.trunc(Date.now() / 1000)}_${randomUUID()}.jsonl`) : newSessionPath(cwd);
    if (sessionDir) fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: randomUUID(),
      timestamp: nowIso(),
      cwd,
    };
    fs.writeFileSync(filePath, JSON.stringify(header) + "\n");
    return new SessionManager(header, filePath, false);
  }

  static open(path_: string): SessionManager {
    const raw = fs.readFileSync(path_, "utf8");
    const lines = raw.trim().split("\n");
    const header = JSON.parse(lines[0]) as SessionHeader;
    const entries: SessionEntry[] = [];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      entries.push(JSON.parse(line) as SessionEntry);
    }
    const mgr = new SessionManager(header, path_, false);
    mgr.entries = entries;
    // 恢复 leaf：最后一个有 parentId 链的 entry（文件末尾）
    mgr.leafId = entries.length > 0 ? entries[entries.length - 1].id : null;
    return mgr;
  }

  static continueRecent(cwd: string): SessionManager {
    const dir = sessionDirFor(cwd);
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()
      : [];
    if (files.length === 0) return SessionManager.create(cwd);
    return SessionManager.open(path.join(dir, files[files.length - 1]));
  }

  /** fork：把源会话全路径复制到新文件（新 cwd），血缘 parentSession */
  static forkFrom(sourcePath: string, targetCwd: string): SessionManager {
    const source = SessionManager.open(sourcePath);
    const mgr = SessionManager.create(targetCwd);
    mgr.header.parentSession = sourcePath;
    const rootEntries = source.getBranch(source.getLeafId() ?? undefined);
    for (const entry of rootEntries) {
      mgr.appendRawEntry(entry);
    }
    return mgr;
  }

  static inMemory(cwd: string): SessionManager {
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: randomUUID(),
      timestamp: nowIso(),
      cwd,
    };
    return new SessionManager(header, null, true);
  }

  static list(cwd: string): Array<{ path: string; timestamp: number; id: string }> {
    const dir = sessionDirFor(cwd);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const p = path.join(dir, f);
        try {
          const header = JSON.parse(fs.readFileSync(p, "utf8").split("\n")[0]) as SessionHeader;
          return { path: p, timestamp: Date.parse(header.timestamp) || 0, id: header.id };
        } catch {
          return { path: p, timestamp: 0, id: "" };
        }
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  // ── 追加（全部落盘） ────────────────────────────────────────────────────

  private appendRawEntry(entry: SessionEntry): void {
    this.entries.push(entry);
    this.leafId = entry.id;
    if (this.filePath) {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    }
  }

  appendMessage(message: ChatMessage): string {
    const id = genId();
    this.appendRawEntry({
      type: "message",
      id,
      parentId: this.leafId,
      timestamp: nowIso(),
      message,
    });
    return id;
  }

  appendCompaction(summary: string, tokensBefore: number, retainedTail?: ChatMessage[]): string {
    const id = genId();
    this.appendRawEntry({
      type: "compaction",
      id,
      parentId: this.leafId,
      timestamp: nowIso(),
      summary,
      tokensBefore,
      ...(retainedTail ? { retainedTail } : {}),
    });
    return id;
  }

  appendBranchSummary(fromId: string, summary: string): string {
    const id = genId();
    this.appendRawEntry({
      type: "branch_summary",
      id,
      parentId: this.leafId,
      timestamp: nowIso(),
      fromId,
      summary,
    });
    return id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const id = genId();
    this.appendRawEntry({
      type: "model_change",
      id,
      parentId: this.leafId,
      timestamp: nowIso(),
      provider,
      modelId,
    });
    return id;
  }

  appendSessionInfo(name?: string): string {
    const id = genId();
    this.appendRawEntry({
      type: "session_info",
      id,
      parentId: this.leafId,
      timestamp: nowIso(),
      ...(name ? { name } : {}),
    });
    return id;
  }

  appendLabel(targetId: string, label?: string): string {
    const id = genId();
    this.appendRawEntry({
      type: "label",
      id,
      parentId: this.leafId,
      timestamp: nowIso(),
      targetId,
      ...(label ? { label } : {}),
    });
    return id;
  }

  appendCustom<T>(customType: string, data?: T): string {
    const id = genId();
    this.appendRawEntry({
      type: "custom",
      id,
      parentId: this.leafId,
      timestamp: nowIso(),
      customType,
      ...(data !== undefined ? { data } : {}),
    });
    return id;
  }

  // ── 树操作 ──────────────────────────────────────────────────────────────

  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | null {
    if (!this.leafId) return null;
    return this.getEntry(this.leafId);
  }

  getEntry(id: string): SessionEntry | null {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  /** 从 entry 回溯到根（root→leaf 顺序） */
  getBranch(fromId?: string): SessionEntry[] {
    const startId = fromId ?? this.leafId;
    if (!startId) return [];
    const result: SessionEntry[] = [];
    let current: SessionEntry | null = this.getEntry(startId);
    while (current) {
      result.unshift(current);
      current = current.parentId ? this.getEntry(current.parentId) : null;
    }
    return result;
  }

  getTree(): Array<{ entry: SessionEntry; children: SessionEntry[] }> {
    return this.entries.map((entry) => ({
      entry,
      children: this.entries.filter((e) => e.parentId === entry.id),
    }));
  }

  getChildren(parentId: string | null): SessionEntry[] {
    return this.entries.filter((e) => e.parentId === parentId);
  }

  /** 移动 leaf 到更早的 entry（原地分支） */
  branch(entryId: string): void {
    if (!this.getEntry(entryId)) throw new Error(`Unknown entry: ${entryId}`);
    this.leafId = entryId;
  }

  resetLeaf(): void {
    this.leafId = null;
  }

  /** 带摘要分支：写 branch_summary（被弃路径的 LLM 摘要） */
  branchWithSummary(entryId: string, summary: string): void {
    const fromId = this.leafId ?? "";
    this.branch(entryId);
    this.appendBranchSummary(fromId, summary);
  }

  // ── 上下文构建 ──────────────────────────────────────────────────────────

  /** 活动分支 entries（compaction 检查点处理） */
  buildContextEntries(): SessionEntry[] {
    const branch = this.getBranch();
    if (branch.length === 0) return [];
    // 最后一个带 retainedTail 的 compaction 是自包含检查点：仅保留它及其后的 entries
    let checkpointIdx = -1;
    for (let i = 0; i < branch.length; i++) {
      if (branch[i].type === "compaction" && (branch[i] as CompactionEntry).retainedTail) {
        checkpointIdx = i;
      }
    }
    if (checkpointIdx === -1) return branch; // 无检查点：全量（旧格式兼容）
    return branch.slice(checkpointIdx);
  }

  /** 构建 LLM 消息列表（compaction → 摘要 user 消息 + retainedTail） */
  buildSessionContext(): { messages: ChatMessage[]; model: string | null } {
    const entries = this.buildContextEntries();
    const messages: ChatMessage[] = [];
    let model: string | null = null;
    for (const entry of entries) {
      switch (entry.type) {
        case "message":
          messages.push(entry.message);
          break;
        case "compaction":
          messages.push({
            role: "user",
            content: formatCompactedUserMessage(entry.summary),
          });
          if (entry.retainedTail) {
            messages.push(...entry.retainedTail);
          }
          break;
        case "branch_summary":
          messages.push({
            role: "user",
            content: `[Branch summary] 从被弃分支 ${entry.fromId} 切换过来：\n${entry.summary}`,
          });
          break;
        case "model_change":
          model = entry.modelId;
          break;
        case "custom":
        case "label":
        case "session_info":
          break;
      }
    }
    return { messages, model };
  }

  /** clone：把当前活动分支（到 leafId，默认当前 leaf）复制到新会话文件 */
  createBranchedSession(leafId?: string): SessionManager {
    const targetLeaf = leafId ?? this.leafId ?? undefined;
    const mgr = SessionManager.create(this.header.cwd);
    mgr.header.parentSession = this.filePath ?? undefined;
    const branch = this.getBranch(targetLeaf);
    for (const entry of branch) {
      mgr.appendRawEntry(entry);
    }
    return mgr;
  }

  // ── 元数据 ──────────────────────────────────────────────────────────────

  getHeader(): SessionHeader {
    return this.header;
  }

  getSessionName(): string | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === "session_info") {
        return (this.entries[i] as SessionInfoEntry).name ?? null;
      }
    }
    return null;
  }

  getSessionId(): string {
    return this.header.id;
  }

  getSessionFile(): string | null {
    return this.filePath;
  }

  isPersisted(): boolean {
    return !this.inMemory && this.filePath !== null;
  }

  getEntries(): SessionEntry[] {
    return [...this.entries];
  }
}
