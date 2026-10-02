# claude-pi 评测问题清单与失败轨迹深挖

生成时间：2026-09-18　·　被测版本：本仓库 main（`315eee9`）　·　模型：`opencode-go/deepseek-v4.1-flash`（thinking=max）

数据来源全部是跑测期落盘的产物：`$HOME/cpi-bench/out/<task>/{turns.json,exec.jsonl,fetch.jsonl,result.json,junit-*.xml,agent.stderr.txt}`。
本文只写「有问题的地方」及其证据链，完整成绩与缓存分析见 [report.md](report.md)。

---

## 0. 一句话结论

三个权威基准跑 23 个任务（TB 重验后 29 次任务运行）：

| 基准 | 成绩 | 未通过的任务 |
| --- | --- | --- |
| SWE-bench Verified | **6/9 resolved**（无 P2P 回归口径 **7/9**） | `psf__requests-6028`（F2P 0/2）、`pylint-dev__pylint-4970`（F2P 0/1）；`pylint-dev__pylint-7277` 只差 1 条**官方列表里本 commit 不存在**的 P2P id |
| Aider Polyglot（python 子集） | **8/8 通过** | — |
| Terminal-Bench 2.0 | **5/6 通过** | `large-scale-text-editing`（5 项测试挂 1 项） |

两个未通过的 SWE-bench 实例都是**模型改错了地方**（不是环境问题，有金标对照兜底）；
TB 唯一的失败是**少写一个冒号**，叠加了「100 轮上限静默截断」。
另外发现 claude-pi 自身 **9 个缺陷**，其中 3 个属高危：worktree 吞改动、工具异常不隔离（导致整个 run 崩溃、stdout 空）、轮次用尽无任何信号。

> 修正说明（重要）：本文档修正了两处**我自己评测基建**的错误 ——
> ① SWE-bench 的 id 归一化 bug 把 `psf__requests-5414`、`pylint-dev__pylint-7277` 误判为「P2P 未过」。修正后 5414 是完整 RESOLVED（P2P 128/128），7277 是「无回归」（P2P 108/108 全过，只剩 1 条官方陈旧 id）；严格口径成绩由 5/9 变为 **6/9**，无回归口径为 7/9；
> ② TB 的 verifier 命令带了 `| tail`，管道退出码恒为 0，导致原报的「TB 6/6 通过」是假通过，修正后为 5/6。详见 §4。

---

## 1. 未通过任务逐条归因

### 1.1 `psf__requests-6028` —— 改错函数：检索被自己的假设框住

**结果**：F2P 0/2、无 P2P 结论（F2P 未绿即不评 P2P）。

**官方金标**（`requests/utils.py::prepend_scheme_if_needed`）：

```python
    if auth:
        # parse_url doesn't provide the netloc with auth
        # so we'll add it ourselves.
        netloc = '@'.join([auth, netloc])
```

**失败断言**（junit）：

```
tests/test_utils.py:615: assert prepend_scheme_if_needed(value, 'http') == expected
E   - http://user:pass@example.com/path?query
E   + http://example.com/path?query
```

即：URL 里的 userinfo 被 `prepend_scheme_if_needed` 丢掉了，官方要的就是把它接回去。

**模型改了什么**：整条补丁都在「代理认证为 None」这条线上 —— 新增 `get_auth_from_url_safe()`、改 `sessions.py::rebuild_proxies`、给 `auth.py::_basic_auth_str` 加 `None → ''` 兜底。**完全没有碰 `prepend_scheme_if_needed`。**

**轨迹证据**（`out/psf__requests-6028/turns.json`，26 次工具调用）：

| 轮次 | 动作 | 说明 |
| --- | --- | --- |
| 1 | `run_bash`（ls/git log）+ `grep`（pattern 含 `proxy_authorization\|...\|tunnel`） | **`grep` 工具当场失败：ripgrep 不可用**（见 §3.7），并行批次少了一条腿 |
| 4 | `grep -rn "proxy_authorization\|_get_proxy_headers\|tunnel" requests/` | 关键词全部来自题面里的「Proxy authentication bug」+ 407 |
| 8 | `grep -n "get_auth_from_url\|unquote\|urldefragauth\|def resolve_proxies" requests/utils.py` | **检索词由假设反推而来** |
| 11–14 | 读 `utils.py` 985–995 行、`sessions.py`、`auth.py` | 读的正是 `get_auth_from_url` |
| 16 | 开始 `edit_file` 写 `get_auth_from_url_safe` | 此时只用了 8 次调用就进入了实现 |

关键事实：**金标函数 `prepend_scheme_if_needed` 就位于 `utils.py:974`，而模型读的区间从 985 行开始 —— 只差 11 行。** 它没读到，因为搜索词里从来没有出现过这个函数名：它先认定「407 = 代理认证头构造失败」，于是只搜 `auth`/`proxy` 相关符号。

**归因**：
1. 题面给了误导性线索（报告者猜测「是 CPython 3.8.12 的 urlparse 行为变化」），模型直接采信了报告者的假设；
2. 检索是**假设驱动**而非**路径驱动** —— 没有沿着「代理 URL → resolve_proxies → prepend_scheme_if_needed」的调用链走一遍；
3. 环境噪声放大了它：`grep` 工具在第一步就失败（ripgrep 需运行时下载，见 §3.7），它退化成自己手写 grep 关键词。

**可优化点**：任务类 bug 修复里，cpi 可以要求「先定位报错路径上的全部函数再动手」；或对 `grep` 失败做更强的降级（内置 JS 实现兜底），避免第一步就丢掉一个检索工具。

---

### 1.2 `pylint-dev__pylint-4970` —— 行为契约不符：把自己的观察当成了规格

**结果**：F2P 0/1。

**官方金标**（`pylint/checkers/similar.py::Similar.run`）：

```python
    def run(self) -> None:
        """start looking for similarities and display results on stdout"""
        if self.min_lines == 0:
            return
        self._display_sims(self._compute_sims())
```

**官方测试**（test patch）：

```python
def test_set_duplicate_lines_to_zero() -> None:
    output = StringIO()
    with redirect_stdout(output), pytest.raises(SystemExit) as ex:
        similar.Run(["--duplicates=0", SIMILAR1, SIMILAR2])
    assert ex.value.code == 0
    assert output.getvalue() == ""      # ← 关键：禁用时不该有任何输出
```

**失败断言**（junit）：

```
assert output.getvalue() == ""
E   + TOTAL lines=62 duplicates=0 percent=0.00
```

**模型改了什么**：在 `_find_common()` 里加 `if self.min_lines == 0: return`（跳过重复计算），并更新了选项帮助文本。效果是「不再报 R0801」，但 `run()` 仍然打印汇总行 `TOTAL lines=... duplicates=0 percent=0.00`。

**轨迹证据**（`out/pylint-dev__pylint-4970/turns.json`，40 次工具调用）：

| 轮次 | 动作 | 说明 |
| --- | --- | --- |
| 1 | `grep` 工具（失败，ripgrep 不可用）→ 改 `run_bash grep` | 同上，环境噪声 |
| 23 | 「Two approaches: guard in `_find_common` (avoid work) is best」 | 选了「省算力」而非「行为对齐」的实现位置 |
| 31–37 | `python -m pylint ...` → `/bin/sh: 1: python: not found`；重试用 `python3`；再报 `MissingSectionHeaderError`；再用 `${PIPESTATUS[0]}` → `/bin/sh: 1: Bad substitution` | 连续 3 次环境摩擦（缺 `python` 别名、`run_bash` 是 dash 不是 bash） |
| 49 | 自己写测试：`assert 'TOTAL lines=62 duplicates=0 percent=0.00' in output` | **把「我实现出来的输出」当成了期望值** —— 与被官方测试判失败的那一行完全对应 |
| 75 | `pytest tests/checkers/unittest_similar.py -q` → 18 passed | 自测全绿，于是收工 |

**归因**：
1. 需求原文是「Setting `min-similarity-lines` to `0` should **disable the duplicate code check**」。「禁用」的自然读法是**什么都不输出**，而模型选择了保留汇总行 —— 它没有回到需求文本上做一次对照，而是用自己刚跑出来的输出反向固化了期望；
2. 自测的设计缺陷：测试是**照着实现写的**（observation-driven），不是照着需求写的（spec-driven），因此自测全绿并不能证明需求被满足；
3. 环境摩擦（3 次无效命令）消耗了它的耐心预算，但它最终还是走到了「加测试 + 全量跑」这一步，说明这不是没时间，而是**验证目标选错了**。

**可优化点**：cpi 的验证闭环里，除了「跑测试」还应包含「逐条对照验收标准」；当产出一个面向用户的命令/接口行为变更时，用需求里的动词（disable/remove/skip）反查输出面。

---

### 1.3 `tb2-large-scale-text-editing` —— 少一个冒号，加上 100 轮上限静默截断

**结果**：`reward=0`，5 项官方测试 4 通过 1 失败。

**失败断言**：

```
/tests/test_outputs.py:156: in test_apply_macros_well_formed
    assert has_exit, "Missing :wq or :x"
E   AssertionError: Missing :wq or :x
```

**终态产物**（从本轮新增的终态快照 `out/tb2-large-scale-text-editing/final-workspace.tgz` 取出）：

```
call setreg('a', "0w\"xyiwf,w\"yyiwf,w\"zyiw0D\"zPA;\<Esc>\"ypA;\<Esc>\"xp")
call setreg('b', "A;OK\<Esc>")
call setreg('c', "gU$")
%normal! @a
%normal! @b
%normal! @c
wq                     ← 少了冒号；官方断言要求这一行恰好是 ":wq" 或 ":x"
```

注意 `test_apply_macros_runs` **通过了**（vim 退出 0、输出与 expected.csv 逐字节相同）。也就是说产物在功能上是对的，只在「字面契约」上不合规 —— Vim 脚本允许省略行首冒号，模型按自己的 Vim 知识写成了 `wq`，而题面里明确写的是 `Exit: :wq or :x`。

**轨迹证据**（`out/tb2-large-scale-text-editing/turns.json`，203 条消息）：

- 全程 17 处提到 `wq`，**从第 28 条消息开始就一直是 `wq`（无冒号）**，题面里的 `:wq` 只在第 0 条（题面本身）出现过一次，之后再没被对照过；
- 最后一次工具调用是 `complete_task task_3`，返回 `Completed task_3 (Test and verify output)`，**之后循环直接结束，没有 final 文本**；
- 会话构成是 **3 条 user + 100 条 assistant + 100 条 tool = 203 条**，最后一条是 `Completed task_3` 的工具结果；assistant 消息里的 `tool_calls` 总数正好 **100** —— 与 `maxTurn` 默认值吻合，即这一轮是**撞上限停的，不是模型自然收尾**；
- 收官前它还 `cat` 了一遍 `apply_macros.vim` 并算了 keystroke 数 —— 文件内容在眼前，`wq` 缺冒号没被发现，因为它校验的是自己设定的标准（<200 keystrokes、输出一致）；
- 全程 5 次权限拒绝（都是 `rm` 清理自己的临时文件，见 §3.5），最后一次是为了删掉自己生成的 CSV，被拒后用 `python3 -c "os.remove(...)"` 绕过；
- 全程没有读过 `/tests/test_outputs.py`（该目录以只读挂载，与官方一致）。

**归因（两层）**：
1. **字面契约未机械核对**：题面把「Exit: `:wq` or `:x`」写在验收清单里，模型把它理解成语义等价物（`wq`）就收工了。缺少「按题面逐条 grep 自检」的收尾动作；
2. **轮次耗尽静默退出**（cpi 缺陷 D3）：`maxTurn=100` 撞顶后 `agentLoopInner` 返回 null，`--mode json` 照样输出合法 JSON，只有 `final` 是空的，**调用方无法区分「模型没话说」和「预算用尽被截断」**。本例里它恰好已经写完产物，所以不影响判定；但如果截断发生在写文件之前，就会出现「无错误、无产物」的静默失败。

**可优化点**：① 把 turn 上限做成可配置并在撞顶时给出明确信号（stderr 提示 + JSON 字段）；② 在收尾阶段加一个「按验收清单逐条自检」的动作（本例只需 `grep -q '^:\?wq$'` 级别的检查就能发现）。

---

### 1.4 `tb2-sanitize-git-repo` —— 工具异常未隔离，整个 run 崩溃（1/2 复现）

**结果**：首轮 `agentExit=1`、**`--mode json` stdout 0 字节**、任务被崩溃中止；重跑一轮正常完成（80 轮、reward=1）。

**证据**（`out/tb2-sanitize-git-repo/agent.stderr.txt` 首轮）：

```
[HOOK] complete_task(...)
[unhandledRejection] Error: Task task_3 is pending, cannot complete
    at file:///cpi/src/tasks.ts:401:13
    at async Tool.execCompleteTask [as execute] (file:///cpi/src/tools/tasks-board.ts:42:18)
    at async executeToolCall (file:///cpi/src/tools/runtime.ts:152:18)
    at async agentLoopInner (file:///cpi/src/agent-loop.ts:234:26)
    at async runSingleTurn (file:///cpi/src/cli.ts:225:5)
```

同一次运行里，模型对 `task_1`、`task_2` 的 `complete_task` 都成功了，只有对**从未 claim 过**的 `task_3` 报错 —— 而这条错误直接把进程打挂。

**链条（三处叠加）**：

1. `src/tasks.ts:401` —— 状态不合法时**抛异常**而不是返回错误串：`throw new Error(\`Task ${taskId} is ${task.status}, cannot complete\`)`；
2. `src/tools/tasks-board.ts:41-45` —— `execCompleteTask` **没有 try/catch**（对比 `runCreateTask`/`runGetTask` 都包了 `try/catch → "Error: ..."`）；
3. `src/tools/runtime.ts:152` (`const result = tool.run(args)`) 与 `src/agent-loop.ts:234` (`toolResult = await executeToolCall(...)`) —— **都没有单次调用级的错误隔离**。

于是同类错误出现两种行为：`edit_file` 出错 → 模型看到错误串、自行纠正；`complete_task` 出错 → 整个 run 中止，调用方拿到空 stdout。

**同轮次的其他环境摩擦**（同一份 stderr）：

- **2 次权限误判**：`git worktree list && echo "--- final confirm at repo root ---"` 被判「Potentially destructive command」—— 命中的是 `confirm at` 里的子串 `rm `（见 §3.5）；
- 模型为了搞清楚「改动到底在哪个树里」反复执行 `pwd` / `git worktree list` / 对比主树与 worktree 的同一个文件（见 §3.1）。

**影响**：`--mode json` 的输出契约被破坏（stdout 空），任何自动化调用方都会当成「无输出」。会话数据是逐条落盘的（`cpi --session <id>` 可恢复），属「可恢复但契约破坏」。**29 次任务运行里发生 1 次。**

---

## 2. 评测基建自身的缺陷（会直接污染结论，已修）

> 这一节是「我的测量工具坏了」，不是被测对象的问题。写在这里是因为它解释了为什么第一版报告的成绩是错的。

### 2.1 TB verifier 用了管道，退出码恒为 0 → 6/6 假通过

```js
// 旧代码（run.mjs）
`python3 -m pytest /tests/test_outputs.py ... 2>&1 | tail -45`
reward = d.code === 0 ? "1" : "0";     // d.code 是 tail 的退出码，恒 0
```

修法：把输出重定向到文件、单独 `echo "PYTEST_EXIT=$?"`，并增加 `collected N items` 的兜底校验（收集期报错时 N=0，不能算通过）。

修正后重跑 6 个 TB 任务：**5/6**。第一轮被判「通过」的 `tb2-large-scale-text-editing` 实际是失败的；`sanitize-git-repo` 首轮连测试都没收集起来（`ModuleNotFoundError: No module named 'git'`，镜像缺 GitPython），照样被记成 reward=1。

### 2.2 SWE-bench 的 id 归一化有两处 bug → 2 个实例假失败

```js
// 旧代码（evaluate-swebench.mjs）
const parts = String(id).split("::");   // ← bug 1
const classname = (m[1].match(/(?:^|\s)classname="([^"]*)"/) || [])[1];  // ← bug 2：未反转义 XML 实体
```

- **bug 1**：官方 id 的参数里会带 `::`，例如 `tests/test_requests.py::TestRequests::test_errors[http://fe80::5054:ff:fe5a:fc0-InvalidURL]`。裸 `split("::")` 把它切成 4 段，IPv6 的后半截被当成用例名 → 该用例永远匹配不上 → 被归入 `missing` → `p2pAllPass=false` → 判为未解决。修法：只按**括号深度为 0** 的 `::` 切分。
- **bug 2**：junit 属性里的 `&amp;` 没有还原，导致带 `&` 的参数化 id 匹配不上（`test_params_are_added_before_fragment[http://example.com/path?key=value#fragment-...&a=b#fragment]`）。

修正效果（同一批 junit 文件离线重算）：

| 实例 | 修正前 | 修正后 |
| --- | --- | --- |
| `psf__requests-5414` | P2P 126/128 matched → UNRESOLVED | **P2P 128/128 全过 → RESOLVED** |
| `pylint-dev__pylint-7277` | P2P 108/109 matched → UNRESOLVED | **P2P 108/108 全过（1 条官方陈旧 id）→ 无回归** |

`pylint-dev__pylint-7277` 剩下那 1 条 `tests/test_self.py::TestRunTC::test_stdin[/mymodule.py]` 是**官方 P2P 列表里的陈旧条目**：该 commit 的 `test_self.py` 只有两个参数化（`join(HERE,"mymodule.py")` 与 `"mymodule.py"`），金标补丁也没动这个测试，所以它在任何环境下都不可能被收集到。这类条目应当单独记账（unmatched），不能算成 agent 的回归。

### 2.3 仓库依赖装不全，削弱了模型的自我验证能力

| 现象 | 出现的任务 | 后果 |
| --- | --- | --- |
| `fixture 'mocker' not found`（缺 pytest-mock） | psf__requests-6028 | 模型跑 `tests/test_utils.py` 时看到一片 ERROR，判断为「环境问题」后收工 |
| `recursive dependency involving fixture 'httpbin'` | psf__requests-5414、6028 | 同上 |
| `ModuleNotFoundError: No module named '_pytest._version'` / `hypothesis` / `xmlschema` / `mypy` | pytest-dev__pytest-10081、10356 | pytest 自身测试套件跑不全 |

修法：`provisionRepo` 里除 `pip install -e .` 外，再按仓库自带的 dev/test requirements 安装（requests: `requirements-dev.txt`；pytest: `testing/requirements.txt` 等）。SWE-bench 官方镜像就是这么做的，装全之后模型才能真正跑完整测试文件。

### 2.4 TB 的终态工作区丢失

TB 的 workspace 在镜像里（`/app/dclm` 等），容器一删就没了 —— 首轮崩溃的那次连「最终产物长什么样」都取不到，只能靠 stderr 里的栈。已在 `run.mjs` 的 `finally` 里加 `docker exec ... tar czf /out/final-workspace.tgz`，本次举证 `apply_macros.vim` 就靠它。

---

## 3. claude-pi 侧缺陷清单（按严重度）

### 3.1 【高】`claim_task` 的 worktree 会把改动吞掉

**现象**：`claim_task` 后工作目录被切到 `.agent/worktrees/<task_id>`，模型在那儿改的文件，在 `complete_task` 之后**全部消失且无任何提示**。

**确定性复现**（无需模型，`.scratch/bench/probe-worktree.mjs`）：

```
$ node .scratch/bench/probe-worktree.mjs
[worktree] created at /tmp/cpi-wt-probe-WW21zx/.agent/worktrees/task_1 (branch: agent/task-task_1)
claim 后 workdir = /tmp/cpi-wt-probe-WW21zx/.agent/worktrees/task_1
worktree 内改动 = VALUE = 2  # fixed
[complete] probe: 改 app.py ✓
complete 后 workdir = /home/z9ian9/myproject/claude-pi      ← 见 §3.8
worktree 是否还在  = false
主树 app.py        = VALUE = 1                              ← 改动没了
结论：改动丢失 → 复现缺陷
```

**代码定位**：

- `src/tasks.ts:315-320`：claim 时 `createTaskWorktree(taskId)` + `setWorktreeOverride(wt)`；
- `src/tasks.ts:415-416`：complete 时 `removeTaskWorktree(taskId)` + `setWorktreeOverride(null)`；
- `src/worktree.ts:101-128`：`removeTaskWorktree` = `git worktree remove` → 失败则 **`--force`** → `git worktree prune` → **`git branch -D agent/task-<id>`**。

**没有任何 merge/commit 回主树的步骤**，而 `--force` + `branch -D` 正好会把「未提交的改动」与「已提交的分支」一起删干净。

**轨迹证据**（`out/sympy__sympy-15875/turns.json`，该任务最终仍 RESOLVED，但代价可观）：

| 轮次 | 动作 | 结果 |
| --- | --- | --- |
| 43 | `claim_task task_1` | workdir 切到 worktree |
| 49 | `edit_file /testbed/sympy/core/add.py`（绝对路径） | `{"status":"error","message":"Path escapes workspace: /testbed/sympy/core/add.py"}` |
| 51 | `pwd && ls` | 才发现自己在 worktree 里 |
| 53 | `edit_file /testbed/.agent/worktrees/task_1/sympy/core/add.py` | 成功 |
| 65 | `complete_task task_1` | worktree 被删 → 改动消失 |
| 91 | `git status --short && git diff --stat; git worktree list` | 主树干净，找不到改动 |
| 93 | `git branch -a && git log --all --oneline -5` | 找丢失的分支 |
| 99/101 | 把同两处改动**重新**写进主树 | 这才保住结果 |

即：模型为了这次「工作目录凭空切换 + 改动凭空消失」多花了约 8 轮（65 次调用里的 12%），而且**是它自己发现并补救的**；换个不这么谨慎的模型，结果就是静默的错误补丁。

**建议**：`complete_task` 时把 worktree 的改动合并/复制回主树（`git -C wt diff` 应用到主树，或 `commit && merge --no-ff`）后再删除；至少要检查 `git status --porcelain`，非空则拒绝删除并把改动落盘到一个可恢复的位置。此外，`setWorktreeOverride` 这种「静默切换工作目录」的行为应当在工具返回值里显式告知模型（现在只在 stderr 打了一行 `[worktree] switched to ...`，模型看不到）。

---

### 3.2 【高】工具异常没有隔离：一次工具报错会中止整个 run

见 §1.4。三处叠加，修复点三选一即可（建议全都加）：

| 位置 | 现状 | 建议 |
| --- | --- | --- |
| `src/tools/runtime.ts:152` `const result = tool.run(args)` | 只有 MCP 分支包了 try/catch | 整体包 try/catch，返回 `{"status":"error",...}` 串 |
| `src/agent-loop.ts:234` `await executeToolCall(...)` | 无隔离 | 单次调用级 try/catch，异常转成工具结果 + `toolError: true`，让模型看到并自我纠正 |
| `src/tools/tasks-board.ts:41-45` `execCompleteTask` | 无 try/catch（同文件 `runCreateTask` 有） | 与 `runCreateTask` 对齐，返回 `Error: ...` 字符串 |
| `src/tasks.ts:401` | `throw` | 抛异常本身没问题（上层兜住即可），但语义上「状态不合法」是可预期错误，建议返回结构化错误 |

---

### 3.3 【高】100 轮上限静默截断，没有任何信号

**代码定位**：`src/agent-loop.ts:57` `const { maxTurn = 100, ... }`；`:66` `for (let turn = 0; turn < maxTurn; turn++)`；循环走完落到 `:286 return null`。

**现象**：`tb2-large-scale-text-editing` 两次运行都撞顶（100 次工具调用 / 203 条消息），进程以 0 退出、`--mode json` 输出合法 JSON、`final` 为空。**副作用**：模型没机会收尾（本例最后一次调用是 `complete_task`，之后直接断），调用方也拿不到「被截断」这个事实 —— `--mode json` 下 `final: null` 与「模型没说话」不可区分。

**建议**：
1. 把 `maxTurn` 暴露成 CLI 参数 / 环境变量（`--max-turns`），评测与生产都需可调；
2. 撞顶时在 stderr 明确打印（如 `[turn limit] hit maxTurn=100, stopping`），并在 JSON 里加字段（如 `"stopReason": "max_turns"`）；
3. 更理想：撞顶前给模型一次「预算剩 1 轮，请收尾」的注入，类似 compaction 的告警做法。

---

### 3.4 【中】`run_bash` 丢弃命令退出码

**代码定位**：`src/tools/bash.ts:15-28`：

```ts
const r = spawnSync(command, { cwd: getWorkdir(), shell: true, timeout: BASH_TIMEOUT_MS, ... });
if (r.status === null) return "Error: Timeout (120s)";
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
if (!out) return "(no output)";
return out;                       // ← r.status 被丢掉
```

**证据**：受控实验（不过模型）执行 `false` → 退出码 1、零输出，模型看到的就是 `(no output)`，与成功的静默命令（`cd`、`mkdir`）**完全同形**。本轮 390 次 shell 调用中，非零退出 27 次，其中「非零且零输出」**2 次**：`python3 -m pylint --help | grep -i -A3 "similarity"`（退出 1，模型看到 `(no output)`）与一段 `python3 -c` 内省脚本，恰好吃掉了失败信号。

**建议**：非零退出时在返回串里带上退出码（如 `\n[exit code: 1]`）；同时注意 `r.status === null` 也可能是被信号杀死，文案不该只写 Timeout。

---

### 3.5 【中】`run_bash` 的「危险命令」权限规则用子串匹配，误判率 31%

**代码定位**：`src/permission.ts:35-42`：

```ts
check: (args) => {
  const cmd = typeof args["command"] === "string" ? args["command"] : "";
  return ["rm ", "> /etc/", "chmod 777"].some((kw) => cmd.includes(kw));
},
message: "Potentially destructive command",
```

**实测**：全轮 13 次权限拒绝（**全部**是这一条规则），其中 **4 次是误判**：

| 命令片段 | 命中的子串 |
| --- | --- |
| `echo "--- final confirm at repo root ---"` | `confirm at` → **`rm `** |
| `... term should still be nonzero ...`（`python3 -c` 里的注释） | `term should` → **`rm `** |
| 同上另一条 | `term still` → **`rm `** |

另外 9 次是**真的 `rm`**，包括 `git-leak-recovery` 任务里「净化 reflog」这一必需动作（`rm -rf .git/logs && git reflog expire --all`）—— 在 headless 模式下被一刀切拒绝，模型只能绕道。

两个独立问题：
1. **规则本身**：同一个文件里的 `checkDenyList()`（`:52-77`）做了很细致的边界校验（特意注释说明「`rm -rf /` 不应匹配 `rm -rf /tmp/build`」），而这条规则却退回裸子串匹配 —— 内部标准不一致。建议按「命令词边界」匹配（如 `/(^|[;&|]\s*|\bsudo\s+)rm\s/`），或复用 `checkDenyList` 的思路。
2. **headless 语义**：`src/permission-sync.ts:74-86` 在非 TTY 下把 askUser 固定成「默认拒绝」，而模型收到的只有 `{"status":"error","message":"Permission denied: Potentially destructive command"}` —— **没有告诉它命中哪个关键词**，模型无法调整（本例只能靠猜或改用 python 删除）。建议在 message 里带上命中的关键词与命令片段，或提供 `--allow-destructive`/白名单机制。

---

### 3.6 【中】`run_bash` 用的是 `/bin/sh`（dash），不是 bash

`src/tools/bash.ts:18` `shell: true` → Debian/Ubuntu 上是 dash。轨迹里的直接后果：

```
cd /testbed && python3 -m pylint ... ; echo "EXIT: ${PIPESTATUS[0]}"
→ /bin/sh: 1: Bad substitution
```

（`pylint-dev__pylint-4970` 第 37 轮）模型想拿真实退出码，用了 bash 专有语法，直接报错。同类失败还有一次 `MissingSectionHeaderError`（配置文件格式问题，非 shell）。配合 §3.4（丢退出码），模型在「确认命令是否成功」这件事上被夹了两次。

**建议**：`shell: "/bin/bash"`，或在工具描述里写明「这是 POSIX sh」；同时按 §3.4 回传退出码。

---

### 3.7 【中】`grep` 工具依赖运行时下载 ripgrep，失败既耗时又不可恢复

**代码定位**：`src/ripgrep.ts:192-209` `ensureRipgrep()`：先 `resolveRipgrep()`（PATH / `RIPGREP_PATH`），找不到就 `downloadRipgrep()`（网络下载），失败则 `ensurePromise = null` 并抛错。

**实测**：

| 指标 | 值 |
| --- | --- |
| `grep` 工具调用总数 / 失败数 | 14 / **10**（71%） |
| 失败总耗时 | **222 秒**（中位 11.5s，最长 **120.8s**） |
| 失败表现 | `Error: ripgrep (rg) is not available: fetch failed. Install ripgrep on PATH, ...` |

失败的 10 次全部因为容器内无法访问下载源（`fetch failed`）。注意失败**不缓存**（设计如此，为了允许网络恢复后重试），所以在离线环境里每次调用都要再等 10–120 秒，且并行的工具批次会被它拖住（`psf__requests-6028` 里最长的一次工具调用 11.6s 就是它）。

**建议**：① 镜像里预装 `ripgrep`（`apt-get install -y ripgrep`，评测/CI 场景本就该如此）；② 工具层做纯 JS 降级实现（递归遍历 + 正则），保证「检索能力」永远可用；③ 给下载失败加短期熔断，避免同一回合内反复等待。

---

### 3.8 【低】`complete_task` 之后工作目录被设成 `process.cwd()`

**代码定位**：`src/workdir.ts:28-31`：

```ts
export function setWorktreeOverride(path: string | null): void {
  const ctx = workdirStore.getStore();
  if (ctx) ctx.workdir = path ?? process.cwd();     // ← 恢复到 process.cwd()，不是 claim 前的 workdir
}
```

**证据**：probe 里 claim 前 workdir = 临时仓库，complete 后变成 `process.cwd()`（claude-pi 仓库）。容器评测里恰好 `cwd == /testbed` 所以没暴露，但只要「有效工作目录 ≠ 进程 cwd」（子 agent、`--workdir`、teammate 场景）就会把后续操作引到错误的目录树。

**建议**：claim 时记录切换前的 workdir，complete 时精确还原。

---

### 3.9 【低】模型偶发用错工具名（`bash` / `run_in_background`），无别名容错

**证据**：整轮 640 次调用里 **3 次**用错名字，全部返回 `{"status":"error","message":"Unknown tool: ..."}`：

| 用错的名字 | 次数 | 任务 | 说明 |
| --- | --- | --- | --- |
| `bash` | 2 | `sympy__sympy-15875`、`pylint-dev__pylint-7277` | 参数与 `run_bash` 完全一致（`command` + `run_in_background`） |
| `run_in_background` | 1 | `tb2-regex-log` | 参数为 `{}` —— 把 `run_bash` schema 里的**参数名**当成了工具名 |

处理本身是**正确**的（错误串 + `toolError: true`，模型自行改正），只是每次浪费 1 轮。`run_bash` 是使用率最高的工具（405/640 = 63%），而它的名字与主流习惯（`bash`）不同、且 schema 里有个 `run_in_background` 参数容易被当成工具名 —— 证据表明这两点正是误用的来源。**建议**：在 `TOOL_MAP` 里加一层常见别名映射（`bash`→`run_bash`，`run_in_background` 视为 `run_bash` 且默认前台），或至少在 `Unknown tool` 的提示里附上「最接近的工具名」建议。

---

## 4. 环境/资源侧的观察（非 cpi 缺陷，但会干扰结论）

| 观察 | 数据 | 说明 |
| --- | --- | --- |
| 容器无 `python` 别名 | 18 次 `python: not found`，涉及 17/23 个任务 | 基础镜像只有 `python3`；SWE-bench 官方镜像通常有 `python`。每个任务都至少浪费一轮 |
| 模型用错工具名 | 3/640 次（`bash`×2、`run_in_background`×1） | 见 §3.9，cpi 侧的别名容错可吸收 |
| 测试依赖缺失 | `mocker`/`httpbin`/`hypothesis`/`xmlschema`/`mypy` | 见 §2.3，削弱模型自验能力 |
| `ripgrep` 不可下载 | 10/14 次 grep 失败 | 见 §3.7 |
| 无网络访问 `deb.debian.org` / `astral.sh` | TB 官方 `test.sh` 无法引导 | 评测侧已回退为「同一份官方测试文件直接 pytest」，判定口径一致 |

---

## 5. 优化优先级建议

| 优先级 | 事项 | 依据 | 预期收益 |
| --- | --- | --- | --- |
| P0 | `complete_task` 前把 worktree 改动合并回主树（或禁止静默删除） | §3.1 确定性复现 | 消除**静默丢失用户改动**这一最危险行为 |
| P0 | 工具调用级异常隔离（runtime.ts + agent-loop.ts） | §3.2 实测 1/29 次整轮崩溃、stdout 空 | `--mode json` 契约不再被破坏 |
| P1 | `maxTurn` 可配置 + 撞顶显式信号 | §3.3 实测 2/2 次撞顶 | 可区分「被截断」与「完成」，长任务可跑完 |
| P1 | `run_bash` 回传退出码 + 改用 bash | §3.4 / §3.6 | 消除「静默失败被当成功」 |
| P1 | 权限规则的命令词边界匹配 + 拒绝原因带上命中关键词 | §3.5 13 次拒绝，4 次误判 | 误判率降到 0；误判时模型可自我纠正 |
| P1 | `grep` 离线兜底 + 评测镜像预装 ripgrep | §3.7 71% 失败、222 秒浪费 | 检索工具可用性 100% |
| P2 | 评测/正式镜像补 `python` 别名、仓库 dev requirements | §2.3 / §4 | 模型能跑完整测试、少绕路 |
| P2 | `setWorktreeOverride` 精确还原 workdir | §3.8 | 子 agent / 多目录场景不再跑偏 |
| P2 | 工具别名映射（`bash`→`run_bash`） | §3.9 | 省 0.4% 调用 |
| P2 | 收尾阶段「按验收标准逐条自检」的行为引导 | §1.3 / §1.2 | 减少「功能对但字面契约不符」类失败 |

---

## 6. 复现

```bash
# 基建（脚本在仓库内，产物在 $HOME/cpi-bench）
node .scratch/bench/prepare.mjs swebench|polyglot|terminalbench
node .scratch/bench/validate.mjs                 # 金标对照：先证明评测环境正确（9/9）
node .scratch/bench/run.mjs --bench=swebench --concurrency=3
node .scratch/bench/run.mjs --bench=terminalbench --concurrency=3   # verifier 已修为真实退出码
node .scratch/bench/reeval.mjs                   # 只重放评测（会把结论回写 result.json）
node .scratch/bench/analyze.mjs                  # 轨迹 + 缓存分析
node .scratch/bench/report.mjs                   # 生成 report.md

# 缺陷复现（不需要模型、不花 token）
node .scratch/bench/probe-worktree.mjs           # §3.1：claim/complete 之后改动是否还在

# 单条轨迹速查
python3 - <<'PY'
import json; t=json.load(open("$HOME/cpi-bench/out/<task>/turns.json"))["turns"]
for i,x in enumerate(t):
    if x["role"]=="assistant":
        for tc in x.get("tool_calls") or []:
            print(i, tc["function"]["name"], tc["function"]["arguments"][:160])
PY
```

关键产物位置：每任务 `out/<id>/{turns.json（完整会话）, exec.jsonl（真实退出码）, fetch.jsonl（出站 payload 哈希）, junit-*.xml（官方口径结果）, result.json, agent.stderr.txt, final-workspace.tgz（TB 终态快照）}`。
