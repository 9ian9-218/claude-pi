#!/usr/bin/env node
/**
 * report.mjs — 把跑测产物汇总成一份可复查的 Markdown 报告
 *
 *   node .scratch/bench/report.mjs            # 读 $ROOT/analysis + $ROOT/results
 *
 * 产物写到仓库内（.scratch/bench/report.md）：跑测工作根在 $HOME 下，
 * 但结论要能随手打开、随仓库一起复查。
 */
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { ROOT, HERE } from "./lib.mjs";
import { SWE_BENCH_INSTANCES, POLYGLOT_SELECTION, TB_SELECTION } from "./instances.mjs";

const analysisDir = join(ROOT, "analysis");
if (!existsSync(analysisDir)) {
  console.error(`缺少分析产物目录：${analysisDir}\n先跑 run.mjs 与 analyze.mjs。`);
  process.exit(1);
}
const analyses = readdirSync(analysisDir)
  .filter((f) => f.endsWith(".json") && f !== "summary.json")
  .map((f) => JSON.parse(readFileSync(join(analysisDir, f), "utf8")));

const benchOf = (id) =>
  SWE_BENCH_INSTANCES.some((i) => i.id === id) ? "swebench"
    : POLYGLOT_SELECTION.some((i) => i.id === id) ? "polyglot"
    : TB_SELECTION.some((i) => i.id === id) ? "terminalbench" : "?";
for (const a of analyses) if (!a.bench || a.bench === "?") a.bench = benchOf(a.id);

// 评测结论：以各任务的 out/<id>/result.json 为准（run.mjs 与 reeval.mjs 都会写它），
// 退回 swebench-reeval.json（只做局部重放时那份文件只含被重放的实例）。
const outResultOf = (id) => {
  try {
    return JSON.parse(readFileSync(join(ROOT, "out", id, "result.json"), "utf8"));
  } catch {
    return null;
  }
};
const reeval = new Map();
for (const f of ["swebench-reeval.json"]) {
  const p = join(ROOT, "results", f);
  if (existsSync(p)) for (const r of JSON.parse(readFileSync(p, "utf8"))) reeval.set(r.id, r);
}
const evalOf = (a) => outResultOf(a.id) ?? reeval.get(a.id) ?? a;

const num = (v, d = 2) => (typeof v === "number" ? v.toFixed(d) : "-");
const pad = (s, n) => String(s).padEnd(n);

function byBench(b) { return analyses.filter((a) => a.bench === b); }

function table(rows, header) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => "| " + cells.map((c, i) => pad(c, widths[i])).join(" | ") + " |";
  return [line(header), "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|", ...rows.map(line)].join("\n");
}

const L = [];
const p = (s = "") => L.push(s);

p("# claude-pi 权威基准评测报告");
p();
p(`生成时间：${new Date().toISOString()}　·　被测模型：\`opencode-go/deepseek-v4.1-flash\`（thinking=max）`);
p();
p("三个基准的任务定义均逐字取自官方来源，测试全部跑**官方口径**的验证。");
p();

// ---------------------------------------------------------------- 方法与可信度
p("## 1. 方法与可信度");
p();
p("| 环节 | 做法 |");
p("| --- | --- |");
p("| 执行环境 | 每个任务一个独立容器：容器内既跑 claude-pi，也跑被测仓库自带的测试（与 SWE-bench / Terminal-Bench 的「同 env 改代码 + 验代码」语义一致） |");
p("| 题面 | SWE-bench 用官方 `problem_statement`；Polyglot 用 Exercism 官方 `.docs/instructions.md`；TB2 用官方 `instruction.md` |");
p("| 评测 | SWE-bench：官方 FAIL_TO_PASS / PASS_TO_PASS，按 junit 归一化 id 比对；Polyglot：原生测试套件；TB2：官方 `/tests/test.sh` 写入的 `reward.txt` |");
p("| **金标对照** | 每个 SWE-bench 实例先用官方 gold patch 走一遍：基线清洁 → gold 可应用 → test patch 可应用 → F2P 全绿。**这一步把「环境失败」与「harness 失败」分开** |");
p("| 插桩 | `NODE_OPTIONS=--require` 注入，只读观测、不改被测代码：① 出站请求 payload 的逐条消息哈希 ② shell 命令的真实退出码 |");
p();

// ---------------------------------------------------------------- 正确性
p("## 2. 正确性结果");
p();

const sb = byBench("swebench");
if (sb.length) {
  p("### 2.1 SWE-bench Verified（真实 GitHub issue + 官方金标测试）");
  p();
  const rows = sb.map((a) => {
    const e = evalOf(a);
    const f = e.f2p || {};
    const q = e.p2p;
    const p2pGap = q ? (q.matched < q.expected) : false;
    const p2pFailed = q ? (q.failed || []).length > 0 : false;
    // f2p 明细可能缺失（老产物/只跑了部分重放）——此时退回 f2pAllPass 布尔值，
    // 绝不能因为「字段不存在」就默认成通过。
    const f2pOk = e.f2pAllPass ?? (f.expected !== undefined ? f.passed === f.expected : undefined);
    const verdict = e.resolved ? "**RESOLVED**"
      : e.resolvedNoRegression === true ? "无回归（P2P 有未匹配项）"
      : f2pOk === false ? "未修复（F2P 未过）"
      : p2pFailed ? "F2P 过 / P2P 有回归"
      : p2pGap ? "F2P 过 / P2P 有未匹配项" : "F2P 过 / P2P 未过";
    return [
      a.id,
      a.difficulty ?? "-",
      `${f.passed ?? "-"}/${f.expected ?? "-"}`,
      q ? `${q.passed}/${q.expected}${p2pGap ? `（匹配 ${q.matched}）` : ""}` : "-",
      a.trajectory.toolCalls,
      num(a.cache.cacheHitRatePct),
      verdict,
    ];
  });
  p(table(rows, ["实例", "难度", "F2P", "P2P", "工具调用", "缓存命中%", "结论"]));
  p();
  const res = sb.filter((a) => evalOf(a).resolved).length;
  const resLoose = sb.filter((a) => {
    const e = evalOf(a);
    return e.resolved || e.resolvedNoRegression;
  }).length;
  p(`**resolved：${res}/${sb.length}**（严格口径，含官方列表里的未匹配项）`);
  if (resLoose > res) {
    p();
    p(`无 P2P 回归口径：**${resLoose}/${sb.length}** —— 差额来自官方 P2P 列表里在该 commit 根本不存在的陈旧 id：`);
    for (const a of sb) {
      const e = evalOf(a);
      const miss = (e.p2p && e.p2p.missing) || [];
      if (!e.resolved && e.resolvedNoRegression && miss.length) p(`- \`${a.id}\`：${miss.map((m) => `\`${m}\``).join("、")}`);
    }
  }
  p();
}

const pg = byBench("polyglot");
if (pg.length) {
  p("### 2.2 Aider Polyglot（Exercism 官方题面 + 原生测试，python 子集）");
  p();
  const rows = pg.map((a) => [
    a.id.replace("poly-python-", ""),
    a.trajectory.toolCalls,
    a.cache.requests,
    num(a.cache.cacheHitRatePct),
    a.resolved ? "通过" : "未通过",
  ]);
  p(table(rows, ["题目", "工具调用", "请求数", "缓存命中%", "结论"]));
  p();
  p(`**通过：${pg.filter((a) => a.resolved).length}/${pg.length}**`);
  p();
}

// TB 里有一个任务因崩溃没有轨迹、被 analyze 跳过；结论表仍要出现它
const tbResultsPath = (() => {
  const dir = join(ROOT, "results");
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((x) => x.startsWith("terminalbench-")).sort().pop();
  return f ? join(dir, f) : null;
})();
const tbRaw = tbResultsPath ? JSON.parse(readFileSync(tbResultsPath, "utf8")).results : [];
const tb = byBench("terminalbench");
if (tb.length || tbRaw.length) {
  p("### 2.3 Terminal-Bench 2.0（官方任务镜像 + 官方 verifier）");
  p();
  const tbRows = tbRaw.map((r) => {
    const a = tb.find((x) => x.id === r.id);
    return [
      r.id.replace("tb2-", ""),
      r.reward ?? "-",
      r.verifierMode === "direct-pytest" ? "直接 pytest（引导不可用）" : "官方 test.sh",
      a ? a.trajectory.toolCalls : "—（崩溃无轨迹）",
      a ? a.cache.requests : "-",
      a ? num(a.cache.cacheHitRatePct) : "-",
      r.resolved ? "通过" : "未通过",
    ];
  });
  p(table(tbRows, ["任务", "reward", "verifier 路径", "工具调用", "请求数", "缓存命中%", "结论"]));
  p();
  const fell = tbRaw.filter((r) => r.verifierMode === "direct-pytest").length;
  if (fell) {
    p(`> 注：${fell}/${tbRaw.length} 个任务的官方 \`test.sh\` 引导步骤（\`apt-get update\` + 从 astral.sh 装 uv）` +
      `在本网络下不可用（deb.debian.org 不可达），已回退为**用同一份官方测试文件 \`/tests/test_outputs.py\` 直接跑 pytest**。` +
      `判定口径一致（test.sh 本体就是 pytest 退码 0 → reward 1），差别只在工具是预装而非临时下载。`);
    p();
  }
  p();
  p(`**通过：${tbRaw.filter((r) => r.resolved).length}/${tbRaw.length}**`);
  p();
  const noTraj = tbRaw.filter((r) => !tb.find((x) => x.id === r.id));
  if (noTraj.length) {
    p(`> ${noTraj.map((r) => `\`${r.id}\``).join("、")} 的轨迹缺失：工具异常中止了整个 run（见 5.1），结论取自 result.json。`);
    p();
  }
}

// ---------------------------------------------------------------- 轨迹
p("## 3. 执行轨迹分析");
p();
p("指标由完整会话重建（含每次工具调用的参数与结果、真实退出码）：");
p();
p("- **冗余调用**：完全相同的 (工具, 参数) 再次出现");
p("- **盲改**：改动一个既没读过、也不是自己新建的文件");
p("- **验证闭环**：`verify=次数✓/✗` 中的 ✗ 表示最后一次编辑之后没有再跑过验证命令");
p("  （该判定按「测试运行器」识别 —— pytest / npm test / make / cargo test 等；");
p("   TB2 的若干任务是用 `diff`、`sha256sum`、人工比对来验证的，会被计入 0，属指标口径限制而非行为问题）");
p("- **退出码不可见**：shell 非零退出，但模型看到的文本里没有任何失败迹象");
p();
const trows = analyses.map((a) => [
  a.id,
  a.trajectory.toolCalls,
  a.trajectory.bashMatched,
  a.trajectory.redundantCalls,
  a.trajectory.blindEdits,
  `${a.trajectory.verifyCount}${a.trajectory.verifyAfterLastEdit ? "✓" : "✗"}`,
  `${a.trajectory.execFailedInvisible}/${a.trajectory.execFailed}`,
  a.trajectory.endReason,
]);
p(table(trows, ["任务", "工具调用", "shell", "冗余", "盲改", "验证", "退出码不可见", "终止方式"]));
p();
const sum = (f) => analyses.reduce((x, a) => x + (f(a) || 0), 0);
p(`合计：工具调用 ${sum((a) => a.trajectory.toolCalls)}，shell ${sum((a) => a.trajectory.bashMatched)}，` +
  `冗余 ${sum((a) => a.trajectory.redundantCalls)}，盲改 ${sum((a) => a.trajectory.blindEdits)}，` +
  `末次编辑后验证 ${analyses.filter((a) => a.trajectory.verifyAfterLastEdit).length}/${analyses.length}。`);
p();

// ---------------------------------------------------------------- 缓存
p("## 4. 缓存复用分析");
p();
p("判据来自**线上真实 payload**（不是推断）：对每次出站请求，逐条哈希消息、并计算与上一请求的公共前缀。");
p();
const crows = analyses.map((a) => [
  a.id,
  a.cache.requests,
  a.cache.systemStable ? "稳定" : `变了×${a.cache.distinctSystem}`,
  a.cache.toolsStable ? "稳定" : `变了×${a.cache.distinctTools}`,
  a.cache.prefixBreaks,
  num(a.cache.avgPrefixCoverage, 4),
  num(a.cache.cacheHitRatePct),
  a.cache.unexplainedMisses,
]);
p(table(crows, ["任务", "请求数", "system 哈希", "tools 哈希", "历史改写", "前缀覆盖率", "命中率%", "未解释未命中"]));
p();
const tot = analyses.reduce(
  (acc, a) => {
    acc.cr += a.cache.cacheReadTotal || 0;
    acc.pr += a.cache.promptTokenTotal || 0;
    return acc;
  },
  { cr: 0, pr: 0 },
);
p(`总体命中率 **${num((tot.cr / tot.pr) * 100)}%**（cacheRead ${tot.cr} / prompt ${tot.pr}）。`);
p();
p(`结构层面：system 提示词哈希 **${analyses.filter((a) => a.cache.systemStable).length}/${analyses.length}** 全程不变，` +
  `工具 schema 哈希 **${analyses.filter((a) => a.cache.toolsStable).length}/${analyses.length}** 全程不变，` +
  `历史被改写 **${sum((a) => a.cache.prefixBreaks)}** 次，` +
  `未解释的未命中 **${sum((a) => a.cache.unexplainedMisses)}** 次。`);
p();
p("前缀覆盖率 = 本次 `cacheRead` ÷ 上一次请求的 prompt 总 token。append-only 且缓存有效时应≈1.0；" +
  "低于 1 说明「上一轮的全部内容没有被完整复用」，那才是缓存被破坏。");
p();


// ---------------------------------------------------------------- 缺陷与风险
p("## 5. 发现的缺陷与风险");
p();
p("本节只列跑测能直接举证的缺陷。**完整的缺陷清单（含确定性复现脚本、逐条代码定位与修复建议）见同目录的 [problems.md](problems.md)**，");
p("其中高危三项：`claim_task` 的 worktree 会静默吞掉改动、工具异常不隔离会中止整个 run、100 轮上限静默截断。");
p();
const shellTotal = sum((a) => a.trajectory.bashMatched);
const nonZero = sum((a) => a.trajectory.execFailed);
const invisible = sum((a) => a.trajectory.execFailedInvisible);
p("### 5.1 工具异常没有隔离：一次工具报错会中止整个 run（高严重度，本轮实测复现）");
p();
p("`tb2-sanitize-git-repo` 这一轮里，claude-pi 的 `--mode json` **stdout 是 0 字节**，stderr 末尾是：");
p();
p("```");
p("[unhandledRejection] Error: Task task_3 is pending, cannot complete");
p("    at .../src/tasks.ts:401");
p("    at .../src/tools/tasks-board.ts:42   (Tool.execCompleteTask)");
p("    at .../src/agent-loop.ts:234        (executeToolCall)");
p("```");
p();
p("链条是三处叠加：");
p();
p("1. `src/tasks.ts:401` 对状态不合法的调用**抛异常**（而不是返回错误串）；");
p("2. `src/tools/tasks-board.ts` 的 `execCompleteTask` **没有 try/catch** —— 对比 `src/tools/file.ts` 的");
p("   `execEditFile` 是包住的，失败时返回 \`Error: text not found\` 这样的字符串；");
p("3. `src/agent-loop.ts:234` 的 `toolResult = await executeToolCall(...)` **没有单次调用级的错误隔离**。");
p();
p("于是同类错误出现两种行为：`edit_file` 出错 → 模型看到错误串、可以自己纠正；");
p("`complete_task` 出错 → 整个 run 被中止，调用方拿到的是**空 stdout**。");
p();
const allOut = readdirSync(join(ROOT, "out"));
let crashedRuns = 0, totalRuns = 0;
for (const d of allOut) {
  const se = join(ROOT, "out", d, "agent.stderr.txt");
  const so = join(ROOT, "out", d, "agent.stdout.txt");
  if (!existsSync(se)) continue;
  totalRuns++;
  const hasRej = /unhandledRejection/.test(readFileSync(se, "utf8"));
  const emptyOut = !existsSync(so) || readFileSync(so, "utf8").length === 0;
  if (hasRej && emptyOut) crashedRuns++;
}
p(`当前数据集共 ${totalRuns} 个任务，其中 **${crashedRuns}** 个因工具异常中止、stdout 为空。`);
p("需要说明：复现发生在 `tb2-sanitize-git-repo` 的首轮运行（该轮 stdout 0 字节、退出码 1），");
p("重跑该任务不再复现（80 轮正常完成、reward=1）——触发条件是「对未 claim 的任务调用 complete_task」这一具体路径，");
p("所以它是**条件触发**而非必现。全量 29 次任务运行里发生 1 次。");
p("后果：`--mode json` 的输出契约被破坏（本应给出可解析 JSON，实际给空 stdout），");
p("调用方无法区分「无输出」与「崩溃」。会话数据逐条落盘，可用 `cpi --session <id>` 恢复——属「可恢复但契约破坏」。");
p("另一处相关行为见下方 5.5。");
p();
p("### 5.2 `run_bash` 丢弃命令退出码（代码级缺陷，本轮未造成实际损失）");
p();
p("`src/tools/bash.ts` 的 `execRunBash` 只回传 `stdout+stderr`，`spawnSync` 的 `r.status` 被丢掉。");
p("受控实验（不经过模型）：执行 `false` —— 退出码 1、零输出，模型看到的就是 `(no output)`，");
p("与成功的静默命令（`cd`、`mkdir` 之类）在模型眼里**完全同形**。");
p();
let silentFail = 0;
for (const d of allOut) {
  const ep = join(ROOT, "out", d, "exec.jsonl");
  if (!existsSync(ep)) continue;
  for (const line of readFileSync(ep, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.kind !== "spawnSync") continue;
    if (typeof r.status === "number" && r.status !== 0 && r.combinedLen === 0) silentFail++;
  }
}
p(`实测影响面：本轮共 ${shellTotal} 次 shell 调用，非零退出 ${nonZero} 次；` +
  `其中「非零退出**且零输出**」——与成功静默命令完全同形、真正会误导模型的——是 **${silentFail}** 次，实测为：`);
p();
for (const d of allOut) {
  const ep = join(ROOT, "out", d, "exec.jsonl");
  if (!existsSync(ep)) continue;
  for (const line of readFileSync(ep, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.kind === "spawnSync" && typeof r.status === "number" && r.status !== 0 && r.combinedLen === 0) {
      p(`- \`${d}\`：\`${String(r.command).split("\n")[0].slice(0, 90)}\` → 退出码 ${r.status}，模型看到 \`(no output)\``);
    }
  }
}
p();
p(`两次都是「探测类」命令（grep 无匹配、内省脚本无输出），所以本轮没有造成误判；但机制上，` +
  `模型无法区分「命令失败」与「命令成功但没有输出」。`);
p("结论：缺陷真实存在，且本轮确有 2 次实际发生；但都落在探测类命令上，没有影响任务结果。");
p("风险在于**未暴露**的那类：`git apply` 失败无输出、`make` 静默退出非零、构建脚本吞掉错误——");
p("一旦出现，模型会把失败当成功继续，而轨迹上完全看不出来。加一个退出码后缀（非零时显式标注）成本极低。");
p();
p("### 5.3 会话数据写在被测项目的 `cwd/.agent/` 下");
p();
p("`src/session-manager.ts` 明确把会话存到 `.agent/sessions/--<cwd路径>--/<时间戳>_<uuid>.jsonl`。");
p("这是设计选择（仓库自己的 `.gitignore` 也把 `.agent/` 注释为「项目本地运行数据」），但副作用是：");
p("在任意仓库里跑一次 agent，就会在那个仓库里留下 `.agent/` 目录。评测时必须把它排除在候选补丁之外");
p("（本评测用 `.git/info/exclude` 屏蔽，不改仓库受版本控制的文件）。");
p();
p("### 5.4 `run_bash` 没有路径约束（设计属性，非缺陷）");
p();
p("`safePath`/`checkPath` 只作用于 `read_file`/`write_file`/`edit_file`；");
p("`run_bash` 直接 `spawnSync(command, { cwd: getWorkdir(), shell: true })`。");
p("因此「工作区隔离」对 shell 不成立 —— 它是完整 shell，能写到进程有权限的任何位置。");
p("这不是 bug（shell 工具本就如此），但**不能把它当作安全边界**来依赖。");
p();
p("### 5.5 本轮不予采信的两个观察");
p();
p("早先一次跑测中出现过「轨迹里出现两条内容完全相同的 user 消息」与「最早的若干次请求未进线上日志」。");
p("这两点在随后 18 个任务的干净重跑中**一次都没有复现**，且当时那轮跑测确实处于容器/工作区被污染的状态");
p("（运行期还打印过「会话文件正被其他进程使用」）。因此按未证实处理，不计入结论。");
p();

// ---------------------------------------------------------------- 复现
p("## 6. 如何复现");
p();
p("```bash");
p("# 基建（脚本在仓库内，跑测产物在 $HOME/cpi-bench）");
p("node .scratch/bench/prepare.mjs swebench|polyglot|terminalbench");
p("node .scratch/bench/validate.mjs          # 金标对照：先证明评测环境正确");
p("node .scratch/bench/run.mjs --bench=swebench --concurrency=3");
p("node .scratch/bench/reeval.mjs            # 只重放评测，不重跑 agent");
p("node .scratch/bench/analyze.mjs           # 轨迹 + 缓存分析");
p("node .scratch/bench/report.mjs            # 生成本报告");
p("```");
p();
writeFileSync(join(HERE, "report.md"), L.join("\n") + "\n");
console.log(`报告已写入 ${join(HERE, "report.md")}（${L.length} 行）`);
