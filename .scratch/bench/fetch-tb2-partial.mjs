#!/usr/bin/env node
/**
 * fetch-tb2-partial.mjs — 只拉取选定 Terminal-Bench 任务所需文件
 *
 * 整仓 tarball（~40MB，codeload）在这条网络上反复中断（实测两次半途 EOF）。
 * TB 任务只需要 instruction.md / task.toml / tests/**（tests 在评测时挂到 /tests），
 * 所以改为按 GitHub API 逐个文件下载，体量小得多也稳得多。
 *
 *   node .scratch/bench/fetch-tb2-partial.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { TB_SELECTION } from "./instances.mjs";
import { sh } from "./lib.mjs";

const ROOT = process.env.CPI_TB_ROOT || join(homedir(), "cpi-bench/sources/tb2");
const REPO = "harbor-framework/terminal-bench-2";
const BRANCH = "main";

async function api(path) {
  const r = await sh(`curl -sL --retry 3 --retry-delay 2 "https://api.github.com/repos/${REPO}/${path}"`, {
    timeoutMs: 120_000,
  });
  if (r.code !== 0) throw new Error(`API ${path} 失败: ${r.stderr.slice(0, 200)}`);
  return JSON.parse(r.stdout);
}

/** 递归列出任务目录下的全部文件路径 */
async function listFiles(slug) {
  const r = await sh(
    `curl -sL --retry 3 --retry-delay 2 "https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1"`,
    { timeoutMs: 180_000 },
  );
  const tree = JSON.parse(r.stdout).tree || [];
  return tree
    .filter((e) => e.type === "blob" && e.path.startsWith(`${slug}/`))
    .map((e) => ({ path: e.path, size: e.size }));
}

async function fetchFile(path, dest) {
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${path}`;
  await mkdir(dirname(dest), { recursive: true });
  // 这条网络对 GitHub 时好时坏，单文件失败不该拖垮整批：重试几次，仍失败则记录后继续
  for (let i = 0; i < 4; i++) {
    const r = await sh(`curl -sL --retry 3 --retry-delay 2 -o ${JSON.stringify(dest)} ${JSON.stringify(url)}`, {
      timeoutMs: 300_000,
    });
    if (r.code === 0) {
      const sz = await sh(`wc -c < ${JSON.stringify(dest)}`, { timeoutMs: 30_000 });
      if (Number(sz.stdout.trim()) > 0) return dest;
    }
    await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
  }
  throw new Error(`下载失败 ${path}`);
}

const only = (process.argv.find((a) => a.startsWith("--tasks=")) || "").replace("--tasks=", "");
const targets = TB_SELECTION.filter((t) => !only || only.split(",").includes(t.slug) || only.split(",").includes(t.id));

for (const t of targets) {
  const files = await listFiles(t.slug);
  if (!files.length) { console.error(`✗ ${t.slug} 在仓库里找不到`); continue; }
  const need = files.filter((f) => /^(instruction\.md|task\.toml)$/.test(f.path) || f.path.startsWith(`${t.slug}/tests/`));
  let bytes = 0;
  let failed = [];
  for (const f of need) {
    try { await fetchFile(f.path, join(ROOT, f.path)); bytes += f.size || 0; }
    catch { failed.push(f.path); }
  }
  console.log(`${failed.length ? "△" : "✓"} ${t.slug.padEnd(28)} ${need.length - failed.length}/${need.length} 个文件, ${(bytes / 1024).toFixed(0)} KB${failed.length ? " 缺: " + failed.join(", ") : ""}`);
}
console.log(`\n落盘目录：${ROOT}`);
