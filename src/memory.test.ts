import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import {
  setMemoryDir,
  parseFrontmatter,
  writeMemoryFile,
  readMemoryIndex,
  readMemoryFile,
  listMemoryFiles,
  selectRelevantMemories,
  loadMemories,
  findMemoryInjectionIndex,
  snapshotMessages,
  extractMemories,
  consolidateMemories,
  memoryStopHook,
  MEMORY_TYPES,
} from "./memory.ts";

const originalEnv = { ...process.env };
let mock: MockOpenAI;
let dir: string;

beforeEach(async () => {
  process.env = { ...originalEnv };
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "gpt-test";
  resetClient();
  mock = await MockOpenAI.create();
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-mem-"));
  setMemoryDir(dir);
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("frontmatter / 文件 / 索引（S5）", () => {
  it("parseFrontmatter 解析元数据", () => {
    const [meta, body] = parseFrontmatter('---\nname: test-mem\ndescription: "a desc"\ntype: project\n---\n\nbody text');
    expect(meta.name).toBe("test-mem");
    expect(meta.description).toBe("a desc");
    expect(meta.type).toBe("project");
    expect(body).toBe("body text");
  });

  it("writeMemoryFile 写文件并重建索引", () => {
    writeMemoryFile("My Memory", "project", "project fact", "content here");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files).toContain("my-memory.md");
    const index = readMemoryIndex();
    expect(index).toContain("[My Memory](my-memory.md)");
    expect(index).toContain("project fact");
  });

  it("readMemoryFile / listMemoryFiles", () => {
    writeMemoryFile("mem-a", "user", "desc a", "body a");
    expect(readMemoryFile("mem-a.md")).toContain("body a");
    expect(readMemoryFile("nope.md")).toBeNull();
    const list = listMemoryFiles();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("mem-a");
    expect(list[0].type).toBe("user");
  });
});

describe("selectRelevantMemories（S5）", () => {
  it("LLM 返回索引时选择对应文件", async () => {
    writeMemoryFile("proj-arch", "project", "architecture decisions", "body");
    writeMemoryFile("unrelated", "user", "hobby stuff", "body");
    mock.always(() => ({ kind: "json", content: "[0]" }));
    const selected = await selectRelevantMemories([{ role: "user", content: "architecture?" } as ChatMessage]);
    expect(selected).toEqual(["proj-arch.md"]);
  });

  it("LLM 失败时回退关键词匹配", async () => {
    writeMemoryFile("auth-flow", "project", "auth flow design", "body");
    writeMemoryFile("other", "user", "nothing related", "body");
    mock.always(() => ({ kind: "error", status: 500, body: "boom" }));
    const selected = await selectRelevantMemories([{ role: "user", content: "show me the auth design" } as ChatMessage]);
    expect(selected).toContain("auth-flow.md");
    expect(selected).not.toContain("other.md");
  });

  it("无记忆文件时返回空", async () => {
    const selected = await selectRelevantMemories([{ role: "user", content: "hi" } as ChatMessage]);
    expect(selected).toEqual([]);
  });
});

describe("loadMemories / 注入索引（S5）", () => {
  it("loadMemories 包装 <relevant_memories>", async () => {
    writeMemoryFile("mem-x", "user", "desc", "body x");
    mock.always(() => ({ kind: "json", content: "[0]" }));
    const loaded = await loadMemories([{ role: "user", content: "mem-x?" } as ChatMessage]);
    expect(loaded).toContain("<relevant_memories>");
    expect(loaded).toContain("body x");
    expect(loaded).toContain("</relevant_memories>");
  });

  it("findMemoryInjectionIndex 跳过占位/已注入消息", () => {
    const msgs = [
      { role: "user", content: "first" },
      { role: "user", content: "[snipped 5 messages]" },
      { role: "user", content: "<relevant_memories>...already" },
      { role: "user", content: "latest" },
    ] as ChatMessage[];
    expect(findMemoryInjectionIndex(msgs)).toBe(3);
  });

  it("snapshotMessages 深拷贝消息列表", () => {
    const msgs = [{ role: "user", content: "a" } as ChatMessage];
    const snap = snapshotMessages(msgs);
    snap[0].content = "changed";
    expect(msgs[0].content).toBe("a");
  });
});

describe("extractMemories（S5）", () => {
  it("Stop 提取：LLM 返回数组时落盘", async () => {
    mock.always(() => ({
      kind: "json",
      content: JSON.stringify([
        { name: "proj-goal", type: "project", description: "goal desc", body: "goal body" },
      ]),
    }));
    await extractMemories([{ role: "user", content: "our goal is X" } as ChatMessage]);
    expect(readMemoryFile("proj-goal.md")).toContain("goal body");
    expect(readMemoryIndex()).toContain("proj-goal");
  });

  it("空数组不写文件", async () => {
    mock.always(() => ({ kind: "json", content: "[]" }));
    await extractMemories([{ role: "user", content: "hi" } as ChatMessage]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });
});

describe("consolidateMemories（S5）", () => {
  it("低于阈值不触发", async () => {
    writeMemoryFile("a", "user", "d", "b");
    await consolidateMemories();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".md"))).toContain("a.md");
  });

  it("达到阈值时合并（mock 返回合并结果）", async () => {
    for (let i = 0; i < 30; i++) writeMemoryFile(`mem-${i}`, "user", `d${i}`, `b${i}`);
    mock.always(() => ({
      kind: "json",
      content: JSON.stringify([
        { name: "merged", type: "project", description: "merged desc", body: "merged body" },
      ]),
    }));
    await consolidateMemories();
    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(remaining).toContain("merged.md"); // MEMORY.md 索引保留（Python 行为）
    expect(remaining.some((f) => f.startsWith("mem-"))).toBe(false);
  });
});

describe("memoryStopHook（S5）", () => {
  it("fire-and-forget：预压缩快照提取，不阻塞", async () => {
    mock.always(() => ({
      kind: "json",
      content: JSON.stringify([
        { name: "stop-mem", type: "user", description: "d", body: "b" },
      ]),
    }));
    const messages = [{ role: "user", content: "remember this" } as ChatMessage];
    const snap = snapshotMessages(messages);
    memoryStopHook(messages, snap, false);
    // 轮询等待异步提取完成
    await vi.waitFor(() => {
      expect(readMemoryFile("stop-mem.md")).toContain("b");
    }, { timeout: 5000, interval: 50 });
  });

  it("subagent 跳过提取", () => {
    memoryStopHook([], [], true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });
});
