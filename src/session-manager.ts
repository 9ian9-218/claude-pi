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
import { writeFileAtomic } from "./atomic-write.ts";
import path from "node:path";
import { AGENT_ROOT, resolveAgentDirs } from "./config.ts";
import { formatCompactedUserMessage } from "./prompt.ts";
import type { Usage } from "@earendil-works/pi-ai";
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
  /** 摘要生成响应的计费信息（footer 累计用） */
  usage?: Usage;
  /**
   * 摘要输入指纹（prompt 全文 + 模型）。同指纹 ⇒ 摘要可原样复用：
   * 同一前缀的不同分支、同一点重问，都省掉一次全量摘要调用（见 compact.ts）。
   */
  inputHash?: string;
  /** 复用来源：本摘要抄自哪个 compaction entry（自己生成时缺省） */
  reusedFrom?: string;
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

export interface ThinkingChangeEntry extends SessionEntryBase {
  type: "thinking_change";
  level: string;
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
  | ThinkingChangeEntry
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

// ── 会话文件锁（并发写防护，隐患 03） ─────────────────────────────────────
// 锁文件 `<会话>.lock` 以原子创建表达占用（pid + 时间戳）；崩溃残留（SIGKILL/
// 断电）由 stale 检测接管：**仅按 pid 存活判定**——交互式会话可长开数小时，
// 按时间判陈旧会误杀活锁、让第一进程失去保护。锁只保护「整文件重写」类操作
// （truncateTo），append 本身按行原子，不加锁。
// 失败方向：误判 busy 只产生 concurrent 提示（不重写磁盘），永不误判 stale（不抹数据）。

const heldLocks = new Set<string>();

/** 尝试获取会话文件锁；被其他进程占用且非陈旧时返回 false */
function tryAcquireLock(filePath: string): boolean {
  if (!filePath) return true;
  const lockPath = `${filePath}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, `${process.pid} ${Date.now()}`);
      fs.closeSync(fd);
      heldLocks.add(lockPath);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return true; // 锁目录不可写等：不阻塞会话
      if (isStaleLock(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          return false;
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

/** 锁陈旧判定：pid 不存在 = 持锁进程已死，可抢占；其余一律视为活跃（保守） */
function isStaleLock(lockPath: string): boolean {
  try {
    const content = fs.readFileSync(lockPath, "utf8");
    const pid = Number(content.split(" ")[0]);
    if (!Number.isInteger(pid) || pid <= 0) return false; // 内容异常：保守判活跃
    try {
      process.kill(pid, 0);
      return false; // 进程存活：锁有效（时长不限）
    } catch {
      return true; // ESRCH：进程已死
    }
  } catch {
    return false; // 读失败：保守判活跃
  }
}

function releaseAllLocks(): void {
  for (const lockPath of heldLocks) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // 已被外部清理
    }
  }
  heldLocks.clear();
}

process.on("exit", releaseAllLocks);

export function defaultSessionDir(): string {
  if (sessionRoot) return sessionRoot;
  const envRoot = process.env.CLAUDE_PI_SESSION_ROOT;
  if (envRoot) return envRoot;
  return resolveAgentDirs(AGENT_ROOT).sessionsDir;
}

function newSessionPath(cwd: string): string {
  return createSessionPath(cwd);
}

/** 新会话文件全路径：`<会话目录>/<ts>_<uuid>.jsonl`（创建/导入共用同一命名规则） */
export function createSessionPath(cwd: string): string {
  const dir = sessionDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${Math.trunc(Date.now() / 1000)}_${randomUUID()}.jsonl`);
}

// ── SessionManager ────────────────────────────────────────────────────────

export interface SessionListItem {
  path: string;
  timestamp: number;
  id: string;
  /** 会话名（session_info.name） */
  name: string | null;
  /** 第一条 user 消息文本（预览） */
  firstMessage: string;
  messageCount: number;
  /** 最后活动时间（最后一个 entry 的时间戳） */
  lastActivity: number;
}

/**
 * 恢复期清洗：裁剪未闭合的工具回合（崩溃/中断残留），保证发给模型的
 * 消息序列合法（OpenAI 协议要求 assistant 的 tool_calls 必须被配对）。
 *
 * 对齐 Claude Code 的 "The response above may be incomplete" 语义：
 * - 保留已闭合轮（assistant(tool_calls) + 全部对应 tool 结果）；
 * - 末尾残留未闭合轮：截断到闭合点，其内容转为文本（保留已产出文本
 *   + [Error] 中断标记），恢复后可直接继续对话；
 * - 孤儿 tool 消息（无对应 assistant tool_calls）：其后内容不可信，截断。
 */
export function closeOpenTurns(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  /** 当前未闭合轮期望配对的 tool_call_id 集合 */
  let expected = new Set<string>();
  /** 未闭合轮在 result 中的起点索引（-1 = 当前无未闭合轮） */
  let openFrom = -1;

  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      expected = new Set(
        (m.tool_calls as Array<{ id: string }>).map((tc) => tc.id),
      );
      openFrom = result.length;
      result.push(m);
      continue;
    }
    if (m.role === "tool") {
      if (openFrom === -1) {
        // 孤儿 tool 结果：其后的内容都不能信任，截断
        result.push({
          role: "assistant",
          content: "[Error] 会话恢复：发现孤立的工具结果（对应调用缺失），其后的内容已截断。",
        } as ChatMessage);
        return result;
      }
      if (m.tool_call_id) expected.delete(m.tool_call_id);
      result.push(m);
      if (expected.size === 0) openFrom = -1;
      continue;
    }
    if (openFrom !== -1) {
      // 未闭合轮被非工具消息打断（防御：正常流程不应发生）
      result.push({
        role: "assistant",
        content: "[Error] 会话恢复：工具调用未完成，中断点之后的内容已截断。",
      } as ChatMessage);
      return result;
    }
    result.push(m);
  }

  if (openFrom !== -1) {
    // 循环结束仍未闭合：撤销该轮，已产出的文本转成中断标记保留
    const open = result[openFrom] as ChatMessage;
    const completed = result.slice(0, openFrom);
    const openText =
      typeof open.content === "string" && open.content.trim() ? open.content + "\n\n" : "";
    completed.push({
      role: "assistant",
      content: `${openText}[Error] 回合中断：工具调用未完成（已从恢复上下文回退），可回复 continue 继续。`,
    } as ChatMessage);
    return completed;
  }
  return result;
}

export class SessionManager {
  private header: SessionHeader;
  private entries: SessionEntry[] = [];
  private leafId: string | null = null;
  private readonly filePath: string | null;
  private readonly inMemory: boolean;
  /** 会话文件被其他进程占用（锁获取失败）：truncateTo 只回滚内存、不重写磁盘 */
  private readonly concurrent: boolean;

  private constructor(
    header: SessionHeader,
    filePath: string | null,
    inMemory: boolean,
    concurrent: boolean,
  ) {
    this.header = header;
    this.filePath = filePath;
    this.inMemory = inMemory;
    this.concurrent = concurrent;
  }

  /** 会话文件是否被其他进程并发持有（只读视角，写入有丢失风险） */
  isConcurrent(): boolean {
    return this.concurrent;
  }

  /**
   * 会话 id（header.id；内存会话同样有）。
   * 供 provider 侧缓存路由作稳定标识：同一会话跨进程续接时 id 不变，
   * 缓存前缀才能持续命中（见 client.withSessionRouting）。
   */
  get sessionId(): string {
    return this.header.id;
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
    const mgr = new SessionManager(header, filePath, false, !tryAcquireLock(filePath));
    if (mgr.concurrent) {
      console.warn(
        `  \x1b[33m[session] ${path.basename(filePath)} 正被其他进程使用（并发会话）；` +
          `回滚将只作用于内存，不重写磁盘\x1b[0m`,
      );
    }
    return mgr;
  }

  static open(path_: string): SessionManager {
    const raw = fs.readFileSync(path_, "utf8");
    const lines = raw.trim().split("\n");
    const header = JSON.parse(lines[0]) as SessionHeader;
    const entries: SessionEntry[] = [];
    // 崩溃容错：kill -9 可能落在 append 中途留下半行 JSON，逐行 try/catch 跳过坏行
    // （尾行 torn 时丢弃它，leaf 回到最后一个有效 entry）
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch {
        // 坏行跳过（不中断恢复）
      }
    }
    const mgr = new SessionManager(header, path_, false, !tryAcquireLock(path_));
    if (mgr.concurrent) {
      console.warn(
        `  \x1b[33m[session] ${path.basename(path_)} 正被其他进程使用（并发会话）；` +
          `回滚将只作用于内存，不重写磁盘\x1b[0m`,
      );
    }
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
    // clone/fork 收敛：复制分支逻辑唯一实现（createBranchedSession），
    // fork 只是「新 cwd + 血缘 parentSession」的参数差异
    const source = SessionManager.open(sourcePath);
    const mgr = source.createBranchedSession(source.getLeafId() ?? undefined);
    mgr.header.cwd = targetCwd;
    mgr.header.parentSession = sourcePath;
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
    return new SessionManager(header, null, true, false);
  }

  /** 会话列表（resume 选择器用）：name/firstMessage/消息数/最后活动，按最后活动降序 */
  static list(cwd: string): SessionListItem[] {
    const dir = sessionDirFor(cwd);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const p = path.join(dir, f);
        try {
          const raw = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
          const header = JSON.parse(raw[0]) as SessionHeader;
          let name: string | null = null;
          let firstMessage = "";
          let messageCount = 0;
          let lastActivity = Date.parse(header.timestamp) || 0;
          for (const line of raw.slice(1)) {
            try {
              const entry = JSON.parse(line) as SessionEntry;
              const ts = Date.parse(entry.timestamp);
              if (ts > lastActivity) lastActivity = ts;
              if (entry.type === "session_info" && (entry as SessionInfoEntry).name && !name) {
                name = (entry as SessionInfoEntry).name!;
              } else if (entry.type === "message") {
                messageCount += 1;
                const msg = (entry as { message: ChatMessage }).message;
                if (!firstMessage && msg.role === "user" && msg.content) {
                  firstMessage = String(msg.content).slice(0, 80);
                }
              }
            } catch {
              // 跳过损坏行
            }
          }
          return {
            path: p,
            timestamp: Date.parse(header.timestamp) || 0,
            id: header.id,
            name,
            firstMessage,
            messageCount,
            lastActivity,
          };
        } catch {
          return {
            path: p,
            timestamp: 0,
            id: "",
            name: null,
            firstMessage: "",
            messageCount: 0,
            lastActivity: 0,
          };
        }
      })
      .sort((a, b) => b.lastActivity - a.lastActivity);
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

  appendCompaction(
    summary: string,
    tokensBefore: number,
    retainedTail?: ChatMessage[],
    usage?: Usage,
    meta?: { inputHash?: string; reusedFrom?: string },
  ): string {
    const id = genId();
    this.appendRawEntry({
      type: "compaction",
      id,
      parentId: this.leafId,
      timestamp: nowIso(),
      summary,
      tokensBefore,
      ...(retainedTail ? { retainedTail } : {}),
      ...(usage ? { usage } : {}),
      ...(meta?.inputHash ? { inputHash: meta.inputHash } : {}),
      ...(meta?.reusedFrom ? { reusedFrom: meta.reusedFrom } : {}),
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

  /** 记录思考强度变化（thinking 记忆：重启后恢复上次强度） */
  appendThinkingChange(level: string): string {
    const id = genId();
    this.appendRawEntry({
      type: "thinking_change",
      id,
      parentId: this.leafId,
      timestamp: nowIso(),
      level,
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

  /**
   * 截断会话到 entryId（含）之后的内容全部移除（内存裁剪 + 文件重写）。
   * entryId=null 清空所有 entry（仅保留 header）。用于中断回滚：
   * 把本回合未完成落盘的 assistant/tool 消息整体撤销，恢复后从干净状态继续。
   */
  truncateTo(entryId: string | null): void {
    if (entryId === null) {
      this.entries = [];
      this.leafId = null;
    } else {
      const idx = this.entries.findIndex((e) => e.id === entryId);
      if (idx === -1) return; // 未知 entry：不动（防御）
      this.entries = this.entries.slice(0, idx + 1);
      this.leafId = this.entries[this.entries.length - 1].id;
    }
    if (this.filePath) {
      if (this.concurrent) {
        // 并发会话：另一进程可能正在追加——重写会抹掉其增量，只回滚内存
        console.warn(
          `  \x1b[33m[session] 并发会话（${path.basename(this.filePath)}）：` +
            `中断回滚只作用于内存，磁盘保留追加内容\x1b[0m`,
        );
      } else {
        // 重写文件：header + 保留的 entries（全部 append 均为同步，同进程安全）
        const lines = [
          JSON.stringify(this.header),
          ...this.entries.map((e) => JSON.stringify(e)),
        ];
        writeFileAtomic(this.filePath, lines.join("\n") + "\n");
      }
    }
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
  buildSessionContext(): {
    messages: ChatMessage[];
    model: string | null;
    thinkingLevel: string | null;
  } {
    const entries = this.buildContextEntries();
    const messages: ChatMessage[] = [];
    let model: string | null = null;
    let thinkingLevel: string | null = null;
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
          // 完整 spec（provider/id），启动恢复时精确还原（restoreModel）
          model = `${entry.provider}/${entry.modelId}`;
          break;
        case "thinking_change":
          // 思考强度记忆：重启后恢复上次强度
          thinkingLevel = entry.level;
          break;
        case "custom":
        case "label":
        case "session_info":
          break;
      }
    }
    return { messages: closeOpenTurns(messages), model, thinkingLevel };
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

  /**
   * 子会话：新建独立会话文件 + 血缘父会话 + 可选会话名。
   * 子 agent（subagent / 5 个专职角色）用它落盘完整轨迹，父会话据此接入会话树。
   */
  static createChild(cwd: string, parentFile: string | null, name?: string): SessionManager {
    const mgr = SessionManager.create(cwd);
    if (parentFile) mgr.setParentSession(parentFile);
    if (name) mgr.appendSessionInfo(name);
    return mgr;
  }

  /**
   * fork 子会话：把父会话当前分支整段复制到新文件（血缘指向父会话）。
   * 用途：一次性 subagent 复用父会话前缀（system + 工具面 + 历史），
   * 从而命中 provider 的 prompt cache；自身新增的轮次追加在副本之上。
   */
  static forkChild(parent: SessionManager, name?: string): SessionManager {
    const mgr = parent.createBranchedSession(parent.getLeafId() ?? undefined);
    mgr.setParentSession(parent.getSessionFile());
    if (name) mgr.appendSessionInfo(name);
    return mgr;
  }

  /**
   * 设置/更新血缘父会话并落盘。
   * header 不在 append 路径上（create 时已写入首行），故需单独重写首行。
   */
  setParentSession(parentFile: string | null): void {
    if (parentFile) this.header.parentSession = parentFile;
    else delete this.header.parentSession;
    this.rewriteHeader();
  }

  private rewriteHeader(): void {
    if (!this.filePath) return;
    const raw = fs.readFileSync(this.filePath, "utf8");
    const lines = raw.split("\n");
    lines[0] = JSON.stringify(this.header);
    writeFileAtomic(this.filePath, lines.join("\n"));
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
