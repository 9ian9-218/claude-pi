#!/usr/bin/env node
/**
 * analyze.mjs — 对权威基准跑测结果做两类分析
 *
 *   1. 执行轨迹是否合理：冗余调用、盲改、验证闭环、错误恢复、终止方式
 *   2. 缓存复用是否合理：线上 payload 的前缀稳定性 vs provider 回报的 cacheRead
 *
 * 数据来源（全部为跑测期落盘产物，不重新执行任何东西）：
 *   out/<id>/turns.json    --mode json 的完整会话（含 tool_calls 参数与工具结果）
 *   out/<id>/fetch.jsonl   插桩记录的真实出站请求 payload 哈希
 *   out/<id>/exec.jsonl    插桩记录的真实 shell 退出码
 *   out/<id>/result.json   评测结论
 *   out/<id>/agent.stderr.txt  运行期诊断
 *
 *   node .scratch/bench/analyze.mjs [--bench=swebench] [--tasks=id1,id2]
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ROOT, OUT, mkdirp, writeJson, readFile, readJsonl } from "./lib.mjs";
import { SWE_BENCH_INSTANCES, POLYGLOT_SELECTION, TB_SELECTION } from "./instances.mjs";

const argv = process.argv.slice(2);
const argVal = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`${k}=`));
  return hit ? hit.slice(k.length + 1) : d;
};
const bench = argVal("--bench", null);
const only = argVal("--tasks", null);

// --------------------------------------------------------------- 工具函数
const isReadTool = (n) => ["read_file", "grep", "list_dir", "glob", "ripgrep"].includes(n);
const isEditTool = (n) => ["write_file", "edit_file", "apply_patch", "multi_edit"].includes(n);
const isBash = (n) => n === "run_bash";

/** 模型视角里「这段输出有没有暴露失败」 */
const FAIL_MARKERS = [
  "error", "failed", "failure", "traceback", "no such file", "not found",
  "command not found", "cannot", "can't", "fatal", "usage:", "exception",
  "denied", "refused", "invalid", "unexpected", "assert", "panic",
  "failing", "fail:", "✗", "×",
];
function looksLikeFailure(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  if (t === "(no output)") return false;
  return FAIL_MARKERS.some((m) => t.includes(m));
}

const VERIFY_RE = /(^|[\s;&|])(pytest|python3?\s+-m\s+pytest|python3?\s+-m\s+unittest|npm\s+(test|run\s+test)|yarn\s+test|jest|cargo\s+test|go\s+test|make(\s|$)|tsc(\s|$)|node\s+--test|\.\/tests\/runtests\.py|bash\s+\S*test\S*\.sh|uvx?\s+pytest)/i;
const isVerifyCmd = (c) => VERIFY_RE.test(String(c || ""));

function normalizeArgs(a) {
  try { return JSON.stringify(JSON.parse(a)); } catch { return String(a || ""); }
}

// ------------------------------------------------------------ 轨迹分析
function analyzeTrajectory(turns, execLog, result) {
  const out = { toolCalls: 0, byName: {}, toolErrors: 0 };
  const calls = [];          // 按顺序的全部工具调用
  const byId = new Map();

  let idx = 0;
  for (const t of turns || []) {
    if (t.role === "assistant" && Array.isArray(t.tool_calls) && t.tool_calls.length) {
      for (const tc of t.tool_calls) {
        const rec = {
          order: idx++, name: tc?.function?.name ?? "?",
          args: tc?.function?.arguments ?? "", callId: tc?.id,
          resultText: null, harnessError: false, durationMs: null,
        };
        calls.push(rec);
        byId.set(rec.callId, rec);
        out.byName[rec.name] = (out.byName[rec.name] || 0) + 1;
      }
    } else if (t.role === "tool" && t.tool_call_id && byId.has(t.tool_call_id)) {
      const rec = byId.get(t.tool_call_id);
      rec.resultText = t.content ?? "";
      rec.harnessError = t.toolError === true;
      rec.durationMs = t.durationMs ?? null;
      if (rec.harnessError) out.toolErrors++;
    }
  }
  out.toolCalls = calls.length;
  out.orphanCalls = calls.filter((c) => c.resultText === null).length;

  // 把 run_bash 调用与真实执行记录对齐（按命令文本向前扫描，容忍内部 spawn 交错）
  let cursor = 0;
  const execMatched = [];
  for (const c of calls) {
    if (!isBash(c.name)) continue;
    let command = "";
    try { command = String(JSON.parse(c.args).command ?? ""); } catch { command = ""; }
    let hit = -1;
    for (let i = cursor; i < execLog.length; i++) {
      if (execLog[i].command === command) { hit = i; break; }
    }
    if (hit >= 0) {
      cursor = hit + 1;
      const e = execLog[hit];
      c.exec = e;
      execMatched.push(c);
    }
  }
  out.bashCalls = calls.filter((c) => isBash(c.name)).length;
  out.bashMatched = execMatched.length;

  // 1) 冗余：完全相同的 (工具, 参数)
  const seen = new Map();
  const redundant = [];
  for (const c of calls) {
    const key = `${c.name}::${normalizeArgs(c.args)}`;
    if (seen.has(key)) {
      seen.get(key).repeat++;
      redundant.push({ name: c.name, key: key.slice(0, 160), times: seen.get(key).repeat + 1 });
    } else seen.set(key, { repeat: 0 });
  }
  out.redundantCalls = redundant.length;
  out.redundantSample = redundant.slice(0, 6);

  // 2) 重复读同一文件区间
  const readSeen = new Map();
  let repeatReads = 0;
  for (const c of calls) {
    if (!isReadTool(c.name)) continue;
    let a = {};
    try { a = JSON.parse(c.args); } catch { /* 参数不可解析则跳过统计 */ }
    const k = `${c.name}::${a.path ?? a.pattern ?? ""}::${a.offset ?? ""}::${a.limit ?? ""}`;
    if (readSeen.has(k)) repeatReads++;
    else readSeen.set(k, true);
  }
  out.repeatReads = repeatReads;

  // 3) 盲改：改一个从没读过的文件
  const readPaths = new Set();
  for (const c of calls) {
    if (!isReadTool(c.name)) continue;
    try {
      const a = JSON.parse(c.args);
      if (a.path) readPaths.add(a.path);
    } catch { /* ignore */ }
  }
  const created = new Set();
  const blindEdits = [];
  for (const c of calls) {
    if (!isEditTool(c.name)) continue;
    let a = {};
    try { a = JSON.parse(c.args); } catch { /* ignore */ }
    const p = a.path ?? a.file_path;
    if (!p) continue;
    if (!readPaths.has(p) && !created.has(p)) blindEdits.push({ name: c.name, path: p });
    created.add(p);
  }
  out.blindEdits = blindEdits.length;
  out.blindEditSample = blindEdits.slice(0, 6);

  // 4) 验证闭环：最后一次编辑之后有没有跑验证命令
  let lastEditIdx = -1, lastVerifyIdx = -1, verifyCount = 0;
  calls.forEach((c, i) => {
    if (isEditTool(c.name)) lastEditIdx = i;
    if (c.exec && isVerifyCmd(c.exec.command)) { lastVerifyIdx = i; verifyCount++; }
  });
  out.edits = calls.filter((c) => isEditTool(c.name)).length;
  out.lastEditIdx = lastEditIdx;
  out.lastVerifyIdx = lastVerifyIdx;
  out.verifyCount = verifyCount;
  out.verifyAfterLastEdit = lastEditIdx >= 0 && lastVerifyIdx > lastEditIdx;
  out.verifiedAtAll = verifyCount > 0;

  // 5) 错误恢复
  const execFails = execMatched.filter((c) => c.exec.status !== 0);
  out.execFailed = execFails.length;
  const invisible = execFails.filter((c) => !c.harnessError && !looksLikeFailure(c.resultText));
  out.execFailedInvisible = invisible.length;
  out.execFailedInvisibleSample = invisible.slice(0, 6).map((c) => ({
    command: String(c.exec.command).slice(0, 120),
    status: c.exec.status,
    modelSaw: String(c.resultText ?? "").slice(0, 80),
  }));
  // 连续 3 次相同失败命令 = 打转
  let loops = 0, runLen = 1;
  for (let i = 1; i < execMatched.length; i++) {
    const a = execMatched[i - 1], b = execMatched[i];
    if (a.exec.status !== 0 && b.exec.status !== 0 && a.exec.command === b.exec.command) runLen++;
    else { if (runLen >= 3) loops++; runLen = 1; }
  }
  if (runLen >= 3) loops++;
  out.errorLoops = loops;

  // 6) 终止
  const lastAssistant = [...(turns || [])].reverse().find((t) => t.role === "assistant");
  out.endsWithToolCalls = !!lastAssistant?.tool_calls?.length;
  out.endsWithText = !!lastAssistant?.content;
  out.agentKilled = result?.agentKilled ?? null;
  out.agentExit = result?.agentExit ?? null;
  out.endReason = result?.agentKilled ? "killed"
    : out.endsWithToolCalls ? "tool_calls_without_final"
    : out.endsWithText ? "final_text" : "unknown";

  // 7) 批处理效率
  const batches = (turns || []).filter((t) => t.role === "assistant" && Array.isArray(t.tool_calls)).map((t) => t.tool_calls.length);
  out.parallelBatches = batches.filter((n) => n > 1).length;
  out.maxBatch = batches.length ? Math.max(...batches) : 0;
  out.avgBatch = batches.length ? +(batches.reduce((a, b) => a + b, 0) / batches.length).toFixed(2) : 0;

  // 8) 工具耗时
  const durs = calls.map((c) => c.durationMs).filter((d) => typeof d === "number");
  out.toolMsTotal = durs.reduce((a, b) => a + b, 0);
  out.toolMsMax = durs.length ? Math.max(...durs) : 0;

  return out;
}

// ------------------------------------------------------------ 缓存分析
function analyzeCache(fetchLog, turns, stderr) {
  const out = { requests: fetchLog.length };
  if (!fetchLog.length) return out;

  const sysHashes = fetchLog.map((r) => r.systemHash);
  const toolHashes = fetchLog.map((r) => r.toolsHash);
  out.systemStable = new Set(sysHashes).size === 1;
  out.toolsStable = new Set(toolHashes).size === 1;
  out.systemHash = sysHashes[0];
  out.toolsHash = toolHashes[0];
  out.toolCount = fetchLog[0].toolCount;
  out.distinctSystem = [...new Set(sysHashes)].length;
  out.distinctTools = [...new Set(toolHashes)].length;

  // 逐请求：与上一请求的公共消息前缀 + provider 回报的 cacheRead 对照
  const perReq = [];
  for (let i = 0; i < fetchLog.length; i++) {
    const cur = fetchLog[i], prev = i > 0 ? fetchLog[i - 1] : null;
    let lcp = 0;
    if (prev) {
      const n = Math.min(prev.msgPrefixHashes.length, cur.msgPrefixHashes.length);
      for (let k = 0; k < n; k++) {
        if (prev.msgPrefixHashes[k] === cur.msgPrefixHashes[k]) lcp = k + 1;
        else break;
      }
    }
    const prevPromptChars = prev ? prev.msgs.reduce((a, m) => a + m.len, 0) : 0;
    const sharedChars = lcp > 0 ? cur.msgs.slice(0, lcp).reduce((a, m) => a + m.len, 0) : 0;
    perReq.push({
      i,
      ts: cur.ts,
      sysChanged: prev ? cur.systemHash !== prev.systemHash : false,
      toolsChanged: prev ? cur.toolsHash !== prev.toolsHash : false,
      msgCount: cur.msgCount,
      prevMsgCount: prev ? prev.msgCount : null,
      lcpMessages: prev ? lcp : null,
      appendOnly: prev ? lcp === prev.msgCount : null,
      sharedChars,
      prevPromptChars,
      sharedFracOfPrev: prevPromptChars ? +(sharedChars / prevPromptChars).toFixed(4) : null,
      gapMs: prev ? cur.ts - prev.ts : null,
      totalChars: cur.totalChars,
    });
  }
  out.perRequest = perReq;

  // 历史被改写的位置（非 append-only 的请求）
  const breaks = [];
  for (let i = 1; i < perReq.length; i++) {
    const p = perReq[i];
    if (p.appendOnly === false) {
      breaks.push({ reqIndex: i, divergedAtMessage: p.lcpMessages, prevMsgCount: p.prevMsgCount, msgCount: p.msgCount, sharedFracOfPrev: p.sharedFracOfPrev });
    }
  }
  out.prefixBreaks = breaks.length;
  out.prefixBreakDetail = breaks;

  // 把 usage 接到请求上：用 payload 的消息条数配对，而不是按顺序。
  //
  // 一次请求的 payload 含 system + turns[0..M-2]（turns 不含 system 消息），
  // 所以 msgCount=M 的请求，对应的正是 turns[M-1] 这条 assistant 消息。
  // 按顺序配对在「日志缺记录」时会整体错位（实测某些任务少记了最早几次请求，
  // 顺序配对会把 usage 张冠李戴；按 msgCount 配对则天然免疫）。
  const assistants = (turns || []).filter((t) => t.role === "assistant" && t.usage);
  out.assistantTurns = assistants.length;
  const usageByTurnIndex = new Map();
  (turns || []).forEach((t, i) => { if (t.role === "assistant" && t.usage) usageByTurnIndex.set(i, t.usage); });
  const paired = [];
  const unpairedRequests = [];
  for (let i = 0; i < perReq.length; i++) {
    const u = usageByTurnIndex.get(perReq[i].msgCount - 1);
    if (u) paired.push(u); else { paired.push(null); unpairedRequests.push({ reqIndex: i, msgCount: perReq[i].msgCount }); }
  }
  out.requestsWithoutUsage = unpairedRequests.length;
  out.requestsWithoutUsageSample = unpairedRequests.slice(0, 5);
  out.usageAligned = unpairedRequests.length === 0 && assistants.length === fetchLog.length;
  const assistants2 = paired;
  const n = assistants2.length;
  let hit = 0, total = 0, coverSum = 0, coverN = 0;
  const unexplained = [];
  for (let i = 0; i < n; i++) {
    const u = assistants2[i];
    if (!u) { perReq[i].input = null; continue; }
    const input = u.input || 0, cr = u.cacheRead || 0, cw = u.cacheWrite || 0;
    const promptTokens = input + cr + cw;
    const p = perReq[i];
    p.input = input;
    p.cacheRead = cr;
    p.promptTokens = promptTokens;
    hit += cr; total += promptTokens;
    if (i > 0) {
      const prev = perReq[i - 1];
      // 必须给 cacheWrite 兜底：早先 prev.cacheWrite 是 undefined，
      // 相加得 NaN，`NaN || 0` 又变成 0，覆盖率于是恒为 null。
      const prevPrompt = (prev.input || 0) + (prev.cacheRead || 0) + (prev.cacheWrite || 0);
      // 理论可复用：上一请求整份 prompt（循环式 append-only 时它正是当前前缀）
      const coverage = prevPrompt > 0 ? +(cr / prevPrompt).toFixed(4) : null;
      p.prefixCoverage = coverage;
      if (coverage !== null) { coverSum += coverage; coverN++; }
      // 判为「非预期未命中」：结构上 append-only、间隔远小于缓存 TTL(5min)、却几乎没复用
      if (p.appendOnly && p.gapMs !== null && p.gapMs < 240_000 && coverage !== null && coverage < 0.8) {
        unexplained.push({ reqIndex: i, gapMs: p.gapMs, coverage, prevPrompt, cacheRead: cr });
      }
    }
  }
  out.cacheReadTotal = hit;
  out.promptTokenTotal = total;
  out.cacheHitRatePct = total ? +((hit / total) * 100).toFixed(2) : null;
  out.avgPrefixCoverage = coverN ? +(coverSum / coverN).toFixed(4) : null;
  out.unexplainedMisses = unexplained.length;
  out.unexplainedMissDetail = unexplained.slice(0, 8);

  // 首请求冷启动规模（system + tools + 首条 user）
  const first = perReq[0];
  out.coldStartPromptTokens = first ? (first.input || first.promptTokens || null) : null;

  // 运行期诊断
  const s = String(stderr || "");
  out.diagCacheMiss = (s.match(/\[cache miss\]/g) || []).length;
  out.diagCompact = (s.match(/\[compact|compact(ed|ion)/gi) || []).length;
  out.diagRetry = (s.match(/\[retry\]|retrying/gi) || []).length;
  return out;
}

// -------------------------------------------------------------------- main
const tasks = [];
if (!bench || bench === "swebench") for (const i of SWE_BENCH_INSTANCES) tasks.push({ id: i.id, bench: "swebench" });
if (!bench || bench === "polyglot") for (const e of POLYGLOT_SELECTION) tasks.push({ id: e.id, bench: "polyglot" });
if (!bench || bench === "terminalbench") for (const t of TB_SELECTION) tasks.push({ id: t.id, bench: "terminalbench" });
const selected = only ? tasks.filter((t) => only.split(",").includes(t.id)) : tasks;

// 汇总前的准备：把独立重放的评测结论读进来
const reevalMap = new Map();
for (const f of ["swebench-reeval.json"]) {
  const p = join(ROOT, "results", f);
  if (!existsSync(p)) continue;
  for (const r of JSON.parse(await readFile(p, "utf8"))) reevalMap.set(r.id, r);
}

const analysisDir = join(ROOT, "analysis");
await mkdirp(analysisDir);
const all = [];

for (const t of selected) {
  const dir = join(OUT, t.id);
  const turnsPath = join(dir, "turns.json");
  if (!existsSync(turnsPath)) {
    console.log(`SKIP ${t.id}（无 turns.json）`);
    continue;
  }
  const parsed = JSON.parse(await readFile(turnsPath, "utf8"));
  const turns = parsed.turns || [];
  const execLog = await readJsonl(join(dir, "exec.jsonl"));
  const fetchLog = await readJsonl(join(dir, "fetch.jsonl"));
  const result = existsSync(join(dir, "result.json")) ? JSON.parse(await readFile(join(dir, "result.json"), "utf8")) : {};
  // 评测结论以 reeval（独立重放的官方口径评测）为准：run.mjs 里的结论可能来自旧版评测逻辑
  const reeval = reevalMap.get(t.id);
  if (reeval && !reeval.error) result.resolved = reeval.resolved;
  const stderr = existsSync(join(dir, "agent.stderr.txt")) ? await readFile(join(dir, "agent.stderr.txt"), "utf8") : "";

  const rec = {
    id: t.id,
    bench: t.bench,
    resolved: result.resolved ?? null,
    agentExit: result.agentExit ?? null,
    agentKilled: result.agentKilled ?? null,
    jsonPure: result.jsonPure ?? null,
    patchLines: result.patchLines ?? null,
    verifierMode: result.verifierMode ?? null,
    reward: result.reward ?? null,
    difficulty: result.difficulty ?? null,
    trajectory: analyzeTrajectory(turns, execLog, result),
    cache: analyzeCache(fetchLog, turns, stderr),
    execLogSize: execLog.length,
  };
  await writeJson(join(analysisDir, `${t.id}.json`), rec);
  all.push(rec);

  const tr = rec.trajectory, ca = rec.cache;
  console.log(
    `${rec.resolved ? "PASS" : "FAIL"} ${t.id.padEnd(30)} ` +
      `tools=${String(tr.toolCalls).padStart(3)} bash=${String(tr.bashMatched).padStart(3)} ` +
      `redundant=${String(tr.redundantCalls).padStart(2)} blind=${String(tr.blindEdits).padStart(2)} ` +
      `verify=${tr.verifyCount}${tr.verifyAfterLastEdit ? "✓" : "✗"} ` +
      `failInv=${String(tr.execFailedInvisible).padStart(2)}/${String(tr.execFailed).padStart(2)} ` +
      `| req=${String(ca.requests).padStart(3)} sys=${ca.systemStable ? "稳" : "变"} tools=${ca.toolsStable ? "稳" : "变"} ` +
      `breaks=${String(ca.prefixBreaks).padStart(2)} hit=${String(ca.cacheHitRatePct ?? "-").padStart(6)}% ` +
      `cover=${String(ca.avgPrefixCoverage ?? "-").padStart(5)} unexp=${ca.unexplainedMisses}`,
  );
}

await writeJson(join(analysisDir, "summary.json"), all);

// 汇总
const agg = (f) => all.map(f).filter((v) => typeof v === "number");
const sum = (a) => a.reduce((x, y) => x + y, 0);
console.log("\n================ 汇总 ================");
console.log(`任务 ${all.length}   resolved ${all.filter((r) => r.resolved).length}`);
console.log(`工具调用合计 ${sum(agg((r) => r.trajectory.toolCalls))}  冗余 ${sum(agg((r) => r.trajectory.redundantCalls))}  重复读 ${sum(agg((r) => r.trajectory.repeatReads))}  盲改 ${sum(agg((r) => r.trajectory.blindEdits))}`);
console.log(`shell 调用 ${sum(agg((r) => r.trajectory.bashMatched))}  非零退出 ${sum(agg((r) => r.trajectory.execFailed))}  其中对模型不可见 ${sum(agg((r) => r.trajectory.execFailedInvisible))}`);
console.log(`验证闭环：跑过验证的 ${all.filter((r) => r.trajectory.verifiedAtAll).length}/${all.length}，末次编辑后验证的 ${all.filter((r) => r.trajectory.verifyAfterLastEdit).length}/${all.length}`);
console.log(`前缀结构：system 稳定 ${all.filter((r) => r.cache.systemStable).length}/${all.length}，tools 稳定 ${all.filter((r) => r.cache.toolsStable).length}/${all.length}，出现历史改写 ${sum(agg((r) => r.cache.prefixBreaks))} 次`);
const rq = all.filter((r) => typeof r.cache.cacheHitRatePct === "number");
if (rq.length) {
  const tot = sum(rq.map((r) => r.cache.cacheReadTotal)), den = sum(rq.map((r) => r.cache.promptTokenTotal));
  console.log(`缓存：总体命中率 ${((tot / den) * 100).toFixed(2)}%  （cacheRead=${tot} prompt=${den}）`);
}
console.log(`\n分析产物: ${analysisDir}/<taskId>.json`);
