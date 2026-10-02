#!/usr/bin/env node
/**
 * claude-pi harness 评测 runner。
 *
 * 用法：
 *   node .scratch/eval/run.mjs                     # 全部任务
 *   node .scratch/eval/run.mjs --only cache         # 只跑某类别
 *   node .scratch/eval/run.mjs --tasks f-read-answer,c-multiturn-5
 *   node .scratch/eval/run.mjs --concurrency 4      # 并发（缓存任务建议 1）
 *
 * 产物：.scratch/eval/results/<runId>.jsonl + <runId>.summary.json
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { tasks as ALL_TASKS } from "./tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const CPI = join(REPO, "bin/cpi.js");
const AGENT_DIR = process.env.CPI_EVAL_AGENT_DIR || join(os.homedir(), ".claude-pi-eval");
const RUN_ROOT = process.env.CPI_EVAL_RUN_ROOT || "/tmp/cpi-eval-runs";

// ---------- args ----------
const argv = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const only = argVal("--only", null);
const onlyIds = argVal("--tasks", null);
const concurrency = Number(argVal("--concurrency", "1"));
const timeoutMs = Number(argVal("--timeout", "420000"));
const repeatOverride = argVal("--repeat", null);
const quiet = argv.includes("--quiet");

const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN_DIR = join(RUN_ROOT, runId);

// ---------- helpers ----------
async function wf(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function extractJson(stdout) {
  const start = stdout.indexOf("{");
  if (start < 0) return { value: null, trailing: stdout, pure: false };
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < stdout.length; i++) {
    const c = stdout[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const raw = stdout.slice(start, i + 1);
        try {
          return { value: JSON.parse(raw), trailing: stdout.slice(i + 1).trim(), pure: stdout.slice(i + 1).trim() === "" };
        } catch (e) {
          return { value: null, trailing: stdout.slice(i + 1).trim(), pure: false, parseError: String(e) };
        }
      }
    }
  }
  return { value: null, trailing: stdout.slice(start).trim(), pure: false, parseError: "unbalanced" };
}

function sumUsage(turns) {
  const agg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 };
  let assistantTurns = 0;
  for (const t of turns || []) {
    if (t.role !== "assistant") continue;
    assistantTurns++;
    const u = t.usage;
    if (!u) continue;
    agg.input += u.input || 0;
    agg.output += u.output || 0;
    agg.cacheRead += u.cacheRead || 0;
    agg.cacheWrite += u.cacheWrite || 0;
    agg.reasoning += u.reasoning || 0;
    agg.totalTokens += u.totalTokens || 0;
    agg.cost += (u.cost && u.cost.total) || 0;
  }
  const denom = agg.input + agg.cacheRead + agg.cacheWrite;
  agg.cacheHitRatePct = denom > 0 ? +((agg.cacheRead / denom) * 100).toFixed(2) : null;
  agg.assistantTurns = assistantTurns;
  return agg;
}

function collectTools(turns) {
  const byName = {};
  let errors = 0;
  let perMessageMax = 0;
  for (const t of turns || []) {
    if (t.role === "assistant" && Array.isArray(t.tool_calls)) {
      perMessageMax = Math.max(perMessageMax, t.tool_calls.length);
      for (const tc of t.tool_calls) {
        const n = tc?.function?.name ?? "?";
        byName[n] = (byName[n] || 0) + 1;
      }
    }
    if (t.role === "tool" && t.toolError) errors++;
  }
  const total = Object.values(byName).reduce((a, b) => a + b, 0);
  return { total, byName, errors, perMessageMax };
}

function runOnce({ ws, prompt, args, stdin, extraEnv, agentDir }) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CPI, ...args], {
      cwd: ws,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir || AGENT_DIR, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      out += "\n[[KILLED_BY_TIMEOUT]]";
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, out, err, ms: Date.now() - started });
    });
    if (stdin !== undefined && stdin !== null) child.stdin.end(stdin);
    else if (prompt !== null && prompt !== undefined) child.stdin.end(prompt + "\n");
    else child.stdin.end();
  });
}

async function bashCapture(ws, cmd) {
  return new Promise((res) => {
    const c = spawn("bash", ["-lc", cmd], { cwd: ws });
    let o = "", e = "";
    c.stdout.on("data", (d) => (o += d));
    c.stderr.on("data", (d) => (e += d));
    c.on("close", (code) => res({ code, stdout: o.trim(), stderr: e.trim() }));
  });
}

const p = (ws, path) => (isAbsolute(path) ? path : join(ws, path));

async function evaluate(checks, ctx) {
  const results = [];
  for (const check of checks || []) {
    const [kind, spec] = Object.entries(check)[0];
    let pass = false, detail = "";
    try {
      switch (kind) {
        case "exit_zero": pass = ctx.last.code === 0; detail = `code=${ctx.last.code}`; break;
        case "exit_code": pass = ctx.last.code === spec.equals; detail = `code=${ctx.last.code}`; break;
        case "no_crash": pass = ctx.last.signal === null; detail = `signal=${ctx.last.signal}`; break;
        case "not_killed_by_timeout": pass = !ctx.last.out.includes("[[KILLED_BY_TIMEOUT]]"); break;
        case "file_exists": pass = existsSync(p(ctx.ws, spec.path)); break;
        case "file_not_exists": pass = !existsSync(p(ctx.ws, spec.path)); break;
        case "path_exists": pass = existsSync(spec.path); detail = spec.path; break;
        case "file_equals": {
          const got0 = existsSync(p(ctx.ws, spec.path)) ? await readFile(p(ctx.ws, spec.path), "utf8") : null;
          const got = got0 !== null && spec.trim ? got0.trim() : got0;
          pass = got === spec.equals;
          if (!pass) detail = `got=${JSON.stringify(got)?.slice(0, 120)} want=${JSON.stringify(spec.equals).slice(0, 120)}`;
          break;
        }
        case "file_contains": {
          const got = existsSync(p(ctx.ws, spec.path)) ? await readFile(p(ctx.ws, spec.path), "utf8") : "";
          pass = got.includes(spec.contains);
          if (!pass) detail = `missing ${JSON.stringify(spec.contains).slice(0, 80)}`;
          break;
        }
        case "file_not_contains": {
          const got = existsSync(p(ctx.ws, spec.path)) ? await readFile(p(ctx.ws, spec.path), "utf8") : "";
          pass = !got.includes(spec.contains);
          break;
        }
        case "file_matches": {
          const got = existsSync(p(ctx.ws, spec.path)) ? await readFile(p(ctx.ws, spec.path), "utf8") : "";
          pass = new RegExp(spec.regex, spec.flags || "m").test(got);
          break;
        }
        case "answer_contains": {
          const a = ctx.answer || "";
          pass = spec.contains.every((c) => a.includes(c));
          if (!pass) detail = `answer=${JSON.stringify(a).slice(0, 120)}`;
          break;
        }
        case "answer_matches": {
          const a = ctx.answer || "";
          pass = new RegExp(spec.regex, spec.flags || "i").test(a);
          if (!pass) detail = `answer=${JSON.stringify(a).slice(0, 120)}`;
          break;
        }
        case "raw_stdout_matches": pass = new RegExp(spec.regex, spec.flags || "s").test(ctx.last.out); break;
        case "json_final_nonnull": pass = !!ctx.last.json?.final; detail = `final=${JSON.stringify(ctx.last.json?.final)?.slice(0, 80)}`; break;
        case "tool_used": pass = (ctx.tools.byName[spec.name] || 0) >= (spec.min ?? 1); detail = JSON.stringify(ctx.tools.byName); break;
        case "no_tool_error": pass = ctx.tools.errors === 0; detail = `errors=${ctx.tools.errors}`; break;
        case "bash_output": {
          const r = await bashCapture(ctx.ws, spec.cmd);
          pass = spec.equals !== undefined ? r.stdout === spec.equals : new RegExp(spec.regex).test(r.stdout);
          detail = `stdout=${JSON.stringify(r.stdout).slice(0, 80)}`;
          break;
        }
        default: detail = `unknown check ${kind}`;
      }
    } catch (e) {
      pass = false;
      detail = String(e);
    }
    results.push({ check: kind, pass, detail });
  }
  return results;
}

const stderrSignals = (err) => ({
  cacheMiss: (err.match(/\[cache miss\]/g) || []).length,
  unrecoverable: (err.match(/\[unrecoverable\]/g) || []).length,
  retry: (err.match(/\[retry\]|retrying/gi) || []).length,
  rateLimit: (err.match(/429|rate limit/gi) || []).length,
  compact: (err.match(/\[compact|compact(ed|ion) (triggered|applied)/gi) || []).length,
  budget: (err.match(/\[budget\]|L3|truncat/gi) || []).length,
});

async function runTask(task) {
  const ws = join(RUN_DIR, task.id);
  await rm(ws, { recursive: true, force: true });
  await mkdir(ws, { recursive: true });

  for (const step of task.setup || []) {
    if (step.write) await wf(p(ws, step.write.path), step.write.content);
    else if (step.mkdir) await mkdir(step.mkdir, { recursive: true });
  }

  const args = task.args || ["--mode", "json"];
  const prompts = task.turns ? task.turns : [task.prompt];
  const steps = [];
  let last = null;

  for (const prompt of prompts) {
    last = await runOnce({ ws, prompt, args, stdin: task.stdin, agentDir: task.agentDir });
    const parsed = extractJson(last.out);
    last.json = parsed.value;
    last.jsonPure = parsed.pure;
    last.jsonTrailing = parsed.trailing;
    const turns = parsed.value?.turns || [];
    steps.push({
      prompt: prompt === null ? "(empty stdin)" : prompt.slice(0, 60),
      code: last.code,
      ms: last.ms,
      answer: (parsed.value?.final ?? null)?.slice?.(0, 400) ?? null,
      usage: sumUsage(turns),
      tools: collectTools(turns),
      stderrSignals: stderrSignals(last.err),
      jsonPure: parsed.pure,
      jsonTrailing: parsed.trailing?.slice(0, 120) || "",
    });
    await writeFile(join(RUN_DIR, `${task.id}.stdout.txt`), last.out).catch(() => {});
    await writeFile(join(RUN_DIR, `${task.id}.stderr.txt`), last.err).catch(() => {});
  }

  const allTurns = (last.json?.turns) || [];
  const aggUsage = sumUsage(allTurns);
  const aggTools = collectTools(allTurns);
  const answer = last.json?.final ?? null;

  const checkResults = await evaluate(task.check, { ws, last, answer, tools: aggTools });
  const ok = checkResults.every((c) => c.pass);

  return {
    id: task.id,
    category: task.category,
    ok,
    checks: checkResults,
    steps: steps.map((s) => ({
      code: s.code, ms: s.ms, answer: s.answer, usage: s.usage, tools: s.tools,
      stderrSignals: s.stderrSignals, jsonPure: s.jsonPure, jsonTrailing: s.jsonTrailing,
    })),
    usage: aggUsage,
    tools: aggTools,
    jsonPure: last.jsonPure,
    totalMs: steps.reduce((a, s) => a + s.ms, 0),
    exitCodes: steps.map((s) => s.code),
  };
}

// ---------- scheduler ----------
let selected = ALL_TASKS;
if (only) selected = selected.filter((t) => t.category === only);
if (onlyIds) {
  const ids = onlyIds.split(",").map((s) => s.trim());
  selected = ALL_TASKS.filter((t) => ids.includes(t.id));
}
if (repeatOverride) {
  const n = Number(repeatOverride);
  selected = selected.flatMap((t) => Array.from({ length: n }, () => t));
}
if (only || onlyIds) {
  const unknown = (onlyIds ? onlyIds.split(",").map((s) => s.trim()) : []).filter((id) => !ALL_TASKS.some((t) => t.id === id));
  if (unknown.length) console.error(`[warn] unknown task ids: ${unknown.join(", ")}`);
}

await mkdir(RUN_DIR, { recursive: true });
console.log(`run dir : ${RUN_DIR}`);
console.log(`agent   : ${AGENT_DIR}`);
console.log(`tasks   : ${selected.length}  concurrency=${concurrency}\n`);

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < selected.length) {
    const task = selected[cursor++];
    const t0 = Date.now();
    let r;
    try {
      r = await runTask(task);
    } catch (e) {
      r = { id: task.id, category: task.category, ok: false, error: String(e), checks: [], usage: {}, tools: {}, steps: [], totalMs: Date.now() - t0 };
    }
    results.push(r);
    if (!quiet) {
      const u = r.usage || {};
      const failed = (r.checks || []).filter((c) => !c.pass).map((c) => `${c.check}${c.detail ? "(" + c.detail + ")" : ""}`);
      console.log(
        `${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(24)} ${String(Math.round(r.totalMs / 1000)).padStart(4)}s  ` +
          `cache=${String(u.cacheHitRatePct ?? "-").padStart(6)}%  in=${String(u.input ?? "-").padStart(7)}  ` +
          `cR=${String(u.cacheRead ?? "-").padStart(7)}  out=${String(u.output ?? "-").padStart(5)}  tools=${(r.tools || {}).total ?? 0}` +
          (failed.length ? `\n        └─ ${failed.join("; ")}` : "")
      );
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

results.sort((a, b) => (a.id < b.id ? -1 : 1));
await mkdir(join(HERE, "results"), { recursive: true });
await writeFile(join(HERE, "results", `${runId}.jsonl`), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
await writeFile(join(HERE, "results", `${runId}.summary.json`), JSON.stringify({ runId, agentDir: AGENT_DIR, results }, null, 2));

const pass = results.filter((r) => r.ok).length;
const aggCache = (() => {
  const tot = results.reduce((a, r) => {
    const u = r.usage || {};
    a.input += u.input || 0; a.cacheRead += u.cacheRead || 0; a.cacheWrite += u.cacheWrite || 0; a.out += u.output || 0;
    return a;
  }, { input: 0, cacheRead: 0, cacheWrite: 0, out: 0 });
  const d = tot.input + tot.cacheRead + tot.cacheWrite;
  return { ...tot, hitRate: d ? +((tot.cacheRead / d) * 100).toFixed(2) : null };
})();
console.log(`\n总览: ${pass}/${results.length} 通过`);
console.log(`缓存: 命中率 ${aggCache.hitRate ?? "-"}%  (cacheRead=${aggCache.cacheRead} input=${aggCache.input} cacheWrite=${aggCache.cacheWrite})`);
console.log(`token: 输出 ${aggCache.out}`);
console.log(`结果: ${join(HERE, "results", `${runId}.jsonl`)}`);
