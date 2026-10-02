#!/usr/bin/env node
/**
 * reeval.mjs — 只重放评测，不重跑 agent
 *
 * 工作区里已留有候选补丁 patch.diff 时，把工作区复位到基线、重新打补丁、按官方口径重评。
 * 评测逻辑修一次就要重跑一次 agent 是不可接受的代价，所以评测必须能独立重放。
 *
 *   node .scratch/bench/reeval.mjs [--tasks=id1,id2] [--concurrency=3]
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  ROOT, WT, OUT, mkdirp, writeJson, readFile,
  ensureAgentDir, syncCpiSource, startContainer, stopContainer, dexec, cleanRunArtifacts,
} from "./lib.mjs";
import { SWE_BENCH_INSTANCES, provisionRepo, pyPathAbs } from "./instances.mjs";
import { runTestGroup, applyTestPatch } from "./evaluate-swebench.mjs";

const argv = process.argv.slice(2);
const argVal = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`${k}=`));
  return hit ? hit.slice(k.length + 1) : d;
};
const only = argVal("--tasks", null);
const concurrency = Number(argVal("--concurrency", "3"));

async function reeval(inst) {
  const repo = join(WT, inst.id, "repo");
  const out = join(OUT, inst.id);
  const patchPath = join(out, "patch.diff");
  if (!existsSync(patchPath)) return { id: inst.id, error: "无 patch.diff，需先跑 agent" };

  const pyPath = pyPathAbs(inst.repo);
  const cname = `cpi-reeval-${inst.id}`;
  await startContainer({ name: cname, workspace: repo, outDir: out, extraEnv: { PYTHONPATH: pyPath } });
  try {
    await provisionRepo(dexec, cname, inst.repo);
    // 复位到基线后重新打候选补丁：容器里 agent 以 root 写过文件，只能在容器内复位
    const reset = await dexec(
      cname,
      // 顺序要紧：先 reset 撤暂存，再 checkout 对齐 HEAD，最后 clean。
      // 早先把 reset 放最后：checkout 会从暂存区恢复，已暂存的改动残留，
      // 于是 git apply 因「已应用」失败，候选补丁实际上没被重新打过。
      `git reset -q 2>/dev/null; git checkout -- . 2>/dev/null; git clean -fdq 2>/dev/null; ` +
        `git diff --quiet 2>/dev/null; echo "clean=$?"; ` +
        `(git apply --whitespace=nowarn /out/patch.diff 2>/out/cand.err || git apply -3 --whitespace=nowarn /out/patch.diff 2>>/out/cand.err); echo "cand=$?"`,
      { timeoutMs: 300_000 },
    );
    const rec = {
      id: inst.id, bench: "swebench", repo: inst.repo, difficulty: inst.difficulty,
      workspaceClean: /clean=0/.test(reset.stdout),
      candidateApplied: /cand=0/.test(reset.stdout),
      patchBytes: (await readFile(patchPath, "utf8")).length,
    };
    if (!rec.candidateApplied) {
      rec.candidateErr = (await dexec(cname, "tail -5 /out/cand.err", { timeoutMs: 30_000 })).stdout;
    }
    const tp = await applyTestPatch(dexec, cname, inst);
    rec.testPatchApplied = tp.applied;
    if (!tp.applied) rec.testPatchDetail = tp.detail;

    const f2p = await runTestGroup(dexec, cname, inst.FAIL_TO_PASS, { junitName: "junit-f2p.xml", pyPath, outDir: out });
    rec.f2p = { expected: f2p.expected, matched: f2p.matched, passed: f2p.passed, failed: f2p.failed, missing: f2p.missing.slice(0, 8), malformed: f2p.malformed.length, cases: f2p.cases };
    rec.f2pAllPass = f2p.allPass;
    if (!f2p.allPass) rec.f2pTail = f2p.tail;

    if (f2p.allPass && inst.PASS_TO_PASS.length) {
      const p2p = await runTestGroup(dexec, cname, inst.PASS_TO_PASS, { junitName: "junit-p2p.xml", pyPath, outDir: out });
      rec.p2p = { expected: p2p.expected, matched: p2p.matched, passed: p2p.passed, failed: p2p.failed.slice(0, 12), missing: p2p.missing.slice(0, 12), malformed: p2p.malformed.length, cases: p2p.cases };
      // matched 太少说明这组 id 没能正确对齐，结论不可用，标记出来而不是当成回归
      // 结论只在「该匹配的都匹配上了」时成立：漏匹配可能是解析问题，
      // 但 malformed id 已在 runTestGroup 里剔除，不参与 expected。
      rec.p2pAllPass = p2p.allPass;
      rec.p2pNoRegression = p2p.noRegression;
      rec.p2pConclusive = p2p.matched === p2p.expected;
    }
    rec.resolved = !!rec.f2pAllPass && (rec.p2p ? !!rec.p2pAllPass : true);
    // 宽松口径：F2P 全过 + P2P 里「匹配上的」全过（忽略官方列表里本就没有的陈旧 id）。
    // 两个口径都记账：严格口径用于对齐官方分数，宽松口径用于回答「agent 到底改对没有」。
    rec.resolvedNoRegression = !!rec.f2pAllPass && (!rec.p2p || rec.p2pNoRegression !== false);
    // 把重评结论回写到 result.json：分析/报告都以 result.json 为准，
    // 不回写就会出现「报告里的分数是旧解析器算的」这种自相矛盾。
    const rp = join(out, "result.json");
    if (existsSync(rp)) {
      try {
        const prev = JSON.parse(await readFile(rp, "utf8"));
        await writeJson(rp, { ...prev, ...rec, reevalAt: new Date().toISOString() });
      } catch { /* 回写失败不影响重评结论 */ }
    } else {
      await writeJson(rp, rec);
    }
    return rec;
  } finally {
    await stopContainer(cname);
  }
}

const instances = SWE_BENCH_INSTANCES.filter((i) => !only || only.split(",").includes(i.id));
await syncCpiSource();
await ensureAgentDir();
console.log(`[reeval] 重放评测 ${instances.length} 个实例\n`);

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < instances.length) {
    const inst = instances[cursor++];
    let r;
    try { r = await reeval(inst); }
    catch (e) { r = { id: inst.id, error: String(e).slice(0, 300) }; }
    results.push(r);
    const p2p = r.p2p ? `p2p=${r.p2p.passed}/${r.p2p.expected}(matched ${r.p2p.matched})` : "p2p=-";
    const tag = r.error ? "ERR " : r.resolved ? "RESOLVED" : r.resolvedNoRegression === true ? "NO-REGR" : "UNRESOLVED";
    console.log(
      `${tag} ${inst.id.padEnd(28)} ` +
        `f2p=${r.f2p ? `${r.f2p.passed}/${r.f2p.expected}(matched ${r.f2p.matched})` : "-"} ${p2p}${r.error ? " " + r.error : ""}`,
    );
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

await writeJson(join(ROOT, "results", "swebench-reeval.json"), results);
const ok = results.filter((r) => r.resolved).length;
const okLoose = results.filter((r) => r.resolvedNoRegression).length;
console.log(`\n重评: 严格口径 ${ok}/${results.length} resolved　宽松口径（无 P2P 回归）${okLoose}/${results.length}`);
