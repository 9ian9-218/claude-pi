import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { installMockModels } from "../tests/helpers/test-client.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import { setMemoryDir, writeMemoryFile } from "./memory.ts";
import {
  getMemoryScopeId,
  peekMemorySnapshot,
  primeMemorySnapshot,
  refreshMemorySnapshot,
  resetMemorySnapshots,
  setMemoryScopeId,
} from "./memory-scope.ts";
import { DEFAULT_RETRY, resetSettingsCache, setSettingsOverrideForTest } from "./settings.ts";

let mock: MockOpenAI;
let dir: string;

beforeEach(async () => {
  resetClient();
  mock = await MockOpenAI.create();
  installMockModels(mock.baseUrl);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-memscope-"));
  setMemoryDir(dir);
  resetMemorySnapshots();
  resetSettingsCache();
});

afterEach(async () => {
  setSettingsOverrideForTest(null);
  resetSettingsCache();
  resetMemorySnapshots();
  resetClient();
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 记忆相关性检索是一次 completeText 调用 → 需要 mock 一个选择结果（注意：文件按名字排序） */
function mockMemorySelection(index = 0): void {
  mock.push(() => ({ kind: "sse", chunks: [{ content: `[${index}]`, finishReason: "stop" }] }));
}

describe("会话级记忆快照（前缀稳定性）", () => {
  it("同一会话内冻结：快照生成后新写入的记忆不影响当前会话", async () => {
    writeMemoryFile("first", "project", "first note", "FIRST BODY");
    mockMemorySelection();
    const seed: ChatMessage[] = [{ role: "user", content: "about first" }];

    const snapshot = await primeMemorySnapshot(seed, "session-A");
    expect(snapshot.index).toContain("first");
    expect(snapshot.injected).toContain("FIRST BODY");

    // 会话进行中：Stop hook 抽取/更新记忆库
    writeMemoryFile("second", "project", "second note", "SECOND BODY");

    // 当前会话仍然拿到旧快照（前缀不变）
    const peeked = peekMemorySnapshot();
    expect(getMemoryScopeId()).toBe("session-A");
    expect(peeked).toBe(snapshot);
    expect(peeked.injected).not.toContain("SECOND BODY");
    // 二次 prime 不会重算（不产生额外的检索调用）
    const again = await primeMemorySnapshot(seed);
    expect(again).toBe(snapshot);
    expect(mock.requests).toHaveLength(1);
  });

  it("新会话（新 scope）拿到更新后的记忆", async () => {
    writeMemoryFile("first", "project", "first note", "FIRST BODY");
    mockMemorySelection();
    await primeMemorySnapshot([{ role: "user", content: "about first" }], "session-A");

    writeMemoryFile("second", "project", "second note", "SECOND BODY");
    mockMemorySelection(1); // first.md / second.md → 第二份
    const fresh = await primeMemorySnapshot([{ role: "user", content: "about second" }], "session-B");

    expect(fresh.index).toContain("second");
    expect(fresh.injected).toContain("SECOND BODY");
    // 两个 scope 的快照彼此独立
    expect(peekMemorySnapshot()).toBe(fresh);
  });

  it("未 prime 时 peek 只给索引，不触发检索调用", () => {
    writeMemoryFile("first", "project", "first note", "FIRST BODY");
    setMemoryScopeId("session-C");
    const peeked = peekMemorySnapshot();
    expect(peeked.index).toContain("first");
    expect(peeked.injected).toBe("");
    expect(mock.requests).toHaveLength(0);
  });

  it("refreshMemorySnapshot 立即重算（区别于 prime 的冻结）", async () => {
    writeMemoryFile("first", "project", "first note", "FIRST BODY");
    mockMemorySelection(0);
    const seed: ChatMessage[] = [{ role: "user", content: "about first" }];
    const frozen = await primeMemorySnapshot(seed, "session-E");
    expect(frozen.injected).toContain("FIRST BODY");

    // 新记忆落盘：prime 不重算，refresh 立刻生效
    writeMemoryFile("second", "project", "second note", "SECOND BODY");
    mockMemorySelection(1);
    const refreshed = await refreshMemorySnapshot(seed, "session-E");
    expect(refreshed.index).toContain("second");
    expect(refreshed.injected).toContain("SECOND BODY");
    // 刷新后 peek 看到的就是新快照（当前会话立即生效）
    expect(peekMemorySnapshot()).toBe(refreshed);
    expect(frozen).not.toBe(refreshed);
  });

  it("settings.memory.enabled=false 时快照为空且不调用检索", async () => {
    setSettingsOverrideForTest({ retry: DEFAULT_RETRY, memory: { enabled: false } });
    writeMemoryFile("first", "project", "first note", "FIRST BODY");
    const snapshot = await primeMemorySnapshot([{ role: "user", content: "about first" }], "session-D");
    expect(snapshot).toEqual({ index: "", injected: "" });
    expect(peekMemorySnapshot()).toEqual({ index: "", injected: "" });
    expect(mock.requests).toHaveLength(0);
  });
});