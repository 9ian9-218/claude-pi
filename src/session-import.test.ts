/**
 * session-import.test.ts — 会话导入（/import 命令实现层）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "./session-manager.ts";
import { importSessionFromJsonl } from "./session-import.ts";
import { exportSessionToPortable } from "./session-export.ts";

const ORIG_SESSION_ROOT = process.env.CLAUDE_PI_SESSION_ROOT;

describe("session-import", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-import-"));
    // 会话根隔离：导入/创建都落在临时根，避免污染项目 .agent/sessions
    process.env.CLAUDE_PI_SESSION_ROOT = tmp;
  });

  afterEach(() => {
    if (ORIG_SESSION_ROOT === undefined) delete process.env.CLAUDE_PI_SESSION_ROOT;
    else process.env.CLAUDE_PI_SESSION_ROOT = ORIG_SESSION_ROOT;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("导入 portable JSONL：复制到当前项目会话目录并打开，内容完整", () => {
    // 源会话（别的项目）导出 portable
    const projA = path.join(tmp, "projA");
    fs.mkdirSync(path.join(projA, ".agent"), { recursive: true });
    const src = SessionManager.create(projA);
    src.appendMessage({ role: "user", content: "你好" });
    src.appendMessage({ role: "assistant", content: "你好！" });
    const exported = exportSessionToPortable(src, path.join(tmp, "shared.jsonl"));

    // 导入到当前项目 projB（落在会话根下按 cwd 分组的目录）
    const projB = path.join(tmp, "projB");
    const imported = importSessionFromJsonl(exported, projB);
    expect(imported.getSessionFile()!).toContain(path.join(tmp, `--${projB.replace(/\//g, "-")}--`));
    const msgs = imported
      .getBranch()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: { content?: string } }).message.content);
    expect(msgs).toEqual(["你好", "你好！"]);
    // 导入后的会话可继续使用（append 落盘到副本，不污染源文件）
    imported.appendMessage({ role: "user", content: "继续" });
    const srcAgain = SessionManager.open(exported);
    expect(srcAgain.getBranch()).toHaveLength(2); // 源文件未增长
  });

  it("文件不存在时抛明确错误", () => {
    expect(() => importSessionFromJsonl(path.join(tmp, "nope.jsonl"), tmp)).toThrow(
      /文件不存在|not found/i,
    );
  });

  it("header 非会话文件抛明确错误", () => {
    const bad = path.join(tmp, "bad.jsonl");
    fs.writeFileSync(bad, '{"type":"unknown","version":1}\n');
    expect(() => importSessionFromJsonl(bad, tmp)).toThrow(/不是有效的会话文件|invalid session/i);
  });

  it("空文件/损坏文件抛明确错误", () => {
    const empty = path.join(tmp, "empty.jsonl");
    fs.writeFileSync(empty, "");
    expect(() => importSessionFromJsonl(empty, tmp)).toThrow(/不是有效的会话文件|invalid session/i);
  });
});