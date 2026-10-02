#!/usr/bin/env node
/**
 * validate.mjs — 金标对照（环境自检）
 *
 * 对每个实例：干净副本 → 打官方 gold patch → 打官方 test patch → 跑 FAIL_TO_PASS。
 * 期望全绿。若金标都过不了，说明是评测环境有问题，而不是 agent 失败 ——
 * 这一步把「环境失败」与「harness 失败」区分开，否则结果不可解释。
 *
 * 副本创建与清理都在容器内进行：容器里 pytest 以 root 写出的 __pycache__，
 * 宿主用户无权删除（实测 EACCES）。挂载整个 wt 目录后由容器自己做增删更干净。
 *
 *   node .scratch/bench/validate.mjs [--tasks=id1,id2] [--concurrency=3]
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  ROOT, WT, OUT, mkdirp, writeJson, writeFile, readFile, sh,
  ensureAgentDir, syncCpiSource, startContainer, stopContainer, dexec,
} from "./lib.mjs";
import { SWE_BENCH_INSTANCES, provisionRepo, pyPathAbs } from "./instances.mjs";
import { runTestGroup } from "./evaluate-swebench.mjs";

const argv = process.argv.slice(2);
const argVal = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`${k}=`));
  return hit ? hit.slice(k.length + 1) : d;
};
const only = argVal("--tasks", null);
const concurrency = Number(argVal("--concurrency", "3"));

async function validate(inst) {
  const out = join(OUT, inst.id, "gold");
  await mkdirp(out);
  await writeFile(join(out, "gold.patch"), inst.patch);
  await writeFile(join(out, "test_patch.diff"), inst.test_patch);

  const cname = `cpi-gold-${inst.id}`;
  const repo = `/wt/${inst.id}/repo`;
  const gold = `/wt/${inst.id}/gold`;
  const pyPath = `${gold}:${gold}/src`;

  // 只用一个容器，把 /wt 挂进来：
  //   1) 先在容器内把 repo 复位到基线（repo 被 agent 改过，直接 cp 出来的副本
  //      已经含候选补丁，那样的「金标对照」其实在验证 agent 的树，毫无意义）
  //   2) 复制出 gold，再打官方 gold patch + test patch
  // 顺带避开宿主删不掉 root 文件的问题。
  await startContainer({
    name: cname, workspace: "/tmp", outDir: out,
    extraMounts: [`-v ${JSON.stringify(WT)}:/wt`],
  });
  try {
    const setup = await dexec(
      cname,
      `cd ${repo} && git reset -q && git checkout -- . && git clean -fdxq && ` +
        `rm -rf ${gold} && cp -a ${repo} ${gold} && cd ${gold} && ` +
        `(git apply --whitespace=nowarn /out/gold.patch 2>/out/gold.err || git apply -3 --whitespace=nowarn /out/gold.patch 2>>/out/gold.err); echo "gold=$?"; ` +
        `echo "baseline_clean=$(cd ${repo} && git status --porcelain | wc -l)"; ` +
        `(git apply --whitespace=nowarn /out/test_patch.diff 2>/out/test.err || git apply -3 --whitespace=nowarn /out/test_patch.diff 2>>/out/test.err); echo "test=$?"`,
      { timeoutMs: 300_000, workdir: "/tmp" },
    );
    const goldOk = /gold=0/.test(setup.stdout);
    const testOk = /test=0/.test(setup.stdout);
    const baselineClean = /baseline_clean=0/.test(setup.stdout);

    await provisionRepo(dexec, cname, inst.repo, { workdir: gold });
    const g = await runTestGroup(dexec, cname, inst.FAIL_TO_PASS, {
      junitName: "junit-gold-f2p.xml", pyPath, outDir: out, workdir: gold,
    });
    const ok = baselineClean && goldOk && testOk && g.allPass;
    return {
      id: inst.id, baselineClean, goldApplied: goldOk, testPatchApplied: testOk,
      f2p: { expected: g.expected, matched: g.matched, passed: g.passed, failed: g.failed, missing: g.missing },
      ok, tail: ok ? null : (g.tail || setup.stdout).slice(-900),
    };
  } finally {
    await dexec(cname, `rm -rf ${gold}`, { timeoutMs: 120_000, workdir: "/tmp" }).catch(() => {});
    await stopContainer(cname);
  }
}

const instances = SWE_BENCH_INSTANCES.filter((i) => !only || only.split(",").includes(i.id));
await syncCpiSource();
await ensureAgentDir();
console.log(`[gold] 验证 ${instances.length} 个实例的评测环境\n`);

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < instances.length) {
    const inst = instances[cursor++];
    let r;
    try { r = await validate(inst); }
    catch (e) { r = { id: inst.id, ok: false, error: String(e).slice(0, 300) }; }
    results.push(r);
    console.log(
      `${r.ok ? "GOLD-OK  " : "GOLD-FAIL"} ${r.id.padEnd(28)} ` +
        `f2p=${r.f2p ? `${r.f2p.passed}/${r.f2p.expected}` : "-"}` +
        `${r.unresolvedIds?.length ? ` unresolved=${r.unresolvedIds.join(",")}` : ""}${r.error ? " " + r.error : ""}`,
    );
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

await writeJson(join(ROOT, "results", "gold-validation.json"), results);
const ok = results.filter((r) => r.ok).length;
console.log(`\n金标对照: ${ok}/${results.length} 通过`);
console.log("（未通过的实例说明环境有问题，其 agent 结果不可解释，需先修环境）");
