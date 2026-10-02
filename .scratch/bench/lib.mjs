/**
 * 权威基准评测基建（共享库）
 *
 * 设计要点：
 *  - agent 跑在容器里：容器同时具备 node（跑 cpi）与被测仓库的 python 环境（跑测试），
 *    与 SWE-bench / Terminal-Bench 的「同一个 env 里改代码 + 验代码」语义一致。
 *  - cpi 源码不烤进镜像，用 rsync 增量同步到 /tmp/cpi-bench/cpi-src 后 bind mount 到 /cpi：
 *    改 harness 代码后无需重建镜像。
 *  - 网络插桩走 NODE_OPTIONS=--require 注入（intercept-fetch.cjs），不改被测代码。
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm, cp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../..");
// 默认放在 $HOME 下：/tmp 在 WSL 重启时会被清空（实测丢过一次全部跑测产物）
export const ROOT = process.env.CPI_BENCH_ROOT || join(os.homedir(), "cpi-bench");
export const CPI_SRC = join(ROOT, "cpi-src");
export const AGENT_DIR = join(ROOT, "agent");
export const WT = join(ROOT, "wt");
export const OUT = join(ROOT, "out");
export const IMAGE = process.env.CPI_BENCH_IMAGE || "cpi-bench/base:py311";
export const INTERCEPT = join(HERE, "intercept-fetch.cjs");

// 被测模型配置：与 ~/.claude-pi/settings.json 一致
export const BENCH_MODEL = process.env.CPI_BENCH_MODEL || "opencode-go/deepseek-v4.1-flash";
export const BENCH_THINKING = process.env.CPI_BENCH_THINKING || "max";

export async function mkdirp(p) {
  await mkdir(p, { recursive: true });
}

/** 跑测产物（会被容器以 root 写出，重跑前必须在容器里清） */
export const RUN_ARTIFACTS = [
  "agent.stdout.txt", "agent.stderr.txt", "turns.json", "result.json",
  "patch.diff", "fetch.jsonl", "exec.jsonl", "apply.err", "cand.err",
  "gold.err", "test.err", "junit-f2p.xml", "junit-p2p.xml", "junit.xml",
  "tb-logs", "gold",
];

/**
 * 只清运行产物，保留 prepare 写下的任务材料（prompt.txt / test_patch.diff / meta.json）。
 * 容器以 root 写 bind mount 是常态，宿主直接删会撞 EACCES（实测重跑时报权限拒绝），
 * 所以清理交给一个 root 的一次性容器做。早期版本把整个目录删掉，
 * 结果连题面一起删了 —— 所以这里必须按名单清，不能整目录清。
 */
export async function cleanRunArtifacts(dir) {
  await mkdirp(dir);
  const names = RUN_ARTIFACTS.map((n) => `/o/${n}`).join(" ");
  const r = await sh(
    `docker run --rm -v ${JSON.stringify(dir)}:/o alpine sh -c ${JSON.stringify(`rm -rf ${names}`)}`,
    { timeoutMs: 120_000 },
  );
  if (r.code !== 0) {
    // 容器不可用时退化为宿主删除；失败不影响主流程（后续写入会再报错）
    for (const n of RUN_ARTIFACTS) await rm(join(dir, n), { recursive: true, force: true }).catch(() => {});
  }
  return dir;
}

/** 执行命令，返回 {code, stdout, stderr, ms}；不抛异常 */
export function sh(cmd, { cwd, env, timeoutMs = 120_000, input } = {}) {
  return new Promise((res) => {
    const t0 = Date.now();
    const child = spawn("bash", ["-lc", cmd], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      res({ code, signal, stdout, stderr, ms: Date.now() - t0, killed });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * 把 claude-pi 工作树增量同步到 CPI_SRC（供容器 bind mount）。
 * 排除运行期产物与评测产物，保留 node_modules（tsx 免构建运行需要）。
 */
export async function syncCpiSource({ quiet = true } = {}) {
  await mkdirp(CPI_SRC);
  // 注意：排除模式必须锚定到仓库根（以 / 开头）。未锚定的 dist 会连
  // node_modules/tsx/dist 一起排除，导致容器内 tsx loader 找不到。
  const excludes = [
    "/.git", "/.transcripts", "/.agent", "/.taskswarm", "/.task_outputs",
    "/.scratch/eval", "/.scratch/bench/results", "/dist",
  ].map((e) => `--exclude=${e}`).join(" ");
  const r = await sh(
    `rsync -a --delete ${excludes} ${JSON.stringify(REPO + "/")} ${JSON.stringify(CPI_SRC + "/")}`,
    { timeoutMs: 300_000 },
  );
  if (r.code !== 0) throw new Error(`rsync 失败: ${r.stderr}`);
  if (!quiet) process.stderr.write(`[sync] cpi 源码 → ${CPI_SRC}\n`);
  return r;
}

/** 准备隔离的 agent 配置目录（复用真实凭据，其余走基准固定值） */
export async function ensureAgentDir() {
  await mkdirp(AGENT_DIR);
  const real = join(os.homedir(), ".claude-pi");
  const auth = join(real, "auth.json");
  if (!existsSync(auth)) throw new Error(`缺少凭据：${auth}`);
  await cp(auth, join(AGENT_DIR, "auth.json"));
  await sh(`chmod 600 ${JSON.stringify(join(AGENT_DIR, "auth.json"))}`);

  // 协同模式由宿主侧写进配置：若改用容器内 `--team-mode` 传参，cpi 会把 settings.json
  // 写回（以 root 身份）→ 宿主的 bench 进程再也覆盖不了该文件（EACCES）。
  const teamMode = process.env.CPI_BENCH_TEAM_MODE || "pipeline";
  await writeFile(
    join(AGENT_DIR, "settings.json"),
    JSON.stringify(
      { defaultModel: BENCH_MODEL, defaultThinkingLevel: BENCH_THINKING, team: { mode: teamMode } },
      null,
      2,
    ) + "\n",
  );
  await writeFile(join(AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }, null, 2) + "\n");
  // 复用已缓存的远端目录，避免容器内再拉一次
  const store = join(real, "models-store.json");
  if (existsSync(store)) await cp(store, join(AGENT_DIR, "models-store.json"));
  return AGENT_DIR;
}

/** 启动常驻容器（不 --rm：评测要在同一容器内进行） */
export async function startContainer({ name, image = IMAGE, workspace, outDir, extraEnv = {}, extraMounts = [] }) {
  await sh(`docker rm -f ${name} >/dev/null 2>&1 || true`, { timeoutMs: 60_000 });
  const mounts = [
    `-v ${JSON.stringify(workspace)}:/testbed`,
    `-v ${JSON.stringify(CPI_SRC)}:/cpi`,
    `-v ${JSON.stringify(AGENT_DIR)}:/agent`,
    outDir ? `-v ${JSON.stringify(outDir)}:/out` : null,
    `-v ${JSON.stringify(INTERCEPT)}:/opt/intercept-fetch.cjs:ro`,
    ...extraMounts,
  ].filter(Boolean).join(" ");
  const envs = [
    `-e PI_CODING_AGENT_DIR=/agent`,
    `-e CPI_FETCH_LOG=/out/fetch.jsonl`,
    `-e CPI_EXEC_LOG=/out/exec.jsonl`,
    `-e NODE_OPTIONS="--require /opt/intercept-fetch.cjs"`,
    `-e PYTHONDONTWRITEBYTECODE=1`,
    `-e PYTHONUNBUFFERED=1`,
    // 容器以 root 跑、工作区属主是宿主用户，git 会以 dubious ownership 拒绝一切操作：
    // git add 失败 → git diff --cached 退化成 --no-index → 候选补丁静默变成空文件。
    `-e GIT_CONFIG_COUNT=1`,
    `-e GIT_CONFIG_KEY_0=safe.directory`,
    `-e GIT_CONFIG_VALUE_0="*"`,
    ...Object.entries(extraEnv).map(([k, v]) => `-e ${k}=${JSON.stringify(String(v))}`),
  ].join(" ");
  const cmd = `docker run -d --name ${name} --workdir /testbed ${mounts} ${envs} ${image} sleep infinity`;
  const r = await sh(cmd, { timeoutMs: 180_000 });
  if (r.code !== 0) throw new Error(`启动容器失败: ${r.stderr || r.stdout}`);
  return name;
}

export async function stopContainer(name) {
  await sh(`docker rm -f ${name} >/dev/null 2>&1 || true`, { timeoutMs: 60_000 });
}

/** 容器内执行命令；stdout/stderr 分别捕获（--mode json 的纯净性依赖这一点） */
export async function dexec(name, cmd, { timeoutMs = 900_000, input, workdir = "/testbed", env = {} } = {}) {
  const envs = Object.entries(env).map(([k, v]) => `-e ${k}=${JSON.stringify(String(v))}`).join(" ");
  // 整个 cmd 用单引号包住：cmd 里常有 $t / $(...) 这类内层变量，
  // 用双引号会被宿主 bash 先展开（实测 resolveTestIds 因此永远解析不出文件）。
  const inner = `'${String(cmd).replace(/'/g, `'\\''`)}'`;
  const full = `docker exec -i ${workdir ? `-w ${JSON.stringify(workdir)}` : ""} ${envs} ${name} bash -lc ${inner}`;
  return sh(full, { timeoutMs, input });
}

/** 容器内写入文件（避免宿主 uid 差异造成的权限问题） */
export async function dwrite(name, containerPath, content) {
  const dir = dirname(containerPath);
  const b64 = Buffer.from(content, "utf8").toString("base64");
  return dexec(name, `mkdir -p ${JSON.stringify(dir)} && printf %s ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(containerPath)}`, {
    timeoutMs: 120_000,
  });
}

/**
 * 把官方 FAIL_TO_PASS 里的裸函数名解析成 pytest 可用的节点 id。
 *
 * SWE-bench Verified 的 id 有两种形态：
 *   tests/test_x.py::Class::test_y   —— 直接可用
 *   test_Add_is_zero                 —— sympy 这类仓库只给函数名
 * 后者需要先在仓库里定位定义文件，否则 pytest 会报 "file or directory not found"。
 */
export async function resolveTestIds(cname, ids, { workdir = "/testbed" } = {}) {
  const bare = ids.filter((id) => !id.includes("::") && !/\.py(\b|$)/.test(id));
  if (!bare.length) return { ids, resolved: 0 };
  const list = bare.map((b) => `'${b.replace(/'/g, `'\\''`)}'`).join(" ");
  const r = await dexec(
    cname,
    `for t in ${list}; do f=$(grep -rl --include='*.py' -m1 "def $t(" . 2>/dev/null | head -1); echo "$t|$f"; done`,
    { timeoutMs: 180_000, workdir },
  );
  const map = new Map();
  for (const line of r.stdout.split("\n")) {
    const [name, file] = line.split("|");
    if (name && file) map.set(name.trim(), file.replace(/^\.\//, "").trim());
  }
  let resolved = 0;
  const out = ids.map((id) => {
    if (!map.has(id)) return id;
    resolved++;
    return `${map.get(id)}::${id}`;
  });
  return { ids: out, resolved, unresolved: ids.filter((i) => bare.includes(i) && !map.has(i)) };
}

/**
 * 复位工作区到基线，并屏蔽「跑测自身产生的噪音目录」。
 *
 * `.agent/` 是 claude-pi 按设计写在 cwd（项目目录）下的会话数据
 * （见 src/session-manager.ts 顶部注释），它不是解答的一部分；
 * 若不排除，候选补丁里会混进一堆 jsonl，污染 diff 与后续评测。
 * 用 .git/info/exclude（本地、不改仓库任何受版本控制的文件）而不是改 .gitignore。
 */
export async function resetWorkspace(dexecFn, cname, { workdir = "/testbed" } = {}) {
  const noise = [".agent/", ".pytest_cache/", "__pycache__/", ".mypy_cache/", "*.pyc"];
  const excludeCmd =
    `mkdir -p .git/info; for p in ${noise.map((n) => `'${n}'`).join(" ")}; do ` +
    `grep -qxF "$p" .git/info/exclude 2>/dev/null || echo "$p" >> .git/info/exclude; done`;
  const r = await dexecFn(
    cname,
    // 顺序要紧：先 reset 撤暂存，再 checkout 让工作树对齐 HEAD（若先 checkout 会从暂存区恢复，
    // 已暂存的改动就残留下来了），最后 clean 掉未跟踪文件
    `git reset -q 2>/dev/null; git checkout -- . 2>/dev/null; git clean -fdq 2>/dev/null; ${excludeCmd}; echo reset-ok`,
    { timeoutMs: 180_000, workdir },
  );
  return { ok: r.stdout.includes("reset-ok"), detail: r.stdout.trim() };
}

/** 从上一轮 usage 里抽指标 */export function sumUsage(turns) {
  const agg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0, assistantTurns: 0 };
  for (const t of turns || []) {
    if (t.role !== "assistant") continue;
    agg.assistantTurns++;
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
  return agg;
}

/** 解析 `--mode json` 的 stdout（容错：容忍尾部杂质并记录） */
export function extractJson(stdout) {
  const start = stdout.indexOf("{");
  if (start < 0) return { value: null, trailing: stdout.trim(), pure: false };
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
        const trailing = stdout.slice(i + 1).trim();
        try {
          return { value: JSON.parse(raw), trailing, pure: trailing === "" };
        } catch (e) {
          return { value: null, trailing, pure: false, parseError: String(e) };
        }
      }
    }
  }
  return { value: null, trailing: stdout.slice(start).trim(), pure: false, parseError: "unbalanced" };
}

export const exists = (p) => existsSync(p);

export async function readJsonl(p) {
  if (!existsSync(p)) return [];
  const txt = await readFile(p, "utf8");
  return txt.trim().split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { __parseError: l.slice(0, 200) }; }
  });
}

export async function writeJson(p, obj) {
  await mkdirp(dirname(p));
  await writeFile(p, JSON.stringify(obj, null, 2) + "\n");
}

export { rm, readFile, writeFile, stat };
