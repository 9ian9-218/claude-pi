import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, setSessionRoot, closeOpenTurns } from "./session-manager.ts";
import type { ChatMessage } from "./client.ts";

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-sess-"));
  setSessionRoot(dir);
  cwd = path.join(os.tmpdir(), "claude-pi-cwd");
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function u(content: string): ChatMessage {
  return { role: "user", content };
}

function a(content: string): ChatMessage {
  return { role: "assistant", content };
}

describe("会话创建与持久化（S12）", () => {
  it("create 落盘 JSONL（header + entries），open 恢复 leaf", () => {
    const s = SessionManager.create(cwd);
    s.appendMessage(u("你好"));
    s.appendMessage(a("回复"));
    const file = s.getSessionFile()!;
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).type).toBe("session");
    expect(JSON.parse(lines[0]).version).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lines[1]).type).toBe("message");
    // 恢复
    const reopened = SessionManager.open(file);
    expect(reopened.getLeafId()).toBe(s.getLeafId());
    const ctx = reopened.buildSessionContext();
    expect(ctx.messages.map((m) => m.content)).toEqual(["你好", "回复"]);
  });

  it("continueRecent 返回最近会话；无会话时新建", () => {
    const s1 = SessionManager.create(cwd);
    s1.appendMessage(u("第一"));
    const s2 = SessionManager.continueRecent(cwd);
    expect(s2.getSessionFile()).toBe(s1.getSessionFile());
  });

  it("--<path>-- 按 cwd 组织", () => {
    SessionManager.create(cwd);
    const orgDir = path.join(dir, `--${cwd.replace(/\//g, "-")}--`);
    expect(fs.existsSync(orgDir)).toBe(true);
  });

  it("inMemory 不落盘", () => {
    const s = SessionManager.inMemory(cwd);
    s.appendMessage(u("x"));
    expect(s.getSessionFile()).toBeNull();
    expect(s.isPersisted()).toBe(false);
  });
});

describe("树操作（S12）", () => {
  it("分支：branch 移动 leaf，追加走新路径", () => {
    const s = SessionManager.create(cwd);
    const m1 = s.appendMessage(u("问题"));
    const m2 = s.appendMessage(a("答案A"));
    const m3 = s.appendMessage(a("更多A"));
    // 分支回 m1，从那里继续
    s.branch(m1);
    const m4 = s.appendMessage(a("答案B"));
    expect(s.getBranch().map((e) => e.id)).toEqual([m1, m4]);
    expect(s.getChildren(m1).map((e) => e.id).sort()).toEqual([m2, m4].sort());
    expect(s.getChildren(m2).map((e) => e.id)).toEqual([m3]);
  });

  it("branchWithSummary 写 branch_summary 记录弃路径", () => {
    const s = SessionManager.create(cwd);
    const m1 = s.appendMessage(u("q"));
    s.appendMessage(a("路径A"));
    s.branchWithSummary(m1, "路径A探索了 X 方案");
    const entries = s.getEntries();
    const summary = entries.find((e) => e.type === "branch_summary") as { summary: string };
    expect(summary.summary).toContain("X 方案");
    // 上下文重建含 branch_summary
    const ctx = s.buildSessionContext();
    expect(ctx.messages.some((m) => String(m.content).includes("Branch summary"))).toBe(true);
  });

  it("resetLeaf 后追加为根节点", () => {
    const s = SessionManager.create(cwd);
    s.appendMessage(u("a"));
    s.resetLeaf();
    const id = s.appendMessage(u("b"));
    const entry = s.getEntry(id)!;
    expect(entry.parentId).toBeNull();
  });
});

describe("compaction 检查点（S12）", () => {
  it("appendCompaction 带 retainedTail：上下文从检查点重建", () => {
    const s = SessionManager.create(cwd);
    s.appendMessage(u("早期对话"));
    s.appendMessage(a("早期回复"));
    const tail: ChatMessage[] = [u("最近请求"), a("最近回复")];
    s.appendCompaction("早期内容摘要", 5000, tail);
    s.appendMessage(u("继续"));
    const ctx = s.buildSessionContext();
    const contents = ctx.messages.map((m) => String(m.content));
    expect(contents.some((c) => c.includes("compacted into the following summary"))).toBe(true);
    expect(contents.some((c) => c.includes("早期内容摘要"))).toBe(true);
    // retainedTail 检查点内容
    expect(contents).toContain("最近请求");
    expect(contents).toContain("最近回复");
    // 检查点之前的原始消息不在上下文
    expect(contents).not.toContain("早期对话");
    expect(contents).toContain("继续");
  });
});

describe("fork / clone / resume（S12）", () => {
  it("forkFrom 复制全路径到新文件并记录 parentSession", () => {
    const s1 = SessionManager.create(cwd);
    s1.appendMessage(u("a"));
    s1.appendMessage(a("b"));
    const fork = SessionManager.forkFrom(s1.getSessionFile()!, cwd);
    expect(fork.getSessionFile()).not.toBe(s1.getSessionFile());
    expect(fork.getHeader().parentSession).toBe(s1.getSessionFile());
    expect(fork.buildSessionContext().messages.map((m) => m.content)).toEqual(["a", "b"]);
  });

  it("createBranchedSession（clone）复制当前分支", () => {
    const s = SessionManager.create(cwd);
    const m1 = s.appendMessage(u("q"));
    const aPath = s.appendMessage(a("路径A"));
    s.branch(m1);
    s.appendMessage(a("路径B"));
    // clone：默认复制当前活动分支（q → 路径B）
    const clone = s.createBranchedSession();
    expect(clone.buildSessionContext().messages.map((m) => m.content)).toEqual(["q", "路径B"]);
    // 带参：复制到指定 leaf 的路径（q → 路径A）
    const cloneToM1 = s.createBranchedSession(aPath);
    expect(cloneToM1.buildSessionContext().messages.map((m) => m.content)).toEqual(["q", "路径A"]);
  });

  it("resume：open 后继续追加（断线恢复基础）", () => {
    const s = SessionManager.create(cwd);
    s.appendMessage(u("第一轮"));
    const file = s.getSessionFile()!;
    const resumed = SessionManager.open(file);
    resumed.appendMessage(a("恢复后继续"));
    const ctx = resumed.buildSessionContext();
    expect(ctx.messages.map((m) => m.content)).toEqual(["第一轮", "恢复后继续"]);
  });
});

describe("扩展 entry（S12）", () => {
  it("model_change / session_info / label / custom 记录与上下文过滤", () => {
    const s = SessionManager.create(cwd);
    s.appendMessage(u("hi"));
    s.appendModelChange("openai", "gpt-test");
    s.appendSessionInfo("我的会话");
    s.appendLabel(s.getLeafId()!, "checkpoint-1");
    s.appendCustom("my-ext", { count: 42 });
    expect(s.getSessionName()).toBe("我的会话");
    // custom/label/session_info 不参与上下文
    const ctx = s.buildSessionContext();
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.model).toBe("openai/gpt-test"); // 完整 spec（恢复用）
  });
});

describe("崩溃恢复（S12）", () => {
  it("append 即落盘：open 恢复全部消息", () => {
    const s = SessionManager.create(cwd);
    for (let i = 0; i < 5; i++) {
      s.appendMessage(u(`消息${i}`));
    }
    // 模拟进程崩溃：不调用任何 flush，直接重新 open
    const recovered = SessionManager.open(s.getSessionFile()!);
    expect(recovered.buildSessionContext().messages).toHaveLength(5);
  });
});

// ── 恢复期增强（未闭合回合裁剪 / 中断回滚）───────────────────────────────

const assistantT = (c: string | null, toolCallIds: string[] = []): ChatMessage => ({
  role: "assistant",
  content: c,
  ...(toolCallIds.length > 0
    ? { tool_calls: toolCallIds.map((id) => ({ id, type: "function" })) }
    : {}),
});
const tool = (id: string, content = "ok"): ChatMessage => ({
  role: "tool",
  tool_call_id: id,
  content,
});

describe("closeOpenTurns（恢复期未闭合回合裁剪）", () => {
  it("完整闭合序列原样保留", () => {
    const msgs = [u("go"), assistantT(null, ["c1", "c2"]), tool("c1"), tool("c2"), a("done")];
    expect(closeOpenTurns(msgs)).toEqual(msgs);
  });

  it("末尾未闭合轮（部分工具结果）→ 截断到闭合点并转中断文本", () => {
    const msgs = [u("go"), assistantT(null, ["c1", "c2"]), tool("c1")];
    const out = closeOpenTurns(msgs);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(u("go"));
    expect(out[1].role).toBe("assistant");
    expect(String(out[1].content)).toContain("[Error] 回合中断");
    // 协议合法：不残留 tool_calls / tool 消息
    expect((out[1] as ChatMessage).tool_calls).toBeUndefined();
  });

  it("未闭合轮带已产出文本 → 文本保留 + 中断标记", () => {
    const msgs = [u("go"), assistantT("部分内容", ["c1"]), tool("c1"), assistantT("更多文本", ["c2"])];
    const out = closeOpenTurns(msgs);
    // 闭合轮（user + assistant + tool 结果）保留 + 中断文本
    expect(out).toHaveLength(4);
    expect(String(out[3].content)).toContain("更多文本");
    expect(String(out[3].content)).toContain("[Error] 回合中断");
  });

  it("孤儿 tool 结果（无对应 assistant）→ 截断，其后内容丢弃", () => {
    const msgs = [u("go"), a("done"), tool("orphan"), u("after")];
    const out = closeOpenTurns(msgs);
    expect(out).toHaveLength(3);
    expect(String(out[2].content)).toContain("孤立的工具结果");
  });

  it("未闭合轮被 user 消息打断（防御分支）→ 截断", () => {
    const msgs = [u("go"), assistantT(null, ["c1"]), u("interrupt")];
    const out = closeOpenTurns(msgs);
    expect(out).toHaveLength(3);
    expect(String(out[2].content)).toContain("工具调用未完成");
  });

  it("多轮工具循环全部闭合时原样保留（含交错文本轮）", () => {
    const msgs = [
      u("go"),
      assistantT("先想一下", ["c1"]),
      tool("c1"),
      assistantT("继续", ["c2", "c3"]),
      tool("c2"),
      tool("c3"),
      a("完成"),
    ];
    expect(closeOpenTurns(msgs)).toEqual(msgs);
  });
});

describe("SessionManager.truncateTo（中断回滚）", () => {
  it("截断到指定 entry：内存与磁盘文件一致，leaf 复位", () => {
    const s = SessionManager.create(cwd);
    s.appendMessage(u("go"));
    const aEntry = s.appendMessage(a("a"));
    s.appendMessage(tool("r"));
    s.truncateTo(aEntry);
    expect(s.getEntries().map((e) => e.type)).toEqual(["message", "message"]);
    expect(s.getLeafId()).toBe(aEntry);
    // 重新打开文件验证重写生效
    const reopened = SessionManager.open(s.getSessionFile()!);
    expect(reopened.getEntries().map((e) => e.id)).toEqual([s.getEntries()[0].id, aEntry]);
    expect(reopened.getLeafId()).toBe(aEntry);
  });

  it("entryId=null 清空全部 entry（仅保留 header）", () => {
    const s = SessionManager.create(cwd);
    s.appendMessage(u("go"));
    s.truncateTo(null);
    expect(s.getEntries()).toHaveLength(0);
    expect(s.getLeafId()).toBeNull();
    const reopened = SessionManager.open(s.getSessionFile()!);
    expect(reopened.getEntries()).toHaveLength(0);
    expect(reopened.getLeafId()).toBeNull();
  });

  it("未知 entry：不动（防御）", () => {
    const s = SessionManager.create(cwd);
    s.appendMessage(u("go"));
    s.appendMessage(a("a"));
    s.truncateTo("no-such-entry");
    expect(s.getEntries()).toHaveLength(2);
  });
});

describe("崩溃容错与并发写（隐患 02/03）", () => {
  it("torn line：尾行半截 JSON 跳过，恢复不崩溃", () => {
    const s = SessionManager.create(cwd);
    s.appendMessage(u("消息1"));
    s.appendMessage(a("回复1"));
    // 模拟 kill -9 落在 append 中途：追加半行
    fs.appendFileSync(s.getSessionFile()!, '{"type":"message","id":"torn",');
    const recovered = SessionManager.open(s.getSessionFile()!);
    expect(recovered.buildSessionContext().messages).toHaveLength(2);
    expect(recovered.getLeafId()).toBe(s.getEntries()[s.getEntries().length - 1].id);
  });

  it("torn line：坏行在中间同样跳过，其余行保留", () => {
    const s = SessionManager.create(cwd);
    s.appendMessage(u("m1"));
    const lines = fs.readFileSync(s.getSessionFile()!, "utf8").trim().split("\n");
    // 手工构造：header + 有效行 + 坏行 + 有效行（parentId 保持祖先链）
    const m1Id = s.getEntries()[0].id;
    const after = JSON.stringify({
      type: "message",
      id: "after",
      parentId: m1Id,
      timestamp: "t",
      message: { role: "user", content: "m2" },
    });
    const broken = [lines[0], lines[1], '{"broken', after].join("\n") + "\n";
    fs.writeFileSync(s.getSessionFile()!, broken);
    const recovered = SessionManager.open(s.getSessionFile()!);
    expect(recovered.buildSessionContext().messages).toHaveLength(2);
  });

  it("并发写：同进程二次 open 标记 concurrent，truncateTo 不重写磁盘", () => {
    const s1 = SessionManager.create(cwd);
    s1.appendMessage(u("go"));
    s1.appendMessage(a("assistant-msg"));
    const s2 = SessionManager.open(s1.getSessionFile()!);
    expect(s2.isConcurrent()).toBe(true);
    // s2 中断回滚：内存 leaf 回滚到 user 消息
    const userEntry = s2.getEntries()[0];
    s2.truncateTo(userEntry.id);
    expect(s2.getEntries()).toHaveLength(1);
    // 磁盘未被重写：s1 追加的 assistant 消息仍在
    const onDisk = SessionManager.open(s1.getSessionFile()!);
    expect(onDisk.getEntries()).toHaveLength(2);
    expect((onDisk.getEntries()[1] as { message: { content: string } }).message.content).toBe("assistant-msg");
  });

  it("陈旧锁（pid 已死）→ 视为 stale 并正常抢占", () => {
    const s = SessionManager.create(cwd);
    const lockPath = s.getSessionFile()! + ".lock";
    // 覆盖为死进程的锁
    fs.writeFileSync(lockPath, "999999 1234567890");
    const again = SessionManager.open(s.getSessionFile()!);
    expect(again.isConcurrent()).toBe(false);
  });

  it("create 后锁文件存在，退出时清理", () => {
    const s = SessionManager.create(cwd);
    const lockPath = s.getSessionFile()! + ".lock";
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8").startsWith(String(process.pid))).toBe(true);
    // 同进程再次 create 同一目录（新文件）不冲突
    const s2 = SessionManager.create(cwd);
    expect(s2.isConcurrent()).toBe(false);
  });
});

describe("usage 落盘（footer 统计数据源）", () => {
  const usage = {
    input: 100, output: 50, cacheRead: 900, cacheWrite: 10, totalTokens: 1060,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.01, total: 0.36 },
  };

  it("appendMessage 携带 usage → 重开文件后 entry 保留", () => {
    const s = SessionManager.create(cwd);
    s.appendMessage(u("go"));
    s.appendMessage({ role: "assistant", content: "ok", usage });
    const reopened = SessionManager.open(s.getSessionFile()!);
    const entries = reopened.getEntries();
    const assistant = entries[entries.length - 1] as { message: { usage?: unknown } };
    expect(assistant.message.usage).toEqual(usage);
    // buildSessionContext 透传不丢（closeOpenTurns 不剥离 usage）
    const ctx = reopened.buildSessionContext();
    expect((ctx.messages[1] as { usage?: unknown }).usage).toEqual(usage);
  });

  it("appendCompaction 携带 usage → 重开保留", () => {
    const s = SessionManager.create(cwd);
    s.appendCompaction("summary", 1000, undefined, usage);
    const reopened = SessionManager.open(s.getSessionFile()!);
    const last = reopened.getEntries()[reopened.getEntries().length - 1] as { usage?: unknown };
    expect(last.usage).toEqual(usage);
  });
});
