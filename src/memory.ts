/**
 * memory.ts — Markdown 长期记忆（对齐 src/memory.py）
 *
 * 记忆文件带 frontmatter（name/description/type），MEMORY.md 为索引。
 * Stop hook 异步提取（fire-and-forget）；loadMemories 按相关性注入上下文。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, resolveAgentDirs } from "./config.ts";
import { getClient, type ChatMessage } from "./client.ts";
import {
  formatSelectMemories,
  formatExtractMemories,
  formatConsolidateMemories,
  RELEVANT_MEMORIES_OPEN,
  RELEVANT_MEMORIES_CLOSE,
} from "./prompt.ts";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"];
export const CONSOLIDATE_THRESHOLD = 30;

// 测试可注入（setMemoryDir）；默认 .agent/memory
let memoryDir: string = resolveAgentDirs(PROJECT_ROOT).memoryDir;

export function setMemoryDir(dir: string): void {
  memoryDir = dir;
}

export function getMemoryDir(): string {
  return memoryDir;
}

export function memoryIndexPath(): string {
  return path.join(memoryDir, "MEMORY.md");
}

export function parseFrontmatter(text: string): [Record<string, string>, string] {
  if (!text.startsWith("---")) return [{}, text];
  const parts = text.split("---", 3);
  if (parts.length < 3) return [{}, text];
  const meta: Record<string, string> = {};
  for (const line of parts[1].trim().split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      meta[k] = v;
    }
  }
  return [meta, parts[2].trim()];
}

export function writeMemoryFile(name: string, memType: string, description: string, body: string): string {
  const slug = name.toLowerCase().replace(/ /g, "-").replace(/\//g, "-");
  const filename = `${slug}.md`;
  const filepath = path.join(memoryDir, filename);
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(filepath, `---\nname: ${name}\ndescription: ${description}\ntype: ${memType}\n---\n\n${body}\n`);
  rebuildIndex();
  return filepath;
}

export function rebuildIndex(): void {
  fs.mkdirSync(memoryDir, { recursive: true });
  const lines: string[] = [];
  for (const f of fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md")).sort()) {
    if (f === "MEMORY.md") continue;
    const raw = fs.readFileSync(path.join(memoryDir, f), "utf8");
    const [meta, body] = parseFrontmatter(raw);
    const name = meta.name ?? f.replace(/\.md$/, "");
    const desc = meta.description ?? body.split("\n")[0].slice(0, 80);
    lines.push(`- [${name}](${f}) — ${desc}`);
  }
  fs.writeFileSync(memoryIndexPath(), lines.length > 0 ? lines.join("\n") + "\n" : "");
}

export function readMemoryIndex(): string {
  if (!fs.existsSync(memoryIndexPath())) return "";
  return fs.readFileSync(memoryIndexPath(), "utf8").trim();
}

export function readMemoryFile(filename: string): string | null {
  const p = path.join(memoryDir, filename);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

export interface MemoryFileInfo {
  filename: string;
  name: string;
  description: string;
  type: string;
  body: string;
}

export function listMemoryFiles(): MemoryFileInfo[] {
  if (!fs.existsSync(memoryDir)) return [];
  const result: MemoryFileInfo[] = [];
  for (const f of fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md")).sort()) {
    if (f === "MEMORY.md") continue;
    const raw = fs.readFileSync(path.join(memoryDir, f), "utf8");
    const [meta, body] = parseFrontmatter(raw);
    result.push({
      filename: f,
      name: meta.name ?? f.replace(/\.md$/, ""),
      description: meta.description ?? "",
      type: meta.type ?? "user",
      body,
    });
  }
  return result;
}

export async function selectRelevantMemories(messages: ChatMessage[], maxItems = 5): Promise<string[]> {
  const files = listMemoryFiles();
  if (files.length === 0) return [];

  const recentTexts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const content = Array.isArray(msg.content)
      ? msg.content.map((b) => (typeof b === "object" && b !== null && "text" in b ? String(b.text) : "")).join(" ")
      : typeof msg.content === "string"
        ? msg.content
        : "";
    if (content) recentTexts.push(content);
    if (recentTexts.length >= 3) break;
  }
  const recent = [...recentTexts].reverse().join(" ").slice(0, 2000);
  if (!recent.trim()) return [];

  const catalog = files.map((f, i) => `${i}: ${f.name} — ${f.description}`).join("\n");
  const prompt = formatSelectMemories(recent, catalog);

  try {
    const response = await getClient().chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    });
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    const match = text.match(/\[.*?\]/s);
    if (match) {
      const indices = JSON.parse(match[0]) as unknown[];
      const selected: string[] = [];
      for (const idx of indices) {
        if (typeof idx === "number" && idx >= 0 && idx < files.length) {
          selected.push(files[idx].filename);
          if (selected.length >= maxItems) break;
        }
      }
      return selected;
    }
  } catch {
    // fall through to keyword matching
  }

  // Fallback: 关键词匹配
  const keywords = recent.split(/\s+/).map((w) => w.toLowerCase()).filter((w) => w.length > 3);
  const selected: string[] = [];
  for (const f of files) {
    const text = `${f.name} ${f.description}`.toLowerCase();
    if (keywords.some((kw) => text.includes(kw))) {
      selected.push(f.filename);
      if (selected.length >= maxItems) break;
    }
  }
  return selected;
}

export async function loadMemories(messages: ChatMessage[]): Promise<string> {
  const selected = await selectRelevantMemories(messages);
  if (selected.length === 0) return "";
  const parts = [RELEVANT_MEMORIES_OPEN];
  for (const filename of selected) {
    const content = readMemoryFile(filename);
    if (content) parts.push(content);
  }
  parts.push(RELEVANT_MEMORIES_CLOSE);
  return parts.join("\n\n");
}

export function findMemoryInjectionIndex(messages: ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content.trim()) continue;
    if (content.startsWith("[snipped ") || content.startsWith("[Compacted]")) continue;
    if (content.startsWith(RELEVANT_MEMORIES_OPEN)) continue;
    return i;
  }
  return null;
}

export function snapshotMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({ ...m }));
}

export async function extractMemories(messages: ChatMessage[]): Promise<void> {
  const dialogueParts: string[] = [];
  for (const msg of messages.slice(-10)) {
    const role = msg.role ?? "?";
    let content = Array.isArray(msg.content)
      ? msg.content.map((b) => (typeof b === "object" && b !== null && "text" in b ? String(b.text) : "")).join(" ")
      : typeof msg.content === "string"
        ? msg.content
        : "";
    if (content.trim()) dialogueParts.push(`${role}: ${content}`);
  }
  const dialogue = dialogueParts.join("\n");
  if (!dialogue.trim()) return;

  const existing = listMemoryFiles();
  const existingDesc = existing.length > 0
    ? existing.map((m) => `- ${m.name}: ${m.description}`).join("\n")
    : "(none)";

  const prompt = formatExtractMemories(existingDesc, dialogue.slice(0, 4000));

  try {
    const response = await getClient().chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
    });
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    const match = text.match(/\[.*\]/s);
    if (!match) return;
    const items = JSON.parse(match[0]) as Array<Record<string, unknown>>;
    if (!Array.isArray(items) || items.length === 0) return;
    let count = 0;
    for (const mem of items) {
      const name = typeof mem.name === "string" ? mem.name : `memory_${Math.trunc(Date.now() / 1000)}`;
      const memType = typeof mem.type === "string" ? mem.type : "user";
      const desc = typeof mem.description === "string" ? mem.description : "";
      const body = typeof mem.body === "string" ? mem.body : "";
      if (desc && body) {
        writeMemoryFile(name, memType, desc, body);
        count += 1;
      }
    }
    if (count > 0) {
      console.log(`\n\x1b[33m[Memory: extracted ${count} new memories]\x1b[0m`);
    }
  } catch {
    // 静默失败（对齐 Python）
  }
}

export async function consolidateMemories(): Promise<void> {
  const files = listMemoryFiles();
  if (files.length < CONSOLIDATE_THRESHOLD) return;

  const catalog = files
    .map((f) => `## ${f.filename}\nname: ${f.name}\ndescription: ${f.description}\n${f.body}`)
    .join("\n\n");
  const prompt = formatConsolidateMemories(catalog.slice(0, 16000), CONSOLIDATE_THRESHOLD);

  try {
    const response = await getClient().chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 3000,
    });
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    const match = text.match(/\[.*\]/s);
    if (!match) return;
    const items = JSON.parse(match[0]) as Array<Record<string, unknown>>;

    // 清空旧文件（保留 MEMORY.md）
    for (const f of fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md"))) {
      if (f !== "MEMORY.md") fs.unlinkSync(path.join(memoryDir, f));
    }

    for (const mem of items) {
      const name = typeof mem.name === "string" ? mem.name : `memory_${Math.trunc(Date.now() / 1000)}`;
      const memType = typeof mem.type === "string" ? mem.type : "user";
      const desc = typeof mem.description === "string" ? mem.description : "";
      const body = typeof mem.body === "string" ? mem.body : "";
      if (desc && body) writeMemoryFile(name, memType, desc, body);
    }
    console.log(`\n\x1b[33m[Memory: consolidated ${files.length} → ${items.length} memories]\x1b[0m`);
  } catch {
    // 静默失败
  }
}

/**
 * Stop hook：模型自然结束时异步提取记忆（fire-and-forget，不阻塞主循环）。
 * 对齐 Python memory_stop_hook：subagent 或 pre_compress 为空时跳过。
 */
export function memoryStopHook(
  _messages: ChatMessage[],
  preCompress: ChatMessage[] | null | undefined,
  isSubagent: boolean,
): void {
  if (isSubagent || !preCompress) return;
  void (async () => {
    try {
      await extractMemories(preCompress);
      await consolidateMemories();
    } catch {
      // 静默失败
    }
  })();
}
