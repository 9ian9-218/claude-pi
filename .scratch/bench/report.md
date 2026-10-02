# claude-pi 权威基准评测报告

生成时间：2026-09-18T16:00:33.788Z　·　被测模型：`opencode-go/deepseek-v4.1-flash`（thinking=max）

三个基准的任务定义均逐字取自官方来源，测试全部跑**官方口径**的验证。

## 1. 方法与可信度

| 环节 | 做法 |
| --- | --- |
| 执行环境 | 每个任务一个独立容器：容器内既跑 claude-pi，也跑被测仓库自带的测试（与 SWE-bench / Terminal-Bench 的「同 env 改代码 + 验代码」语义一致） |
| 题面 | SWE-bench 用官方 `problem_statement`；Polyglot 用 Exercism 官方 `.docs/instructions.md`；TB2 用官方 `instruction.md` |
| 评测 | SWE-bench：官方 FAIL_TO_PASS / PASS_TO_PASS，按 junit 归一化 id 比对；Polyglot：原生测试套件；TB2：官方 `/tests/test.sh` 写入的 `reward.txt` |
| **金标对照** | 每个 SWE-bench 实例先用官方 gold patch 走一遍：基线清洁 → gold 可应用 → test patch 可应用 → F2P 全绿。**这一步把「环境失败」与「harness 失败」分开** |
| 插桩 | `NODE_OPTIONS=--require` 注入，只读观测、不改被测代码：① 出站请求 payload 的逐条消息哈希 ② shell 命令的真实退出码 |

## 2. 正确性结果

### 2.1 SWE-bench Verified（真实 GitHub issue + 官方金标测试）

| 实例                       | 难度              | F2P | P2P             | 工具调用 | 缓存命中% | 结论             |
|--------------------------|-----------------|-----|-----------------|------|-------|----------------|
| pallets__flask-5014      | <15 min fix     | 1/1 | 59/59           | 15   | 89.76 | **RESOLVED**   |
| psf__requests-5414       | <15 min fix     | 1/1 | 128/128         | 24   | 92.24 | **RESOLVED**   |
| psf__requests-6028       | 15 min - 1 hour | 0/2 | -               | 26   | 92.33 | 未修复（F2P 未过）    |
| pylint-dev__pylint-4970  | <15 min fix     | 0/1 | -               | 40   | 96.09 | 未修复（F2P 未过）    |
| pylint-dev__pylint-7277  | <15 min fix     | 1/1 | 108/109（匹配 108） | 24   | 93.54 | 无回归（P2P 有未匹配项） |
| pytest-dev__pytest-10081 | <15 min fix     | 1/1 | 60/60           | 47   | 96.96 | **RESOLVED**   |
| pytest-dev__pytest-10356 | 1-4 hours       | 1/1 | 65/65           | 77   | 98.01 | **RESOLVED**   |
| sympy__sympy-15875       | <15 min fix     | 1/1 | 80/80           | 65   | 97.94 | **RESOLVED**   |
| sympy__sympy-21847       | <15 min fix     | 1/1 | 9/9             | 14   | 90.85 | **RESOLVED**   |

**resolved：6/9**（严格口径，含官方列表里的未匹配项）

无 P2P 回归口径：**7/9** —— 差额来自官方 P2P 列表里在该 commit 根本不存在的陈旧 id：
- `pylint-dev__pylint-7277`：`tests/test_self.py::TestRunTC::test_stdin[/mymodule.py]`

### 2.2 Aider Polyglot（Exercism 官方题面 + 原生测试，python 子集）

| 题目            | 工具调用 | 请求数 | 缓存命中% | 结论 |
|---------------|------|-----|-------|----|
| grade-school  | 6    | 6   | 78.47 | 通过 |
| phone-number  | 8    | 5   | 76.52 | 通过 |
| pig-latin     | 6    | 6   | 81.41 | 通过 |
| proverb       | 6    | 6   | 80.60 | 通过 |
| transpose     | 15   | 15  | 92.02 | 通过 |
| tree-building | 8    | 6   | 80.52 | 通过 |
| two-bucket    | 8    | 6   | 80.62 | 通过 |
| wordy         | 11   | 10  | 89.03 | 通过 |

**通过：8/8**

### 2.3 Terminal-Bench 2.0（官方任务镜像 + 官方 verifier）

| 任务                       | reward | verifier 路径      | 工具调用 | 请求数 | 缓存命中% | 结论  |
|--------------------------|--------|------------------|------|-----|-------|-----|
| fix-git                  | 1      | 直接 pytest（引导不可用） | 9    | 10  | 88.20 | 通过  |
| sanitize-git-repo        | 1      | 直接 pytest（引导不可用） | 41   | 38  | 95.75 | 通过  |
| log-summary-date-ranges  | 1      | 直接 pytest（引导不可用） | 4    | 5   | 77.23 | 通过  |
| large-scale-text-editing | 0      | 直接 pytest（引导不可用） | 100  | 100 | 98.84 | 未通过 |
| regex-log                | 1      | 直接 pytest（引导不可用） | 63   | 64  | 98.12 | 通过  |
| git-leak-recovery        | 1      | 直接 pytest（引导不可用） | 23   | 20  | 93.14 | 通过  |

> 注：6/6 个任务的官方 `test.sh` 引导步骤（`apt-get update` + 从 astral.sh 装 uv）在本网络下不可用（deb.debian.org 不可达），已回退为**用同一份官方测试文件 `/tests/test_outputs.py` 直接跑 pytest**。判定口径一致（test.sh 本体就是 pytest 退码 0 → reward 1），差别只在工具是预装而非临时下载。


**通过：5/6**

## 3. 执行轨迹分析

指标由完整会话重建（含每次工具调用的参数与结果、真实退出码）：

- **冗余调用**：完全相同的 (工具, 参数) 再次出现
- **盲改**：改动一个既没读过、也不是自己新建的文件
- **验证闭环**：`verify=次数✓/✗` 中的 ✗ 表示最后一次编辑之后没有再跑过验证命令
  （该判定按「测试运行器」识别 —— pytest / npm test / make / cargo test 等；
   TB2 的若干任务是用 `diff`、`sha256sum`、人工比对来验证的，会被计入 0，属指标口径限制而非行为问题）
- **退出码不可见**：shell 非零退出，但模型看到的文本里没有任何失败迹象

| 任务                           | 工具调用 | shell | 冗余 | 盲改 | 验证  | 退出码不可见 | 终止方式                     |
|------------------------------|------|-------|----|----|-----|--------|--------------------------|
| pallets__flask-5014          | 15   | 5     | 0  | 0  | 3✓  | 0/0    | final_text               |
| poly-python-grade-school     | 6    | 3     | 0  | 0  | 2✓  | 0/0    | final_text               |
| poly-python-phone-number     | 8    | 4     | 0  | 0  | 2✓  | 0/0    | final_text               |
| poly-python-pig-latin        | 6    | 3     | 0  | 0  | 2✓  | 0/0    | final_text               |
| poly-python-proverb          | 6    | 3     | 0  | 0  | 2✓  | 0/0    | final_text               |
| poly-python-transpose        | 15   | 8     | 3  | 0  | 6✓  | 0/0    | final_text               |
| poly-python-tree-building    | 8    | 3     | 0  | 0  | 2✓  | 0/0    | final_text               |
| poly-python-two-bucket       | 8    | 3     | 0  | 0  | 2✓  | 0/0    | final_text               |
| poly-python-wordy            | 11   | 5     | 1  | 0  | 4✓  | 0/0    | final_text               |
| psf__requests-5414           | 24   | 10    | 1  | 0  | 2✓  | 0/0    | final_text               |
| psf__requests-6028           | 26   | 10    | 0  | 0  | 3✓  | 0/1    | final_text               |
| pylint-dev__pylint-4970      | 40   | 18    | 0  | 0  | 3✓  | 1/2    | final_text               |
| pylint-dev__pylint-7277      | 24   | 10    | 0  | 1  | 4✓  | 0/1    | final_text               |
| pytest-dev__pytest-10081     | 47   | 33    | 1  | 2  | 13✓ | 0/2    | final_text               |
| pytest-dev__pytest-10356     | 77   | 48    | 0  | 5  | 28✓ | 0/4    | final_text               |
| sympy__sympy-15875           | 65   | 35    | 0  | 3  | 11✓ | 1/4    | final_text               |
| sympy__sympy-21847           | 14   | 8     | 0  | 0  | 3✓  | 0/1    | final_text               |
| tb2-fix-git                  | 9    | 8     | 0  | 1  | 0✗  | 0/2    | final_text               |
| tb2-git-leak-recovery        | 23   | 10    | 1  | 1  | 0✗  | 0/0    | final_text               |
| tb2-large-scale-text-editing | 100  | 79    | 2  | 3  | 0✗  | 1/5    | tool_calls_without_final |
| tb2-log-summary-date-ranges  | 4    | 4     | 0  | 0  | 0✗  | 0/0    | final_text               |
| tb2-regex-log                | 63   | 53    | 5  | 2  | 1✓  | 1/5    | final_text               |
| tb2-sanitize-git-repo        | 41   | 27    | 0  | 2  | 0✗  | 0/1    | final_text               |

合计：工具调用 640，shell 390，冗余 14，盲改 20，末次编辑后验证 18/23。

## 4. 缓存复用分析

判据来自**线上真实 payload**（不是推断）：对每次出站请求，逐条哈希消息、并计算与上一请求的公共前缀。

| 任务                           | 请求数 | system 哈希 | tools 哈希 | 历史改写 | 前缀覆盖率  | 命中率%  | 未解释未命中 |
|------------------------------|-----|-----------|----------|------|--------|-------|--------|
| pallets__flask-5014          | 12  | 稳定        | 稳定       | 0    | 1.0102 | 89.76 | 0      |
| poly-python-grade-school     | 6   | 稳定        | 稳定       | 0    | 1.0061 | 78.47 | 0      |
| poly-python-phone-number     | 5   | 稳定        | 稳定       | 0    | 1.0208 | 76.52 | 0      |
| poly-python-pig-latin        | 6   | 稳定        | 稳定       | 0    | 1.0077 | 81.41 | 0      |
| poly-python-proverb          | 6   | 稳定        | 稳定       | 0    | 0.9970 | 80.60 | 0      |
| poly-python-transpose        | 15  | 稳定        | 稳定       | 0    | 1.0122 | 92.02 | 0      |
| poly-python-tree-building    | 6   | 稳定        | 稳定       | 0    | 1.0203 | 80.52 | 0      |
| poly-python-two-bucket       | 6   | 稳定        | 稳定       | 0    | 1.0246 | 80.62 | 0      |
| poly-python-wordy            | 10  | 稳定        | 稳定       | 0    | 1.0171 | 89.03 | 0      |
| psf__requests-5414           | 16  | 稳定        | 稳定       | 0    | 1.0134 | 92.24 | 0      |
| psf__requests-6028           | 17  | 稳定        | 稳定       | 0    | 1.0131 | 92.33 | 0      |
| pylint-dev__pylint-4970      | 37  | 稳定        | 稳定       | 0    | 1.0054 | 96.09 | 0      |
| pylint-dev__pylint-7277      | 20  | 稳定        | 稳定       | 0    | 1.0056 | 93.54 | 0      |
| pytest-dev__pytest-10081     | 43  | 稳定        | 稳定       | 0    | 1.0038 | 96.96 | 0      |
| pytest-dev__pytest-10356     | 70  | 稳定        | 稳定       | 0    | 1.0044 | 98.01 | 0      |
| sympy__sympy-15875           | 60  | 稳定        | 稳定       | 0    | 1.0083 | 97.94 | 0      |
| sympy__sympy-21847           | 15  | 稳定        | 稳定       | 0    | 1.0064 | 90.85 | 0      |
| tb2-fix-git                  | 10  | 稳定        | 稳定       | 0    | 1.0112 | 88.20 | 0      |
| tb2-git-leak-recovery        | 20  | 稳定        | 稳定       | 0    | 0.9984 | 93.14 | 0      |
| tb2-large-scale-text-editing | 100 | 稳定        | 稳定       | 0    | 1.0088 | 98.84 | 0      |
| tb2-log-summary-date-ranges  | 5   | 稳定        | 稳定       | 0    | 1.0242 | 77.23 | 0      |
| tb2-regex-log                | 64  | 稳定        | 稳定       | 0    | 1.0106 | 98.12 | 0      |
| tb2-sanitize-git-repo        | 38  | 稳定        | 稳定       | 0    | 1.0068 | 95.75 | 0      |

总体命中率 **96.60%**（cacheRead 8985984 / prompt 9302026）。

结构层面：system 提示词哈希 **23/23** 全程不变，工具 schema 哈希 **23/23** 全程不变，历史被改写 **0** 次，未解释的未命中 **0** 次。

前缀覆盖率 = 本次 `cacheRead` ÷ 上一次请求的 prompt 总 token。append-only 且缓存有效时应≈1.0；低于 1 说明「上一轮的全部内容没有被完整复用」，那才是缓存被破坏。

## 5. 发现的缺陷与风险

本节只列跑测能直接举证的缺陷。**完整的缺陷清单（含确定性复现脚本、逐条代码定位与修复建议）见同目录的 [problems.md](problems.md)**，
其中高危三项：`claim_task` 的 worktree 会静默吞掉改动、工具异常不隔离会中止整个 run、100 轮上限静默截断。

### 5.1 工具异常没有隔离：一次工具报错会中止整个 run（高严重度，本轮实测复现）

`tb2-sanitize-git-repo` 这一轮里，claude-pi 的 `--mode json` **stdout 是 0 字节**，stderr 末尾是：

```
[unhandledRejection] Error: Task task_3 is pending, cannot complete
    at .../src/tasks.ts:401
    at .../src/tools/tasks-board.ts:42   (Tool.execCompleteTask)
    at .../src/agent-loop.ts:234        (executeToolCall)
```

链条是三处叠加：

1. `src/tasks.ts:401` 对状态不合法的调用**抛异常**（而不是返回错误串）；
2. `src/tools/tasks-board.ts` 的 `execCompleteTask` **没有 try/catch** —— 对比 `src/tools/file.ts` 的
   `execEditFile` 是包住的，失败时返回 `Error: text not found` 这样的字符串；
3. `src/agent-loop.ts:234` 的 `toolResult = await executeToolCall(...)` **没有单次调用级的错误隔离**。

于是同类错误出现两种行为：`edit_file` 出错 → 模型看到错误串、可以自己纠正；
`complete_task` 出错 → 整个 run 被中止，调用方拿到的是**空 stdout**。

当前数据集共 23 个任务，其中 **0** 个因工具异常中止、stdout 为空。
需要说明：复现发生在 `tb2-sanitize-git-repo` 的首轮运行（该轮 stdout 0 字节、退出码 1），
重跑该任务不再复现（80 轮正常完成、reward=1）——触发条件是「对未 claim 的任务调用 complete_task」这一具体路径，
所以它是**条件触发**而非必现。全量 29 次任务运行里发生 1 次。
后果：`--mode json` 的输出契约被破坏（本应给出可解析 JSON，实际给空 stdout），
调用方无法区分「无输出」与「崩溃」。会话数据逐条落盘，可用 `cpi --session <id>` 恢复——属「可恢复但契约破坏」。
另一处相关行为见下方 5.5。

### 5.2 `run_bash` 丢弃命令退出码（代码级缺陷，本轮未造成实际损失）

`src/tools/bash.ts` 的 `execRunBash` 只回传 `stdout+stderr`，`spawnSync` 的 `r.status` 被丢掉。
受控实验（不经过模型）：执行 `false` —— 退出码 1、零输出，模型看到的就是 `(no output)`，
与成功的静默命令（`cd`、`mkdir` 之类）在模型眼里**完全同形**。

实测影响面：本轮共 390 次 shell 调用，非零退出 28 次；其中「非零退出**且零输出**」——与成功静默命令完全同形、真正会误导模型的——是 **2** 次，实测为：

- `pylint-dev__pylint-4970`：`cd /testbed && python3 -m pylint --help 2>&1 | grep -i -A3 "similarity"` → 退出码 1，模型看到 `(no output)`
- `sympy__sympy-15875`：`cd /testbed && python3 -c "` → 退出码 1，模型看到 `(no output)`

两次都是「探测类」命令（grep 无匹配、内省脚本无输出），所以本轮没有造成误判；但机制上，模型无法区分「命令失败」与「命令成功但没有输出」。
结论：缺陷真实存在，且本轮确有 2 次实际发生；但都落在探测类命令上，没有影响任务结果。
风险在于**未暴露**的那类：`git apply` 失败无输出、`make` 静默退出非零、构建脚本吞掉错误——
一旦出现，模型会把失败当成功继续，而轨迹上完全看不出来。加一个退出码后缀（非零时显式标注）成本极低。

### 5.3 会话数据写在被测项目的 `cwd/.agent/` 下

`src/session-manager.ts` 明确把会话存到 `.agent/sessions/--<cwd路径>--/<时间戳>_<uuid>.jsonl`。
这是设计选择（仓库自己的 `.gitignore` 也把 `.agent/` 注释为「项目本地运行数据」），但副作用是：
在任意仓库里跑一次 agent，就会在那个仓库里留下 `.agent/` 目录。评测时必须把它排除在候选补丁之外
（本评测用 `.git/info/exclude` 屏蔽，不改仓库受版本控制的文件）。

### 5.4 `run_bash` 没有路径约束（设计属性，非缺陷）

`safePath`/`checkPath` 只作用于 `read_file`/`write_file`/`edit_file`；
`run_bash` 直接 `spawnSync(command, { cwd: getWorkdir(), shell: true })`。
因此「工作区隔离」对 shell 不成立 —— 它是完整 shell，能写到进程有权限的任何位置。
这不是 bug（shell 工具本就如此），但**不能把它当作安全边界**来依赖。

### 5.5 本轮不予采信的两个观察

早先一次跑测中出现过「轨迹里出现两条内容完全相同的 user 消息」与「最早的若干次请求未进线上日志」。
这两点在随后 18 个任务的干净重跑中**一次都没有复现**，且当时那轮跑测确实处于容器/工作区被污染的状态
（运行期还打印过「会话文件正被其他进程使用」）。因此按未证实处理，不计入结论。

## 6. 如何复现

```bash
# 基建（脚本在仓库内，跑测产物在 $HOME/cpi-bench）
node .scratch/bench/prepare.mjs swebench|polyglot|terminalbench
node .scratch/bench/validate.mjs          # 金标对照：先证明评测环境正确
node .scratch/bench/run.mjs --bench=swebench --concurrency=3
node .scratch/bench/reeval.mjs            # 只重放评测，不重跑 agent
node .scratch/bench/analyze.mjs           # 轨迹 + 缓存分析
node .scratch/bench/report.mjs            # 生成本报告
```

