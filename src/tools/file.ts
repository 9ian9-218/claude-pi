/**
 * file.ts — 文件工具 read_file / write_file / edit_file / glob / grep（从 tool.ts 拆出）
 */
import fs from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { globSync } from "glob";
import { getWorkdir } from "../workdir.ts";
import { buildTool } from "./core.ts";
import { runGrepSearch } from "../grep.ts";
import { ensureRipgrep } from "../ripgrep.ts";
import { checkPath, safePath } from "./path.ts";

// ── read_file ─────────────────────────────────────────────────────────────

/** 默认分页行数（对齐 pi/DSH 的 2000 行 cap） */
const READ_DEFAULT_LIMIT = 2000;

interface ReadOutcome {
  /** 模型面展示路径（= 传入的相对路径） */
  displayPath: string;
  lines: Array<{ number: number; text: string }>;
  /** 已读到的总行数；未读到 EOF 时是下界 */
  totalLines: number;
  /** 是否读到了文件末尾（此时 totalLines 即文件总行数） */
  readToEof: boolean;
}

/**
 * 流式分页读取：createReadStream + readline 逐行，跳过 offset-1 行后最多
 * 收集 limit 行即销毁流——大文件不会整体读入内存（对齐 DSH 的流式 read）。
 */
async function readFilePaged(filePath: string, offset: number, limit: number): Promise<ReadOutcome> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: Array<{ number: number; text: string }> = [];
  let totalLines = 0;
  let readToEof = false;
  let stoppedAtLimit = false;
  await new Promise<void>((resolve, reject) => {
    rl.on("line", (text) => {
      totalLines++;
      if (totalLines < offset) return;
      if (lines.length < limit) lines.push({ number: totalLines, text });
      if (lines.length >= limit) {
        stoppedAtLimit = true;
        // rl.close() 一定触发 readline 的 close 事件；destroy 兜底释放底层 fd
        rl.close();
        stream.destroy();
      }
    });
    rl.on("close", () => {
      if (!stoppedAtLimit) readToEof = true;
      resolve();
    });
    stream.on("error", reject);
    rl.on("error", reject);
  });
  return { displayPath: "", lines, totalLines, readToEof };
}

/** DSH 风格输出：<path>/<type>/<content> + 行号 + 分页 footer */
function formatReadOutput(displayPath: string, outcome: ReadOutcome): string {
  const first = outcome.lines[0]?.number ?? 0;
  const last = outcome.lines.at(-1)?.number ?? 0;
  const footer = outcome.readToEof
    ? `(End of file - total ${outcome.totalLines} lines)`
    : `(Showing lines ${first}-${last}. Use offset=${last + 1} to continue.)`;
  const body = outcome.lines.map((l) => `${l.number}: ${l.text}`).join("\n");
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body.length > 0 ? `${body}\n\n${footer}` : footer}
</content>`;
}

async function execReadFile(args: Record<string, unknown>): Promise<string> {
  const p = String(args["path"]);
  const offset = args["offset"] === undefined ? 1 : Number(args["offset"]);
  const limit = args["limit"] === undefined ? READ_DEFAULT_LIMIT : Number(args["limit"]);
  if (!Number.isInteger(offset) || offset < 1) return "Error: offset must be an integer >= 1";
  if (!Number.isInteger(limit) || limit < 1) return "Error: limit must be an integer >= 1";
  let filePath: string;
  try {
    filePath = safePath(p);
  } catch (e) {
    return `Error: ${String(e)}`;
  }
  try {
    const outcome = await readFilePaged(filePath, offset, limit);
    const isEmptyFile = outcome.readToEof && outcome.totalLines === 0;
    if (outcome.lines.length === 0 && !isEmptyFile) {
      return `Error: offset ${offset} is beyond end of file (${outcome.totalLines} lines total)`;
    }
    return formatReadOutput(p, outcome);
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

const READ_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "The path of the file to read" },
    offset: {
      type: "integer",
      description: "1-based first line to return. Defaults to 1.",
    },
    limit: {
      type: "integer",
      description: `Maximum number of lines to return. Defaults to ${READ_DEFAULT_LIMIT}.`,
    },
  },
  required: ["path"],
  additionalProperties: false,
};

export const READ_FILE_TOOL = buildTool({
  name: "read_file",
  description:
    "Read a UTF-8 text file and return line-numbered content. " +
    "Use offset and limit to page through large files — only the requested window is read.",
  parameters: READ_SCHEMA,
  execute: execReadFile,
  isReadOnly: true,
});

// ── write_file ────────────────────────────────────────────────────────────

function execWriteFile(args: Record<string, unknown>): string {
  const p = String(args["path"]);
  const content = String(args["content"]);
  try {
    const filePath = safePath(p);
    fs.writeFileSync(filePath, content);
    return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

const WRITE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "The path of the file to write" },
    content: { type: "string", description: "The content to write into the file" },
  },
  required: ["path", "content"],
  additionalProperties: false,
};

export const WRITE_FILE_TOOL = buildTool({
  name: "write_file",
  description: "Write content to a file at a specific path.",
  parameters: WRITE_SCHEMA,
  execute: execWriteFile,
  isReadOnly: false,
});

// ── edit_file ─────────────────────────────────────────────────────────────

function execEditFile(args: Record<string, unknown>): string {
  const p = String(args["path"]);
  const oldText = String(args["old_text"]);
  const newText = String(args["new_text"]);
  try {
    const filePath = safePath(p);
    const text = fs.readFileSync(filePath, "utf8");
    if (!text.includes(oldText)) {
      return "Error: text not found";
    }
    fs.writeFileSync(filePath, text.replace(oldText, newText)); // 只替换第一处
    return `Edited ${p}`;
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "The path of the file to edit" },
    old_text: { type: "string", description: "Exact text to replace" },
    new_text: { type: "string", description: "Replacement text" },
  },
  required: ["path", "old_text", "new_text"],
  additionalProperties: false,
};

export const EDIT_FILE_TOOL = buildTool({
  name: "edit_file",
  description: "Replace exact text in a file once.",
  parameters: EDIT_SCHEMA,
  execute: execEditFile,
  isReadOnly: false,
});

// ── glob ──────────────────────────────────────────────────────────────────

function execGlob(args: Record<string, unknown>): string {
  const pattern = String(args["pattern"]);
  try {
    return globSync(pattern, { cwd: getWorkdir(), nodir: true }).join("\n");
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

const GLOB_SCHEMA = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description:
        "Glob pattern relative to WORKDIR (e.g. '**/*.py', '.claude/skills/*'). Match case exactly — Linux is case-sensitive.",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
};

export const GLOB_TOOL = buildTool({
  name: "glob",
  description:
    "Match and list files using a glob pattern. Paths are relative to WORKDIR; match case exactly (Linux is case-sensitive).",
  parameters: GLOB_SCHEMA,
  execute: execGlob,
  isReadOnly: true,
});

// ── grep（基于 ripgrep，参考 pi 的 grep 工具） ───────────────────────────

const GREP_SCHEMA = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Regex search pattern (or literal text with literal=true)",
    },
    path: {
      type: "string",
      description: "File or directory to search; omitted = entire workspace",
    },
    glob: {
      type: "string",
      description: "Filter files by glob, e.g. '*.ts' or '**/*.test.ts'",
    },
    ignore_case: {
      type: "boolean",
      description: "Case-insensitive search (default: false)",
    },
    literal: {
      type: "boolean",
      description: "Treat pattern as literal string instead of regex (default: false)",
    },
    limit: {
      type: "integer",
      description: "Maximum number of matches to return (default: 100)",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
};

async function execGrep(args: Record<string, unknown>): Promise<string> {
  const rawPath = args["path"] === undefined ? undefined : String(args["path"]).trim() || undefined;
  if (rawPath !== undefined) {
    const err = checkPath(rawPath);
    if (err !== null) return `Error: ${err}`;
  }
  if (args["limit"] !== undefined) {
    const n = Number(args["limit"]);
    if (!Number.isInteger(n) || n < 1) return "Error: limit must be an integer >= 1";
  }
  let rgPath: string;
  try {
    rgPath = await ensureRipgrep();
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
  return runGrepSearch(
    {
      pattern: String(args["pattern"]),
      path: rawPath,
      glob: args["glob"] === undefined ? undefined : String(args["glob"]),
      ignore_case: args["ignore_case"] === true,
      literal: args["literal"] === true,
      limit: args["limit"] === undefined ? undefined : Number(args["limit"]),
    },
    { workdir: getWorkdir(), rgPath },
  );
}

export const GREP_TOOL = buildTool({
  name: "grep",
  description:
    "Search file contents for a regex pattern, using ripgrep. " +
    "Returns matching lines as 'path:line: text'. Respects .gitignore; " +
    "hidden files are included. Output is capped at 100 matches / 50KB; " +
    "long lines are truncated — use read_file to see full lines.",
  parameters: GREP_SCHEMA,
  execute: execGrep,
  isReadOnly: true,
});

// ── todo_write ────────────────────────────────────────────────────────────
