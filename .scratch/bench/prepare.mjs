#!/usr/bin/env node
/**
 * prepare.mjs — 物化权威基准任务到可评测工作区
 *
 *   node .scratch/bench/prepare.mjs swebench          # SWE-bench Verified 选中实例
 *   node .scratch/bench/prepare.mjs polyglot          # Aider Polyglot 题目
 *   node .scratch/bench/prepare.mjs terminalbench     # Terminal-Bench 2.0 任务
 *
 * 产物：$ROOT/wt/<taskId>/{repo,out}/{...}
 *   repo/          被测工作区（agent 在这里改代码）
 *   out/           prompt.txt / test_patch.diff / meta.json / 运行期日志
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import {
  ROOT, WT, OUT, sh, mkdirp, writeJson, writeFile, readFile, rm,
  ensureAgentDir, syncCpiSource, startContainer, stopContainer, dexec,
} from "./lib.mjs";
import { SWE_BENCH_INSTANCES } from "./instances.mjs";

const argv = process.argv.slice(2);
const which = argv[0] || "swebench";
const onlyIds = (argv.find((a) => a.startsWith("--tasks=")) || "").replace("--tasks=", "");
const only = onlyIds ? onlyIds.split(",") : null;

// ---------------------------------------------------------------- SWE-bench
/** 各仓库在被测容器里的依赖安装方式（与官方 SWE-bench 环境对齐的轻量版本） */
const REPO_DEPS = {
  "psf/requests": (ver) => `pip install -q -e . ${ver < "3.0" ? "" : ""}`,
  "pytest-dev/pytest": () => `pip install -q -e .`,
  "pallets/flask": () => `pip install -q -e .`,
  "pylint-dev/pylint": () => `pip install -q -e .`,
  "sympy/sympy": () => `pip install -q -e .`,
};

async function prepareSwebench() {
  const instances = SWE_BENCH_INSTANCES.filter((i) => !only || only.includes(i.id));
  console.log(`[swebench] 物化 ${instances.length} 个实例`);
  const manifest = [];

  for (const inst of instances) {
    const dir = join(WT, inst.id);
    const repo = join(dir, "repo");
    const out = join(OUT, inst.id);
    await mkdirp(out);

    // 1) 取 base_commit 的源码快照
    if (!existsSync(join(repo, ".git"))) {
      await rm(repo, { recursive: true, force: true });
      await mkdirp(repo);
      const url = `https://codeload.github.com/${inst.repo}/tar.gz/${inst.base_commit}`;
      const r = await sh(
        `curl -sL --retry 3 --retry-delay 2 -o /tmp/tb-${inst.id}.tgz ${JSON.stringify(url)} && ` +
          `tar xzf /tmp/tb-${inst.id}.tgz -C ${JSON.stringify(repo)} --strip-components=1 && rm -f /tmp/tb-${inst.id}.tgz`,
        { timeoutMs: 600_000 },
      );
      if (r.code !== 0) {
        console.error(`  ✗ ${inst.id} 拉取失败: ${r.stderr.slice(0, 200)}`);
        continue;
      }
      // 2) 建基线提交：agent 的产物即相对它的 git diff
      const g = await sh(
        `git init -q && git config user.email bench@local && git config user.name bench && ` +
          `git add -A && git commit -qm baseline && git rev-parse HEAD`,
        { cwd: repo, timeoutMs: 300_000 },
      );
      if (g.code !== 0) {
        console.error(`  ✗ ${inst.id} git 基线失败: ${g.stderr.slice(0, 200)}`);
        continue;
      }
      inst.baseline = g.stdout.trim();
    }

    // 3) prompt 用官方 problem_statement 原文；评测材料写进 out/
    await writeFile(join(out, "prompt.txt"), inst.problem_statement);
    await writeFile(join(out, "test_patch.diff"), inst.test_patch);
    await writeJson(join(out, "meta.json"), {
      id: inst.id, repo: inst.repo, base_commit: inst.base_commit,
      version: inst.version, difficulty: inst.difficulty,
      fail_to_pass: inst.FAIL_TO_PASS, pass_to_pass: inst.PASS_TO_PASS,
      gold_patch: inst.patch,
    });
    await rm(join(out, "fetch.jsonl"), { force: true });
    manifest.push({ id: inst.id, repo: inst.repo, difficulty: inst.difficulty, f2p: inst.FAIL_TO_PASS.length });
    console.log(`  ✓ ${inst.id.padEnd(28)} ${inst.repo.padEnd(20)} F2P=${inst.FAIL_TO_PASS.length}`);
  }

  await writeJson(join(ROOT, "manifest-swebench.json"), manifest);
  console.log(`[swebench] 完成 ${manifest.length}/${instances.length}`);
}

// ------------------------------------------------- SWE-bench 依赖（容器内）
export async function installRepoDeps(instances, { log = console.log } = {}) {
  await syncCpiSource();
  await ensureAgentDir();
  for (const inst of instances) {
    const name = `cpi-deps-${inst.id}`;
    const repo = join(WT, inst.id, "repo");
    if (!existsSync(repo)) continue;
    // 已经装过就跳过（镜像里 /opt/deps-<repo>.done 标记不可用，改用工作区标记）
    const marker = join(WT, inst.id, ".deps-done");
    if (existsSync(marker)) {
      log(`  = ${inst.id} 依赖已装，跳过`);
      continue;
    }
    await startContainer({ name, workspace: repo, outDir: join(OUT, inst.id) });
    const cmd = (REPO_DEPS[inst.repo] || (() => `pip install -q -e .`))(inst.version);
    const r = await dexec(name, `${cmd} 2>&1 | tail -5`, { timeoutMs: 900_000 });
    // 安装失败不致命：sympy/flask 这类仓库根目录直接可导入，测试仍可跑
    await writeFile(marker, `exit=${r.code}\n${r.stdout}\n${r.stderr}\n`);
    log(`  ${r.code === 0 ? "✓" : "△"} ${inst.id} 依赖 exit=${r.code} ${r.stdout.trim().split("\n").slice(-1)[0] || ""}`);
    await stopContainer(name);
  }
}

// ---------------------------------------------------------------- Polyglot
const POLYGLOT_ROOT = process.env.CPI_POLYGLOT_ROOT || join(homedir(), "cpi-bench/sources/polyglot-benchmark");

async function preparePolyglot() {
  const { POLYGLOT_SELECTION } = await import("./instances.mjs");
  await mkdirp(WT);
  const manifest = [];
  for (const ex of POLYGLOT_SELECTION) {
    const src = join(POLYGLOT_ROOT, ex.lang, "exercises", "practice", ex.slug);
    if (!existsSync(src)) {
      console.error(`  ✗ ${ex.id} 源缺失: ${src}`);
      continue;
    }
    const dir = join(WT, ex.id);
    const repo = join(dir, "repo");
    const out = join(OUT, ex.id);
    await rm(repo, { recursive: true, force: true });
    await mkdirp(dir);
    await mkdirp(out);
    await sh(`cp -a ${JSON.stringify(src + "/.")} ${JSON.stringify(repo + "/")}`);
    await sh(`git init -q && git config user.email bench@local && git config user.name bench && git add -A && git commit -qm baseline`, {
      cwd: repo, timeoutMs: 120_000,
    });
    // 官方题面：.docs/instructions.md 原文
    const docs = join(repo, ".docs", "instructions.md");
    const prompt = existsSync(docs) ? await readFile(docs, "utf8") : ex.slug;
    await writeFile(join(out, "prompt.txt"), prompt);
    await writeJson(join(out, "meta.json"), {
      id: ex.id, lang: ex.lang, slug: ex.slug, test_cmd: ex.testCmd,
      test_files: ex.testFiles,
    });
    await rm(join(out, "fetch.jsonl"), { force: true });
    manifest.push({ id: ex.id, lang: ex.lang, slug: ex.slug });
    console.log(`  ✓ ${ex.id.padEnd(30)} ${ex.lang}`);
  }
  await writeJson(join(ROOT, "manifest-polyglot.json"), manifest);
  console.log(`[polyglot] 完成 ${manifest.length}/${POLYGLOT_SELECTION.length}`);
}

// ------------------------------------------------------------ Terminal-Bench
const TB_ROOT = process.env.CPI_TB_ROOT || join(homedir(), "cpi-bench/sources/tb2");

async function prepareTerminalBench() {
  const { TB_SELECTION } = await import("./instances.mjs");
  await mkdirp(WT);
  const manifest = [];
  for (const t of TB_SELECTION) {
    const taskDir = join(TB_ROOT, t.slug);
    if (!existsSync(taskDir)) {
      console.error(`  ✗ ${t.id} 源缺失: ${taskDir}`);
      continue;
    }
    const out = join(OUT, t.id);
    await mkdirp(out);
    const instruction = await readFile(join(taskDir, "instruction.md"), "utf8");
    await writeFile(join(out, "prompt.txt"), instruction);
    await writeJson(join(out, "meta.json"), {
      id: t.id, slug: t.slug, image: t.image, workdir: t.workdir ?? null,
      testCmd: t.testCmd ?? "bash /tests/test.sh",
      note: t.note ?? null,
    });
    await rm(join(out, "fetch.jsonl"), { force: true });
    manifest.push({ id: t.id, slug: t.slug, image: t.image });
    console.log(`  ✓ ${t.id.padEnd(30)} ${t.image}`);
  }
  await writeJson(join(ROOT, "manifest-terminalbench.json"), manifest);
  console.log(`[terminalbench] 完成 ${manifest.length}/${TB_SELECTION.length}`);
}

// -------------------------------------------------------------------- main
if (which === "swebench") await prepareSwebench();
else if (which === "swebench-deps") await installRepoDeps(SWE_BENCH_INSTANCES.filter((i) => !only || only.includes(i.id)));
else if (which === "polyglot") await preparePolyglot();
else if (which === "terminalbench") await prepareTerminalBench();
else {
  console.error(`未知基准: ${which}（可选 swebench | swebench-deps | polyglot | terminalbench）`);
  process.exit(2);
}
