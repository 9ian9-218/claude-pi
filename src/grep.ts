/**
 * grep.ts — 基于 ripgrep 的流式内容搜索（参考 pi 的 grep 工具与 DSH 的
 * dsh-tool-fs-search 的模型面设计）。
 *
 * 行为：
 * - rg 流式输出 --json，逐行解析，达到 limit 即终止子进程（不大可能长时间等待）
 * - 输出 `path:line: text`（相对 workdir），行截断 500 字符、总量 50KB
 * - 尊重 .gitignore（rg 默认）；--hidden 让隐藏文件也参与搜索
 * - 无匹配 / 达到 limit / 截断都会在结果尾部给出可行动的提示
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

export const GREP_DEFAULT_LIMIT = 100;
export const GREP_MAX_LINE_LENGTH = 500;
export const GREP_MAX_BYTES = 50 * 1024;
export const GREP_TIMEOUT_MS = 30_000;

export interface GrepArgs {
  pattern: string;
  /** 相对 workdir 的目录或文件；省略 = 整个 workdir */
  path?: string;
  /** 过滤文件的 glob（如 '*.ts'、或 'test' 目录下任意深度的 '*.test.ts'） */
  glob?: string;
  ignore_case?: boolean;
  literal?: boolean;
  limit?: number;
}

export interface GrepRunOptions {
  workdir: string;
  /** rg 路径或命令名；测试可注入 */
  rgPath: string;
  timeoutMs?: number;
}

interface RgMatchEvent {
  type: "match";
  data: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

function truncateLine(text: string, max = GREP_MAX_LINE_LENGTH): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + "…", truncated: true };
}

/**
 * 执行一次 grep 搜索并返回模型面文本结果（对齐本项目工具的错误/
 * 提示均为字符串结果的约定，不抛错——只有基础设施失败返回 Error 前缀）。
 */
export async function runGrepSearch(args: GrepArgs, opts: GrepRunOptions): Promise<string> {
  const { workdir, rgPath } = opts;
  const timeoutMs = opts.timeoutMs ?? GREP_TIMEOUT_MS;
  const rawLimit = args.limit ?? GREP_DEFAULT_LIMIT;
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : GREP_DEFAULT_LIMIT;

  const rawPath = args.path?.trim();
  const searchPath = rawPath ? path.resolve(workdir, rawPath) : workdir;

  const rgArgs = ["--json", "--line-number", "--color=never", "--hidden"];
  if (args.ignore_case) rgArgs.push("--ignore-case");
  if (args.literal) rgArgs.push("--fixed-strings");
  if (args.glob) rgArgs.push("--glob", args.glob);
  rgArgs.push("--", args.pattern, searchPath);

  return new Promise<string>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(rgPath, rgArgs, { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve(`Error: failed to start ripgrep: ${String(e)}`);
      return;
    }
    if (child.stdout === null || child.stderr === null) {
      child.kill();
      resolve("Error: failed to start ripgrep: no output stream");
      return;
    }

    const rl = createInterface({ input: child.stdout });
    let stderr = "";
    const outputLines: string[] = [];
    let matchCount = 0;
    let matchLimitReached = false;
    let linesTruncated = false;
    let byteTotal = 0;
    let byteCapped = false;
    let killed = false;
    let settled = false;

    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      rl.close();
      if (!child.killed) child.kill();
      resolve(text);
    };

    const timer = setTimeout(() => {
      killed = true;
      finish(`Error: grep timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    const pushLine = (text: string) => {
      if (byteCapped) return;
      byteTotal += Buffer.byteLength(text, "utf8") + 1;
      if (byteTotal > GREP_MAX_BYTES) {
        byteCapped = true;
        killed = true;
        child.kill();
        return;
      }
      outputLines.push(text);
    };

    rl.on("line", (raw) => {
      if (!raw.trim() || settled) return;
      let event: RgMatchEvent;
      try {
        event = JSON.parse(raw) as RgMatchEvent;
      } catch {
        return;
      }
      if (event.type !== "match") return;
      matchCount++;
      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const lineText = event.data?.lines?.text ?? "";
      if (filePath === undefined || typeof lineNumber !== "number" || settled) return;
      if (matchCount > limit) {
        matchLimitReached = true;
        killed = true;
        child.kill();
        return;
      }
      const rel = path.isAbsolute(filePath) ? path.relative(workdir, filePath) : filePath;
      const sanitized = lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
      const { text: cut, truncated } = truncateLine(sanitized);
      if (truncated) linesTruncated = true;
      pushLine(`${rel}:${lineNumber}: ${cut}`);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      finish(`Error: failed to run ripgrep: ${err.message}`);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (!killed && code !== 0 && code !== 1) {
        finish(`Error: ripgrep exited with code ${code}: ${stderr.trim()}`);
        return;
      }
      if (matchCount === 0) {
        finish("No matches found");
        return;
      }
      const notices: string[] = [];
      if (matchLimitReached) {
        notices.push(
          `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine the pattern`,
        );
      }
      if (byteCapped) {
        notices.push(`${Math.floor(GREP_MAX_BYTES / 1024)}KB output limit reached`);
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read_file to see full lines`);
      }
      const body = outputLines.join("\n");
      finish(notices.length > 0 ? `${body}\n\n[${notices.join(". ")}]` : body);
    });
  });
}