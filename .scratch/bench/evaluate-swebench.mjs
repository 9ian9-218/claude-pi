/**
 * evaluate-swebench.mjs — SWE-bench 官方口径评测（可独立重放）
 *
 * 与 agent 执行解耦：只要 workspace 里留有候选补丁，就能重新评测，不必重跑 agent。
 * 早先把评测写死在跑测流程里，评测逻辑一有 bug 就必须连 agent 一起重跑（代价高得多）。
 *
 * 关键实现取舍：
 *   1. 按「测试文件」调用 pytest，而不是把上百个 node id 全塞进命令行 ——
 *      只要有一个 id 无效，pytest 会直接不收集任何用例（实测 tests="0"），
 *      于是 P2P 被误判成回归。跑文件也更接近官方 SWE-bench 的 test directives 口径。
 *   2. 结果按下标 `module.Class::test` 归一化后比对，忽略文件内其它用例的成败。
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { OUT, readFile, resolveTestIds } from "./lib.mjs";

/** junit 属性里的 XML 实体必须反转义：`&amp;` 不还原，带 `&` 的参数化 id 就永远匹配不上 */
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/** 解析 junit：保留 classname/name，供归一化比对 */
export function parseJunit(xml) {
  const cases = [];
  const re = /<testcase\b([^>]*?)(\/>|>)/g;
  let m;
  while ((m = re.exec(xml))) {
    // 属性提取必须带 `(?:^|\s)` 前缀：classname="x" 里含有子串 name="x"，
    // 裸的 /name="([^"]*)"/ 会先命中 classname，把所有用例名解析成模块名。
    const classname = unescapeXml((m[1].match(/(?:^|\s)classname="([^"]*)"/) || [])[1] || "");
    const name = unescapeXml((m[1].match(/(?:^|\s)name="([^"]*)"/) || [])[1] || "?");
    let status = "passed";
    if (m[2] === ">") {
      const rest = xml.slice(m.index);
      const end = rest.indexOf("</testcase>");
      const body = end >= 0 ? rest.slice(0, end) : rest.slice(0, 2000);
      if (/<failure\b/.test(body)) status = "failed";
      else if (/<error\b/.test(body)) status = "error";
      else if (/<skipped\b/.test(body)) status = "skipped";
    }
    cases.push({ id: classname ? `${classname}::${name}` : name, classname, name, status });
  }
  return cases;
}

/**
 * 只按「括号深度为 0」的 `::` 切分。
 *
 * 官方 id 的参数里会带 `::`（IPv6 用例 `test_errors[http://fe80::5054:ff:fe5a:fc0-InvalidURL]`），
 * 裸 split("::") 会把它切成四段、把 IPv6 的后半截当成用例名，该用例于是永远匹配不上 ——
 * 「解析失败」被误报成「P2P 未通过」，直接把 resolved 从 7/9 压成 5/9。
 */
function splitTopLevel(id) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < id.length; i++) {
    const c = id[i];
    if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && c === ":" && id[i + 1] === ":") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** SWE-bench id → junit 的 `module.Class::test` 形态 */
export function normId(id) {
  const parts = splitTopLevel(String(id));
  if (parts.length < 2) return null;
  const file = parts[0].replace(/\.py$/, "").replace(/\//g, ".");
  const test = parts[parts.length - 1];
  const middle = parts.slice(1, -1);
  return `${[file, ...middle].join(".")}::${test}`;
}

/**
 * 官方 P2P 列表里存在一批本身就不完整的 id（参数化用例被从 `[` 处截断，
 * 例如 `...[test_http_parser-1`）。它们在任何环境下都不可能匹配上，
 * 必须与「真正没通过」区分开，否则会把环境噪声算成 agent 的回归。
 */
export function isMalformed(id) {
  const s = String(id);
  const open = (s.match(/\[/g) || []).length;
  const close = (s.match(/\]/g) || []).length;
  return open !== close || /[\r\n]/.test(s);
}

export const FAILED = new Set(["failed", "error"]);

/**
 * 跑一组官方 id（按文件调用），返回每个 id 的归因与整体结论。
 * @returns {{expected:number, matched:number, passed:number, failed:string[], missing:string[], malformed:string[], unresolved:string[], cases:number, tail:string}}
 */
export async function runTestGroup(dexec, cname, ids, { junitName, outDir, workdir = "/testbed", pyPath = "/testbed", timeoutMs = 1_800_000 } = {}) {
  const usable = ids.filter((i) => !isMalformed(i));
  const malformed = ids.filter(isMalformed);
  const { ids: nodeIds, unresolved } = await resolveTestIds(cname, usable, { workdir });
  const files = [...new Set(nodeIds.map((i) => i.split("::")[0]))];
  const quoted = files.map((f) => `'${f.replace(/'/g, `'\\''`)}'`).join(" ");
  const cmd =
    `rm -f /out/${junitName} && PYTHONPATH=${pyPath} python3 -m pytest ${quoted} ` +
    `-q --no-header -rA --tb=short --junitxml=/out/${junitName} -p no:cacheprovider 2>&1 | tail -60`;
  const r = await dexec(cname, cmd, { timeoutMs, workdir });

  // 输出目录必须显式传入：早先从容器名反推，金标容器（cpi-gold-*）对不上，
  // junit 读不到 → 所有 id 都判为未匹配（实测 0/9 全红）。
  const jp = join(outDir ?? OUT, junitName);
  const xml = existsSync(jp) ? await readFile(jp, "utf8") : "";
  const cases = parseJunit(xml);
  const statusByKey = new Map(cases.map((c) => [c.id, c.status]));
  // 裸函数名（sympy 风格）解析不到文件时，退化为按用例名匹配
  const nameToStatus = new Map();
  for (const c of cases) if (c.name) nameToStatus.set(c.name, c.status);

  const failed = [], missing = [];
  let passed = 0, matched = 0;
  for (const id of usable) {
    const key = normId(id);
    let status = key ? statusByKey.get(key) : undefined;
    if (status === undefined && !String(id).includes("::")) status = nameToStatus.get(String(id));
    if (status === undefined) { missing.push(id); continue; }
    matched++;
    if (status === "passed") passed++;
    else failed.push(`${id}(${status})`);
  }
  const expected = usable.length;
  return {
    expected, matched, passed, failed, missing, malformed,
    unresolved: unresolved ?? [], cases: cases.length,
    allPass: expected > 0 && matched === expected && passed === expected,
    // 官方列表里存在本 commit 根本不存在的陈旧 id（已在源码中核实）。
    // 那种 id 在任何环境下都匹配不上，只能记为 unmatched —— 它既不是 agent 的回归，
    // 也不该被当成「全过」。两个口径分开报，避免环境噪声污染结论。
    noRegression: matched > 0 && failed.length === 0,
    tail: r.stdout.slice(-1500),
  };
}

/** 在容器里给 workspace 打上官方测试补丁（先复位被 agent 改过的测试文件） */
export async function applyTestPatch(dexec, cname, inst, { workdir = "/testbed" } = {}) {
  const paths = [...inst.test_patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  const reset = paths.length
    ? `git checkout HEAD -- ${paths.map((p) => `'${p}'`).join(" ")} 2>/dev/null || true`
    : "true";
  const r = await dexec(
    cname,
    `${reset}; ` +
      `(git apply --whitespace=nowarn /out/test_patch.diff 2>/out/apply.err ` +
      `|| git apply -3 --whitespace=nowarn /out/test_patch.diff 2>>/out/apply.err); echo "apply=$?"`,
    { timeoutMs: 300_000, workdir },
  );
  return { applied: /apply=0/.test(r.stdout), detail: r.stdout.trim() };
}
