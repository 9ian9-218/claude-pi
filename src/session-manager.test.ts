import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, setSessionRoot } from "./session-manager.ts";
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
    expect(contents.some((c) => c.includes("[Compacted]"))).toBe(true);
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
