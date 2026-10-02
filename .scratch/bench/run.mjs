#!/usr/bin/env node
/**
 * run.mjs — 在容器里跑 claude-pi 执行权威基准任务，并做官方口径评测
 *
 *   node .scratch/bench/run.mjs --bench=swebench [--tasks=id1,id2] [--concurrency=2] [--timeout=1200000]
 *
 * 每个任务：
 *   1. 起独立容器（工作区 bind mount 到 /testbed，cpi 源码挂 /cpi，插桩挂 /opt）
 *   2. 容器内执行 `node /cpi/bin/cpi.js --mode json < <官方题面>`
 *   3. 取 git diff 作为候选补丁
 *   4. 应用官方测试补丁，跑官方口径的验证（SWE-bench: FAIL_TO_PASS/PASS_TO_PASS；
 *      Polyglot: 原生测试套件；TB2: 官方 /tests/test.sh）
 *   5. 落盘 result.json（含轨迹指针、usage、评测明细）
 *
 * 产物：$ROOT/out/<taskId>/{prompt.txt,agent.stdout.json,agent.stderr.txt,fetch.jsonl,
 *                            patch.diff,result.json,junit.xml}
 */
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import {
  WT, OUT, ROOT, sh, mkdirp, writeJson, writeFile, readFile, rm,
  ensureAgentDir, syncCpiSource, startContainer, stopContainer, dexec,
  sumUsage, extractJson, exists, resolveTestIds, cleanRunArtifacts, resetWorkspace,
} from "./lib.mjs";
import { SWE_BENCH_INSTANCES, POLYGLOT_SELECTION, TB_SELECTION, provisionRepo, pyPathAbs } from "./instances.mjs";
import { runTestGroup, applyTestPatch, parseJunit } from "./evaluate-swebench.mjs";

const argv = process.argv.slice(2);
const argVal = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`${k}=`));
  return hit ? hit.slice(k.length + 1) : d;
};
const bench = argVal("--bench", "swebench");
const only = argVal("--tasks", null);
const concurrency = Number(argVal("--concurrency", "2"));
const timeoutMs = Number(argVal("--timeout", "0"));
const doEval = !argv.includes("--no-eval");
const keepContainer = argv.includes("--keep");
const AGENT_ARGS = argVal("--agent-args", "");

const TB_ROOT = process.env.CPI_TB_ROOT || join(homedir(), "cpi-bench/sources/tb2");

// ------------------------------------------------------------------ 辅助
// ------------------------------------------------------- SWE-bench Verified
async function runSwebench(inst) {
  const repo = join(WT, inst.id, "repo");
  const out = await cleanRunArtifacts(join(OUT, inst.id));
  const cname = `cpi-run-${inst.id}`;
  const t0 = Date.now();
  const rec = { id: inst.id, bench: "swebench", repo: inst.repo, difficulty: inst.difficulty };

  const pyPath = pyPathAbs(inst.repo);
  await startContainer({
    name: cname, workspace: repo, outDir: out,
    // PYTHONPATH 进容器环境：agent 自己跑测试时也要能 import 到被测仓库
    extraEnv: { CPI_BENCH_TASK: inst.id, PYTHONPATH: pyPath },
  });

  try {
    // 0) 复位到基线并屏蔽跑测噪音目录（否则候选补丁里会混进 .agent 会话 jsonl）
    const reset = await resetWorkspace(dexec, cname);
    rec.workspaceReset = reset.ok;
    // 依赖必须在「本容器」里装好：容器是一次性的，之前装在别处等于没装
    const prov = await provisionRepo(dexec, cname, inst.repo);
    rec.provisionExit = prov.code;
    rec.pythonPath = pyPath;
    // 1) agent 执行
    const r = await dexec(cname, `node /cpi/bin/cpi.js --mode json ${AGENT_ARGS} < /out/prompt.txt`, {
      timeoutMs: timeoutMs || 1_500_000,
    });
    rec.agentMs = r.ms;
    rec.agentExit = r.code;
    rec.agentKilled = r.killed;
    await writeFile(join(out, "agent.stdout.txt"), r.stdout);
    await writeFile(join(out, "agent.stderr.txt"), r.stderr);

    const parsed = extractJson(r.stdout);
    rec.jsonPure = parsed.pure;
    rec.jsonTrailing = (parsed.trailing || "").slice(0, 300);
    const turns = parsed.value?.turns || [];
    rec.final = (parsed.value?.final ?? "").slice(0, 2000);
    rec.turns = turns.length;
    rec.usage = sumUsage(turns);
    if (parsed.value) await writeJson(join(out, "turns.json"), parsed.value);

    // 2) 候选补丁
    const d = await dexec(cname, `git add -A && git diff --cached --binary > /out/patch.diff; wc -l < /out/patch.diff`, {
      timeoutMs: 180_000,
    });
    rec.patchLines = Number(d.stdout.trim()) || 0;

    // 3) 评测：按官方口径跑 F2P / P2P（细节见 evaluate-swebench.mjs）
    if (!doEval) { rec.ms = Date.now() - t0; return rec; }
    const tp = await applyTestPatch(dexec, cname, inst);
    rec.testPatchApplied = tp.applied;
    if (!tp.applied) rec.testPatchDetail = tp.detail;

    const f2p = await runTestGroup(dexec, cname, inst.FAIL_TO_PASS, { junitName: "junit-f2p.xml", pyPath, outDir: out });
    rec.f2p = { expected: f2p.expected, matched: f2p.matched, passed: f2p.passed, failed: f2p.failed, missing: f2p.missing, cases: f2p.cases };
    rec.f2pAllPass = f2p.allPass;
    if (!f2p.allPass) rec.f2pTail = f2p.tail;

    // P2P 只在 F2P 全绿时跑（省时：F2P 挂了就不是 resolved）
    if (rec.f2pAllPass && inst.PASS_TO_PASS.length) {
      const p2p = await runTestGroup(dexec, cname, inst.PASS_TO_PASS, { junitName: "junit-p2p.xml", pyPath, outDir: out });
      rec.p2p = { expected: p2p.expected, matched: p2p.matched, passed: p2p.passed, failed: p2p.failed.slice(0, 12), missing: p2p.missing.slice(0, 12), cases: p2p.cases };
      rec.p2pAllPass = p2p.allPass && p2p.matched >= p2p.expected * 0.9;
      rec.p2pConclusive = p2p.matched >= p2p.expected * 0.9;
    }
    rec.resolved = !!rec.f2pAllPass && (rec.p2p ? !!rec.p2pAllPass : true);
    rec.ms = Date.now() - t0;
    return rec;
  } finally {
    if (!keepContainer) await stopContainer(cname);
  }
}

// ------------------------------------------------------------ Aider Polyglot
async function runPolyglot(ex) {
  const repo = join(WT, ex.id, "repo");
  const out = await cleanRunArtifacts(join(OUT, ex.id));
  const cname = `cpi-run-${ex.id}`;
  const t0 = Date.now();
  const rec = { id: ex.id, bench: "polyglot", lang: ex.lang, slug: ex.slug, note: ex.note };

  await startContainer({ name: cname, workspace: repo, outDir: out });
  try {
    await resetWorkspace(dexec, cname);
    const r = await dexec(cname, `node /cpi/bin/cpi.js --mode json ${AGENT_ARGS} < /out/prompt.txt`, {
      timeoutMs: timeoutMs || 900_000,
    });
    rec.agentMs = r.ms;
    rec.agentExit = r.code;
    rec.agentKilled = r.killed;
    await writeFile(join(out, "agent.stdout.txt"), r.stdout);
    await writeFile(join(out, "agent.stderr.txt"), r.stderr);

    const parsed = extractJson(r.stdout);
    rec.jsonPure = parsed.pure;
    rec.jsonTrailing = (parsed.trailing || "").slice(0, 300);
    const turns = parsed.value?.turns || [];
    rec.final = (parsed.value?.final ?? "").slice(0, 2000);
    rec.turns = turns.length;
    rec.usage = sumUsage(turns);
    if (parsed.value) await writeJson(join(out, "turns.json"), parsed.value);

    const d = await dexec(cname, `git add -A && git diff --cached --binary > /out/patch.diff; wc -l < /out/patch.diff`, { timeoutMs: 120_000 });
    rec.patchLines = Number(d.stdout.trim()) || 0;

    if (doEval) {
      const t = await dexec(cname, `rm -f /out/junit.xml && ${ex.testCmd} --junitxml=/out/junit.xml 2>&1 | tail -30`, {
        timeoutMs: 600_000,
      });
      const xml = exists(join(out, "junit.xml")) ? await readFile(join(out, "junit.xml"), "utf8") : "";
      const cases = parseJunit(xml);
      const bad = cases.filter((c) => c.status === "failed" || c.status === "error");
      rec.tests = { total: cases.length, failed: bad.length, failedSample: bad.slice(0, 8).map((c) => c.id) };
      rec.resolved = cases.length > 0 && bad.length === 0;
      if (!rec.resolved) rec.testTail = t.stdout.slice(-1200);
    }
    rec.ms = Date.now() - t0;
    return rec;
  } finally {
    if (!keepContainer) await stopContainer(cname);
  }
}

// ---------------------------------------------------------- Terminal-Bench 2
async function runTerminalBench(task) {
  const out = await cleanRunArtifacts(join(OUT, task.id));
  const cname = `cpi-run-${task.id}`;
  const t0 = Date.now();
  const rec = { id: task.id, bench: "terminalbench", slug: task.slug, note: task.note };
  const testsDir = join(TB_ROOT, task.slug, "tests");
  const logsDir = join(out, "tb-logs");

  await mkdirp(logsDir);
  await startContainer({
    name: cname, image: task.image, workspace: "/tmp", outDir: null,
    extraMounts: [
      `-v ${JSON.stringify(testsDir)}:/tests:ro`,
      `-v ${JSON.stringify(logsDir)}:/logs/verifier`,
      `-v ${JSON.stringify(out)}:/out`,
    ],
    extraEnv: { CPI_FETCH_LOG: "/out/fetch.jsonl" },
  });
  await sh(`docker exec ${cname} mkdir -p /out`, { timeoutMs: 30_000 });

  try {
    const r = await dexec(cname, `node /cpi/bin/cpi.js --mode json ${AGENT_ARGS} < /out/prompt.txt`, {
      timeoutMs: timeoutMs || 1_200_000, workdir: task.workdir,
    });
    rec.agentMs = r.ms;
    rec.agentExit = r.code;
    rec.agentKilled = r.killed;
    await writeFile(join(out, "agent.stdout.txt"), r.stdout);
    await writeFile(join(out, "agent.stderr.txt"), r.stderr);
    const parsed = extractJson(r.stdout);
    rec.jsonPure = parsed.pure;
    rec.jsonTrailing = (parsed.trailing || "").slice(0, 300);
    const turns = parsed.value?.turns || [];
    rec.final = (parsed.value?.final ?? "").slice(0, 2000);
    rec.turns = turns.length;
    rec.usage = sumUsage(turns);
    if (parsed.value) await writeJson(join(out, "turns.json"), parsed.value);

    if (doEval) {
      // 官方 verifier：原地跑 /tests/test.sh。
      //
      // 但它的引导步骤（apt-get update + 从 astral.sh 装 uv）在本网络下跑不通：
      // deb.debian.org 不可达，uvx 还要联网取 Python 3.13。所以限时试一次，
      // 拿不到 reward.txt 就用**同一份官方测试文件**直接 pytest —— 判定口径不变
      // （test.sh 本体也只是 pytest 退码 0 → reward 1），只是把工具引导换成预装。
      const rewardPath = join(logsDir, "reward.txt");
      // 输出重定向到文件、单独 echo 退出码 —— 不能写成 `pytest ... | tail`：
      // 管道的退出码取自 tail（恒 0），会让「收集失败/全红」任务被判成 reward=1。
      const v = await dexec(
        cname,
        `bash /tests/test.sh > /logs/verifier/test-sh.log 2>&1; echo "TEST_SH_EXIT=$?"`,
        { timeoutMs: 420_000, workdir: task.workdir },
      );
      rec.verifierExit = Number((/TEST_SH_EXIT=(\d+)/.exec(v.stdout) || [])[1] ?? NaN);
      const testShLog = join(logsDir, "test-sh.log");
      rec.verifierTail = existsSync(testShLog) ? (await readFile(testShLog, "utf8")).slice(-2000) : v.stdout.slice(-2000);
      let reward = existsSync(rewardPath) ? (await readFile(rewardPath, "utf8")).trim() : null;
      rec.verifierMode = "official-test.sh";
      if (reward !== "1" && reward !== "0") {
        rec.verifierMode = "direct-pytest";
        const d = await dexec(
          cname,
          `python3 -m pytest /tests/test_outputs.py -rA --tb=short -p no:cacheprovider > /logs/verifier/pytest.log 2>&1; echo "PYTEST_EXIT=$?"`,
          { timeoutMs: 900_000, workdir: task.workdir },
        );
        const exit = (/PYTEST_EXIT=(\d+)/.exec(d.stdout) || [])[1];
        rec.verifierExit = exit === undefined ? null : Number(exit);
        const plog = join(logsDir, "pytest.log");
        rec.verifierTail = existsSync(plog) ? (await readFile(plog, "utf8")).slice(-2500) : d.stdout.slice(-2500);
        // collected 0 items 说明测试根本没跑起来（收集期报错），不能算通过
        const collected = /collected (\d+) items?/.exec(rec.verifierTail || "");
        const nCollected = collected ? Number(collected[1]) : null;
        rec.verifierCollected = nCollected;
        reward = rec.verifierExit === 0 && (nCollected === null || nCollected > 0) ? "1" : "0";
      }
      rec.reward = reward;
      rec.resolved = reward === "1";
      const ctrf = join(logsDir, "ctrf.json");
      if (existsSync(ctrf)) {
        try {
          const j = JSON.parse(await readFile(ctrf, "utf8"));
          const tests = j?.results?.tests || [];
          rec.tests = {
            total: tests.length,
            failed: tests.filter((t) => t.status !== "passed").length,
            failedSample: tests.filter((t) => t.status !== "passed").slice(0, 8).map((t) => t.name),
          };
        } catch { /* ctrf 解析失败不影响 reward 判定 */ }
      }
    }
    rec.ms = Date.now() - t0;
    return rec;
  } finally {
    // 终态快照：TB 的 workspace 在镜像里，容器一删就没了 —— 留一份 tar 才能事后重验
    try {
      await sh(
        `docker exec ${cname} tar czf /out/final-workspace.tgz -C ${JSON.stringify(dirname(task.workdir))} ${JSON.stringify(basename(task.workdir))}`,
        { timeoutMs: 300_000 },
      );
    } catch { /* 快照失败不影响判定 */ }
    if (!keepContainer) await stopContainer(cname);
  }
}

// -------------------------------------------------------------------- main
let tasks;
if (bench === "swebench") tasks = SWE_BENCH_INSTANCES.map((i) => ({ id: i.id, kind: "swebench", def: i }));
else if (bench === "polyglot") tasks = POLYGLOT_SELECTION.map((e) => ({ id: e.id, kind: "polyglot", def: e }));
else if (bench === "terminalbench") tasks = TB_SELECTION.map((t) => ({ id: t.id, kind: "tb", def: t }));
else { console.error(`未知 --bench=${bench}`); process.exit(2); }

if (only) {
  const ids = only.split(",");
  tasks = tasks.filter((t) => ids.includes(t.id));
}

const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
await syncCpiSource();
await ensureAgentDir();
// 预检：清掉同名残留容器。残留容器仍持有同一份工作区 bind mount，
// 上一轮没退干净的容器里的 agent 会和新一轮同时写同一个目录（实测交叉污染）。
await sh(`docker rm -f ${tasks.map((t) => `cpi-run-${t.id}`).join(" ")} >/dev/null 2>&1 || true`, { timeoutMs: 180_000 });
console.log(`[${bench}] runId=${runId} tasks=${tasks.length} concurrency=${concurrency}\n`);

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < tasks.length) {
    const t = tasks[cursor++];
    const t0 = Date.now();
    let rec;
    try {
      rec = t.kind === "swebench" ? await runSwebench(t.def)
        : t.kind === "polyglot" ? await runPolyglot(t.def)
        : await runTerminalBench(t.def);
    } catch (e) {
      rec = { id: t.id, bench, error: String(e && e.stack || e), ms: Date.now() - t0 };
    }
    await writeJson(join(OUT, t.id, "result.json"), rec).catch(() => {});
    results.push(rec);
    const u = rec.usage || {};
    const tag = rec.error ? "ERR " : rec.resolved ? "PASS" : "FAIL";
    console.log(
      `${tag} ${t.id.padEnd(30)} ${String(Math.round((rec.ms || 0) / 1000)).padStart(4)}s  ` +
        `turns=${String(rec.turns ?? "-").padStart(3)}  cache=${String(u.cacheHitRatePct ?? "-").padStart(6)}%  ` +
        `in=${String(u.input ?? "-").padStart(7)} cR=${String(u.cacheRead ?? "-").padStart(7)} out=${String(u.output ?? "-").padStart(5)}` +
        (rec.error ? `\n     └─ ${rec.error.split("\n")[0].slice(0, 160)}` : ""),
    );
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

await mkdirp(join(ROOT, "results"));
await writeJson(join(ROOT, "results", `${bench}-${runId}.json`), { runId, bench, results });
const pass = results.filter((r) => r.resolved).length;
console.log(`\n总览: ${pass}/${results.length} resolved`);
console.log(`结果: ${join(ROOT, "results", `${bench}-${runId}.json`)}`);
