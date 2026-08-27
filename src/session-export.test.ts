/**
 * session-export.test.ts — 会话导出（analysis 整树 trace / portable 分支会话）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "./session-manager.ts";
import {
  expandPersistedOutputs,
  exportSessionToAnalysisTrace,
  exportSessionToPortable,
  parseExportArgs,
  portableDefaultPath,
} from "./session-export.ts";
import type { ChatMessage } from "./client.ts";
import { setProjectConfigRootForTest } from "./project-config.ts";
import { AGENT_ROOT } from "./config.ts";

function u(content: string): ChatMessage {
  return { role: "user", content };
}
function a(content: string, extra: Record<string, unknown> = {}): ChatMessage {
  return { role: "assistant", content, ...extra };
}
function toolMsg(content: string, extra: Record<string, unknown> = {}): ChatMessage {
  return { role: "tool", tool_call_id: "call_1", content, ...extra };
}

describe("session-export", () => {
  let tmp: string;
  let session: SessionManager;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-export-"));
    setProjectConfigRootForTest(tmp);
    session = SessionManager.inMemory(AGENT_ROOT);
  });

  afterEach(() => {
    setProjectConfigRootForTest(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("parseExportArgs", () => {
    it("空参数：无模式无路径", () => {
      expect(parseExportArgs("")).toEqual({});
    });
    it("识别 --analysis / --portable 与路径", () => {
      expect(parseExportArgs("--analysis /tmp/x.jsonl")).toEqual({
        mode: "analysis",
        path: "/tmp/x.jsonl",
      });
      expect(parseExportArgs("--portable")).toEqual({ mode: "portable" });
      expect(parseExportArgs("out.jsonl")).toEqual({ path: "out.jsonl" });
    });
  });

  describe("portableDefaultPath", () => {
    it("对齐 pi：session-<ISO 替换 :. -> ->.jsonl 于 cwd", () => {
      const p = portableDefaultPath("/work");
      expect(path.dirname(p)).toBe("/work");
      expect(path.basename(p)).toMatch(/^session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/);
    });
  });

  describe("expandPersistedOutputs", () => {
    it("解析 <persisted-output> 引用并合并全文", () => {
      const file = path.join(tmp, "big.txt");
      fs.writeFileSync(file, "FULL OUTPUT CONTENT");
      const ref = `<persisted-output>\nFull output: ${file}\nPreview:\nPREVIEW...\n</persisted-output>`;
      const expanded = expandPersistedOutputs(`前文\n${ref}\n后文`);
      expect(expanded).toContain("FULL OUTPUT CONTENT");
      expect(expanded).not.toContain("<persisted-output>");
      expect(expanded).not.toContain("PREVIEW...");
      expect(expanded).toContain("前文");
      expect(expanded).toContain("后文");
    });

    it("引用文件缺失时保留原文（不抛错）", () => {
      const ref = `<persisted-output>\nFull output: /nonexistent/x.txt\nPreview:\nPREVIEW...\n</persisted-output>`;
      const s = expandPersistedOutputs(ref);
      expect(s).toContain("<persisted-output>");
    });
  });

  describe("exportSessionToAnalysisTrace", () => {
    it("导出整棵树：全分支 entry 均出现，meta 首行", () => {
      session.appendMessage(u("第一问"));
      session.appendMessage(a("回答A"));
      // 分支：切回第一个 user 消息再产生新路径
      const branchRoot = session.getBranch()[0].id;
      session.branch(branchRoot);
      session.appendMessage(u("第二问"));
      session.appendMessage(a("回答B"));
      session.appendCompaction("摘要", 100);

      const out = path.join(tmp, "trace.jsonl");
      exportSessionToAnalysisTrace(session, out);
      const lines = fs
        .readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines[0].type).toBe("meta");
      expect(lines[0].format).toBe("analysis");
      expect(lines[0].sessionId).toBe(session.getSessionId());
      expect(lines.length).toBe(1 + session.getEntries().length); // meta + 全部 entry（含分支）
      const types = lines.map((l) => l.type);
      expect(types).toContain("message");
      expect(types).toContain("compaction");
      // 树结构保留：两个分支的消息都在
      const contents = lines.filter((l) => l.type === "message").map((l) => l.data.content);
      expect(contents).toContain("回答A");
      expect(contents).toContain("回答B");
      // 事件行带 time（epoch ms）与 parentId 树关系
      for (const l of lines.slice(1)) {
        expect(typeof l.time).toBe("number");
        expect(l.id).toBeTruthy();
        expect("parentId" in l).toBe(true);
      }
    });

    it("保留运行时补记的 durationMs/usage/toolError 并推导旧会话耗时", async () => {
      session.appendMessage(u("问题"));
      // 毫秒间隔，确保相邻 entry 时间戳可差（同一毫秒写入时 diff=0 不推导）
      await new Promise((r) => setTimeout(r, 3));
      session.appendMessage(a("回复", { durationMs: 1500, usage: { input: 10, output: 5, totalTokens: 15 } as ChatMessage["usage"] }));
      session.appendMessage(toolMsg("ok", { durationMs: 80, toolError: true }));
      const out = path.join(tmp, "trace.jsonl");
      exportSessionToAnalysisTrace(session, out);
      const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const msgs = lines.filter((l) => l.type === "message").map((l) => l.data);
      const assistant = msgs.find((m) => m.role === "assistant");
      expect(assistant.durationMs).toBe(1500);
      expect(assistant.usage.input).toBe(10);
      const tool = msgs.find((m) => m.role === "tool");
      expect(tool.durationMs).toBe(80);
      expect(tool.toolError).toBe(true);
      // 无 durationMs 的 user 消息：由相邻 entry 时间差推导
      const user = msgs.find((m) => m.role === "user");
      expect(typeof user.durationMsInferred).toBe("number");
    });

    it("工具失败内容为 error JSON 时提取结构化 error 对象", () => {
      session.appendMessage(u("go"));
      session.appendMessage(toolMsg(JSON.stringify({ status: "error", message: "权限不足" }), {
        durationMs: 5,
        toolError: true,
      }));
      const out = path.join(tmp, "trace.jsonl");
      exportSessionToAnalysisTrace(session, out);
      const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const tool = lines
        .filter((l) => l.type === "message")
        .map((l) => l.data)
        .find((m) => m.role === "tool");
      expect(tool.toolError).toBe(true);
      expect(tool.error).toEqual({ name: "tool_error", message: "权限不足" });
    });

    it("compaction retainedTail 在 analysis 中保留性能字段（口径与 message 一致）", () => {
      session.appendMessage(u("q"));
      session.appendMessage(a("r", { durationMs: 200, usage: { input: 3, output: 1, totalTokens: 4 } as ChatMessage["usage"] }));
      session.appendCompaction("摘要", 100, [a("tail-msg", { durationMs: 60, usage: { input: 1, output: 1, totalTokens: 2 } as ChatMessage["usage"] })]);
      const out = path.join(tmp, "trace.jsonl");
      exportSessionToAnalysisTrace(session, out);
      const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const comp = lines.find((l) => l.type === "compaction");
      const tail = comp.data.retainedTail[0];
      expect(tail.durationMs).toBe(60);
      expect(tail.usage.totalTokens).toBe(2);
    });
  });

  describe("exportSessionToPortable", () => {
    it("仅导出当前活动分支，线性化 parentId 链，剥离性能字段", () => {
      session.appendMessage(u("第一问"));
      session.appendMessage(a("回答A", { durationMs: 900 }));
      const root = session.getBranch()[0].id;
      session.branch(root);
      session.appendMessage(u("第二问"));
      session.appendMessage(toolMsg("r", { durationMs: 50, toolError: true }));
      session.appendMessage(
        a("回答B", { durationMs: 800, usage: { input: 10, output: 5, totalTokens: 15 } as ChatMessage["usage"] }),
      );

      const out = path.join(tmp, "s.jsonl");
      exportSessionToPortable(session, out);
      const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.length).toBe(1 + session.getBranch().length);
      expect(lines[0].type).toBe("session");
      // 线性链：parentId 顺次指向前一条 entry 的 id
      for (let i = 1; i < lines.length; i++) {
        expect(lines[i].parentId).toBe(i === 1 ? null : lines[i - 1].id);
      }
      // 只含分支消息（无 回答A —— 它在被弃路径上）
      const contents = lines.filter((l) => l.type === "message").map((l) => l.message.content);
      expect(contents).toContain("回答B");
      expect(contents).not.toContain("回答A");
      // 性能字段剥离：耗时/token/失败标记一律不带
      const msgs = lines.filter((l) => l.type === "message").map((l) => l.message);
      for (const m of msgs) {
        expect("durationMs" in m).toBe(false);
        expect("toolError" in m).toBe(false);
        expect("usage" in m).toBe(false);
      }
    });
  });
});