/**
 * parity-runner.ts — 对拍测试（18）
 *
 * 同一场景脚本驱动 Python 版（REPL）与 claude-pi（--mode json），
 * 规范化（去 ANSI/时间戳/路径）后比对工具调用序列与最终回复。
 *
 * 用法：tsx scripts/parity/parity-runner.ts [scenario...]
 * 环境：CLAUDE_PI_PARITY_PYTHON（默认 python3，需安装 openai）
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockOpenAI, type ChatRequest, type Responder } from "../../tests/helpers/mock-openai.ts";
import { createTestAgentDir } from "../../tests/helpers/test-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_PROJECT = "/home/z9ian9/myproject/Claude-Code-simple";
const TS_PROJECT = path.resolve(__dirname, "../..");

interface Scenario {
  name: string;
  prompts: string[]; // 用户输入序列（对话场景多条）
  responder: Responder;
  /** 从 Python stdout 提取最终回复 */
  extractPythonFinal: (stdout: string) => string | null;
  /** 从 TS JSON 提取最终回复 */
  extractTsFinal: (json: unknown) => string | null;
  /** Python 工具调用行（可选比对） */
  extractPythonTools?: (stdout: string) => string[];
  /** TS 工具调用（可选比对） */
  extractTsTools?: (json: unknown) => string[];
}

// ── 场景 ──────────────────────────────────────────────────────────────────

const scenarios: Scenario[] = [
  {
    name: "conversation",
    prompts: ["你好，请自我介绍一下\nq\n"],
    responder: (req) => {
      const content = JSON.stringify(req.messages);
      if (content.includes("select ONLY the indices")) return { kind: "json", content: "[]" };
      if (content.includes("Extract memories")) return { kind: "json", content: "[]" };
      return { kind: "sse", chunks: [{ content: "我是对拍测试助手，你好！", finishReason: "stop" }] };
    },
    extractPythonFinal: (stdout) => {
      // 取 "Model >" 后的内容，截断到 hook 日志标记
      const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
      const idx = clean.lastIndexOf("Model >");
      if (idx < 0) return null;
      let rest = clean.slice(idx + "Model >".length).trim();
      const cut = rest.search(/\[HOOK\]|\[assembled\]|\[cache hit\]/);
      if (cut >= 0) rest = rest.slice(0, cut).trim();
      return rest || null;
    },
    extractTsFinal: (json) => {
      const final = (json as { final?: string | null }).final;
      return final ?? null;
    },
  },
  {
    name: "tool-call",
    prompts: ["读取 README.md 的第一行\nq\n"],
    responder: (req) => {
      const content = JSON.stringify(req.messages);
      if (content.includes("select ONLY the indices")) return { kind: "json", content: "[]" };
      if (content.includes("Extract memories")) return { kind: "json", content: "[]" };
      // 主请求：先 read_file，再 final
      const hasToolResult = content.includes('"role":"tool"');
      if (!hasToolResult) {
        return {
          kind: "sse",
          chunks: [
            {
              toolCalls: [
                {
                  index: 0,
                  id: "call_parity",
                  name: "read_file",
                  arguments: '{"path":"README.md"}',
                },
              ],
              finishReason: "tool_calls",
            },
          ],
        };
      }
      return { kind: "sse", chunks: [{ content: "文件读取完成。", finishReason: "stop" }] };
    },
    extractPythonFinal: (stdout) => {
      const lines = stdout.split("\n");
      const modelLines = lines.filter((l) => l.includes("Model >"));
      return modelLines.length > 0 ? modelLines[modelLines.length - 1].replace(/\x1b\[[0-9;]*m/g, "").split("Model >")[1]?.trim() ?? null : null;
    },
    extractTsFinal: (json) => {
      const final = (json as { final?: string | null }).final;
      return final ?? null;
    },
    extractPythonTools: (stdout) =>
      stdout
        .split("\n")
        .filter((l) => l.includes("Tool >"))
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()),
    extractTsTools: (json) => {
      const turns = (json as { turns?: Array<{ role: string; tool_calls?: Array<{ function: { name: string } }> }> }).turns ?? [];
      return turns
        .filter((t) => t.role === "assistant" && t.tool_calls)
        .map((t) => `Tool >\t ${t.tool_calls![0].function.name}(...)`);
    },
  },
];

// ── 驱动 ──────────────────────────────────────────────────────────────────

function runPythonRepl(prompts: string[], baseUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["main.py"], {
      cwd: PYTHON_PROJECT,
      env: {
        ...process.env,
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: baseUrl,
        OPENAI_MODEL: "gpt-test",
        FALLBACK_MODEL_ID: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Python REPL timeout. stderr: ${stderr.slice(-500)}`));
    }, 30000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout);
    });
    child.stdin.write(prompts.join(""));
  });
}

function runTsJson(prompts: string[], baseUrl: string): Promise<{ json: unknown; stdout: string }> {
  return new Promise((resolve, reject) => {
    const input = prompts.join("").replace(/\nq\n$/, "\n");
    execFile(
      process.execPath,
      [path.resolve(TS_PROJECT, "node_modules/tsx/dist/cli.mjs"), "src/cli.ts", "--mode", "json", "--no-session"],
      {
        cwd: TS_PROJECT,
        env: { ...process.env, PI_CODING_AGENT_DIR: createTestAgentDir(baseUrl) },
        timeout: 30000,
      },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(`TS failed: ${stderr.slice(-500)}`));
          return;
        }
        try {
          resolve({ json: JSON.parse(stdout), stdout });
        } catch (e) {
          reject(new Error(`TS JSON parse failed: ${String(e)}. stdout: ${stdout.slice(-300)}`));
        }
      },
    )?.stdin?.end(input);
  });
}

// ── 规范化与比对 ─────────────────────────────────────────────────────────

function normalize(text: string | null): string {
  return (text ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim();
}

export async function runParity(scenarioNames: string[]): Promise<{ passed: string[]; failed: Array<{ name: string; reason: string }> }> {
  const passed: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  const selected = scenarioNames.length > 0 ? scenarios.filter((s) => scenarioNames.includes(s.name)) : scenarios;

  for (const scenario of selected) {
    const mock = await MockOpenAI.create();
    mock.always(scenario.responder);
    try {
      const pyStdout = await runPythonRepl(scenario.prompts, mock.baseUrl);
      const ts = await runTsJson(scenario.prompts, mock.baseUrl);

      const pyFinal = normalize(scenario.extractPythonFinal(pyStdout));
      const tsFinal = normalize(scenario.extractTsFinal(ts.json));
      const pyTools = scenario.extractPythonTools?.(pyStdout) ?? [];
      const tsTools = scenario.extractTsTools?.(ts.json) ?? [];

      const mismatches: string[] = [];
      if (pyFinal && tsFinal && pyFinal !== tsFinal) {
        mismatches.push(`final 不一致: Python="${pyFinal.slice(0, 60)}" TS="${tsFinal.slice(0, 60)}"`);
      }
      if (pyTools.length !== tsTools.length) {
        mismatches.push(`工具调用数不一致: Python=${pyTools.length} TS=${tsTools.length}`);
      } else {
        for (let i = 0; i < pyTools.length; i++) {
          const pyName = pyTools[i].match(/Tool >\t (\w+)/)?.[1];
          const tsName = tsTools[i].match(/Tool >\t (\w+)/)?.[1];
          if (pyName && tsName && pyName !== tsName) {
            mismatches.push(`第 ${i + 1} 个工具不一致: Python=${pyName} TS=${tsName}`);
          }
        }
      }

      if (mismatches.length === 0) {
        passed.push(scenario.name);
        console.log(`  \x1b[32m✓ ${scenario.name}\x1b[0m (final: ${pyFinal || tsFinal ? "一致" : "均无"})`);
      } else {
        failed.push({ name: scenario.name, reason: mismatches.join("; ") });
        console.log(`  \x1b[31m✗ ${scenario.name}: ${mismatches.join("; ")}\x1b[0m`);
      }
    } catch (e) {
      failed.push({ name: scenario.name, reason: String((e as Error).message) });
      console.log(`  \x1b[31m✗ ${scenario.name}: ${String((e as Error).message)}\x1b[0m`);
    } finally {
      await mock.close();
    }
  }
  return { passed, failed };
}

// CLI 入口
if (import.meta.url === `file://${process.argv[1]}`) {
  const names = process.argv.slice(2);
  const result = await runParity(names);
  console.log(`\n对拍结果: ${result.passed.length} 通过, ${result.failed.length} 失败`);
  if (result.failed.length > 0) {
    for (const f of result.failed) console.log(`  - ${f.name}: ${f.reason}`);
    process.exit(1);
  }
}
