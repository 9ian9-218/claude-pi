/**
 * instances.mjs — 权威基准的任务清单
 *
 * 三个来源：
 *   1. SWE-bench Verified（princeton-nlp/SWE-bench_Verified，500 条中的 10 条）
 *      —— 真实 GitHub issue + 官方 FAIL_TO_PASS / PASS_TO_PASS 金标测试
 *   2. Aider Polyglot Benchmark（Aider-AI/polyglot-benchmark）
 *      —— Exercism 官方题面 + 原生测试套件，python 子集
 *   3. Terminal-Bench 2.0（harbor-framework/terminal-bench-2）
 *      —— 官方任务镜像 + 官方 verifier（/tests/test.sh）
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HERE } from "./lib.mjs";

/** SWE-bench Verified 选中实例（字段取自官方数据集，逐字保留） */
export const SWE_BENCH_INSTANCES = JSON.parse(readFileSync(join(HERE, "swebench-selected.json"), "utf8"));

/**
 * 各仓库的依赖准备方式。
 *
 * 必须在「跑 agent 的那个容器」里执行：容器是一次性的，
 * 早先在一个用完即弃的容器里装依赖，到评测时依赖已随容器消失（实测 ImportError 一片）。
 *
 * 官方 SWE-bench 给每个仓库配了固定代际的环境；这里用轻量方式对齐同一件事，
 * 否则老提交在新工具链下会以「与被测代码无关」的方式失败（实测逐条确认）：
 *   - flask 2023 的 conftest 用到 pytest 9 已移除的 API        → 固定 pytest 8.3.5
 *   - pylint 2021/2022 依赖 py / 老 astroid 兼容的 wrapt      → 固定 pytest 8.3.5 + wrapt 1.14.1 + py
 *   - pytest-dev 自身仓库缺 git tag，setuptools_scm 推出 0.1.dev1，
 *     低于 pyproject 的 minversion 要求直接拒绝启动            → 用 PRETEND_VERSION 兜底
 *   - fallback 用于老提交带不动现代 setuptools 的情况（`pip install -e .` 会失败）
 */
export const REPO_SETUP = {
  "psf/requests": {
    install: "pip install -q -e .",
    fallback: "pip install -q urllib3 idna certifi charset_normalizer",
    pyPath: ".",
  },
  "pytest-dev/pytest": {
    install: "SETUPTOOLS_SCM_PRETEND_VERSION=8.0.0 pip install -q -e .",
    fallback: "pip install -q attrs iniconfig packaging pluggy exceptiongroup tomli",
    // 老 pytest 源码（6.x）依赖新版 pytest 已不再需要的件（实测 rewrite.py 直接 import atomicwrites）
    postInstall: "pip install -q atomicwrites more-itertools wcwidth py",
    pyPath: "src:.",
  },
  "pallets/flask": {
    install: "pip install -q -e .",
    fallback: "pip install -q Werkzeug Jinja2 itsdangerous click blinker",
    // flask 2023-03 的时代对应 Werkzeug 2.3；Werkzeug 3 移除了 flask 当时还在用的 API
    postInstall: 'pip install -q "pytest==8.3.5" "Werkzeug==2.3.7"',
    pyPath: "src:.",
  },
  "pylint-dev/pylint": {
    install: "pip install -q -e .",
    fallback: "pip install -q astroid isort mccabe platformdirs toml colorama dill",
    postInstall: 'pip install -q "pytest==8.3.5" "wrapt==1.14.1" py',
    pyPath: ".",
  },
  "sympy/sympy": {
    install: "pip install -q -e .",
    fallback: "pip install -q mpmath",
    pyPath: ".",
  },
};

export function setupFor(repo) {
  return REPO_SETUP[repo] ?? { install: "pip install -q -e .", fallback: "true", pyPath: "." };
}

/** 容器内绝对 PYTHONPATH：让仓库自身的包优先于 site-packages 里的同名包 */
export function pyPathAbs(repo, root = "/testbed") {
  return setupFor(repo).pyPath
    .split(":")
    .map((p) => (p === "." ? root : `${root}/${p}`))
    .join(":");
}

/**
 * 在容器里装好仓库依赖（幂等：/tmp/.cpi-provisioned 标记）。
 * 顺序：editable 安装 → 失败则显式依赖兜底 → 世代对齐的固定版本。
 */
export async function provisionRepo(dexecFn, cname, repo, { workdir = "/testbed" } = {}) {
  const s = setupFor(repo);
  const cmd =
    `if [ ! -f /tmp/.cpi-provisioned ]; then ` +
    `( ${s.install} ) 2>/tmp/pip1.log || ( echo "[deps] editable 安装失败，改用显式依赖"; ${s.fallback} ) 2>/tmp/pip2.log; ` +
    (s.postInstall ? `( ${s.postInstall} ) 2>/tmp/pip3.log || echo "[deps] 世代对齐固定失败"; ` : "") +
    `touch /tmp/.cpi-provisioned; fi; ` +
    `PYTHONPATH=${s.pyPath} python3 -c "import sys; print('python ok', sys.version.split()[0])"`;
  const r = await dexecFn(cname, cmd, { timeoutMs: 900_000, workdir });
  return { ...r, pyPath: s.pyPath };
}


const pyTestFile = (slug) => `${slug.replace(/-/g, "_")}_test.py`;

/** Aider Polyglot python 子集：题面清晰、测试自洽、单文件为主 */
export const POLYGLOT_SELECTION = [
  { slug: "grade-school", note: "有序花名册，插入去重 + 排序" },
  { slug: "phone-number", note: "输入清洗与校验，纯字符串处理" },
  { slug: "wordy", note: "自然语言算式解析，易漏边界" },
  { slug: "proverb", note: "文本重排，考察逐字保真" },
  { slug: "pig-latin", note: "按规则改写单词，规则分支多" },
  { slug: "transpose", note: "矩阵转置，含不规则行" },
  { slug: "two-bucket", note: "两桶倒水，搜索 + 解路径" },
  { slug: "tree-building", note: "由记录重建树，含错误检测" },
].map((e) => ({
  id: `poly-python-${e.slug}`,
  lang: "python",
  slug: e.slug,
  note: e.note,
  testFiles: [pyTestFile(e.slug)],
  testCmd: `python3 -m pytest ${pyTestFile(e.slug)} -q -rA --no-header -p no:cacheprovider`,
}));

/**
 * Terminal-Bench 2.0 选中任务。
 * workdir 取自各任务 environment/Dockerfile 的最后一个 WORKDIR；
 * image 为官方预构建镜像（alexgshaw/<slug>:20251031）。
 * 派生镜像 cpi-bench/tb:<slug> 在官方镜像之上仅注入 node 运行时。
 */
export const TB_SELECTION = [
  { slug: "fix-git", workdir: "/app/personal-site", note: "detached HEAD 找回提交并合回 master" },
  { slug: "sanitize-git-repo", workdir: "/app/dclm", note: "清洗仓库中的密钥，且不改动无关文件" },
  { slug: "large-scale-text-editing", workdir: "/app", note: "大文件文本编辑，逐行保真" },
  { slug: "log-summary-date-ranges", workdir: "/app", note: "日志按日期区间汇总" },
  { slug: "regex-log", workdir: "/app", note: "从日志中提取指定模式" },
  { slug: "git-leak-recovery", workdir: "/app", note: "从 git 历史中恢复泄漏内容" },
].map((t) => ({
  ...t,
  id: `tb2-${t.slug}`,
  image: `cpi-bench/tbf:${t.slug}`,
  baseImage: `alexgshaw/${t.slug}:20251031`,
  testCmd: "bash /tests/test.sh",
}));
