# claude-pi

类 Claude Code 架构的 TypeScript Agent 运行时（独立项目，见 ADR-0010）——pi 风格树形会话管理（含断线恢复）、pi-tui 终端界面与可扩展接口体系。

> ⚠️ **安全警示（请先读这条）**：本工具**不是沙箱**，它按你的本机权限运行。
> - **扩展**执行任意代码。项目扩展与自动启动的 MCP 需先执行 `cpi --trust-project-code`；项目代码或配置变更会使信任失效。用户目录扩展及显式 `-e` 路径视为用户授权。
> - **`run_bash` 是全信任通道**：只有极少数关键词（`rm `、`> /etc/`、`chmod 777`）和 7 条黑名单会触发确认，其余命令（含联网下载并执行、读取 `~/.ssh` 等）默认直接执行；黑名单是字符串匹配，属**减速带而非安全边界**。
> - 文件工具检查工作区路径；scout/reviewer 的 bash 只允许受控的直接 Git 查询。verifier 使用 Linux bubblewrap 隔离，禁止联网、保护源码，仅 `/tmp` 和 `.agent/verifier-output` 可写；不可隔离时拒绝执行。lead/worker 默认仍使用可信 shell。
> - `CLAUDE_PI_SANDBOX=readonly` 可将可信角色的 shell 切到同一受限模式。执行任意可信扩展仍拥有宿主进程权限。
> - 因此：**不要把来路不明的文件内容或 MCP 返回内容直接喂给 agent**（提示注入可驱动上述通道）。

## 特性

### 核心 Agent 引擎

- **ReAct Agent Loop**——注入 → 压缩 → 发送 → Hook → 执行工具的标准循环，单回合最多 100 轮工具调用
- **工具体系**——`run_bash` / `read_file` / `write_file` / `edit_file` / `glob` / `todo_write` / `load_skill`，外加任务看板、Subagent、Teammates、MCP 等内置工具
- **Hook 事件机制**——`UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` 等事件挂载点，用于拦截与扩展运行时行为
- **三级权限门控**——bash 黑名单（7 条字符串）→ 规则匹配（工作区外写入 / 三类危险命令 / 敏感文件）→ 按身份确认（lead 弹窗、subagent 同步冒泡、teammate 邮箱冒泡）。**命中才询问，未命中默认放行**，见顶部安全警示
- **错误恢复**——429/529 退避重试、`max_tokens` 升级与续写；错误、超时、中断和预算耗尽返回明确状态
- **上下文压缩**——L3 出口（超大工具结果落盘 + 预览引用）、L4 摘要（自动超阈值 / 手动 `/compact`，写 compaction entry，保留固定 20K 原文尾巴）；L1 Snip / L2 Micro 已移除（CC 无对应物，且就地改写会破坏缓存前缀）

### 树形会话

- **树形 JSONL 会话**——会话文件内以 entry 树组织，分支在原地进行，不创建新文件
- **fork / clone / resume**——从历史消息 fork 新会话、完整克隆会话、断线后从 leaf 恢复
- **断线恢复**——进程崩溃后重新打开会话文件并 resume，从上下文压缩检查点重建
- **多运行模式**——TTY 自动进入 TUI；`-p` 打印模式；`--mode json` 结构化输出（脚本/自动化接口）

### 多 Agent 协作（双模共存）

系统支持两种协同模式，可通过 `cpi --team-mode <free|pipeline>` 或 `/team-mode` 随时切换。
**默认为 `free`（原有行为）**；`pipeline` 是显式开启的预设，开启后由运行时**强制执行**角色委派（见下）。

- **自由组队模式 (Free Swarm)**：保留开放式多代理能力。通过 `create_team` / `spawn_teammate` 自由命名角色，独立异步 loop，文件邮箱通信与任务看板认领，危险操作向 Lead 冒泡审批。**空闲超过 30 分钟即视为结束**，该 teammate 的运行循环被回收（需要时重新 `spawn_teammate`）。
- **固定研发流水线预设 (Coding Pipeline Preset)**：专为代码编写任务打造的高确定性协同预设。由主 Agent（Lead）统一调度 5 个专职角色，各司其职，遵循标准 Markdown 交付契约与工具面白名单硬隔离：
  **开启后强制走角色委派（由运行时执行，不是提示词建议）**：Lead 自己的 `write_file` / `edit_file` /
  `run_bash` 会被直接拒绝，错误信息会引导它改用 `delegate(role="worker"|"verifier", ...)`，
  因此实现与验证只能由 `worker` / `verifier` 完成。只读工具（`read_file` / `grep` / `glob`）与
  `delegate` 不受影响。注意：呈现给模型的工具面**刻意保持不变**——fork 子 agent 复用父的工具面来复用
  prompt cache，若在呈现层收窄，`worker` 也会拿不到 `write_file`（所以「看见」与「能执行」是两层）。
  - **scout（侦察员）**：快速定位代码、梳理调用依赖，提取最小上下文包（纯只读，严禁写文件）。
  - **planner（规划师）**：制定原子化施工步骤与验收标准（纯只读，严禁写文件）。
  - **worker（实现员）**：按计划落地代码改动并生成变更报告（全工具面，允许修改）。
  - **reviewer（静态审查员）**：白盒静态审查代码规范、潜在 Bug 与安全漏洞（纯只读，输出 CR 意见与 PASS/BLOCK 裁决）。
  - **verifier（动态验证员）**：动态执行测试套件、构建与类型检查（受控 Bash 测试，严禁修改业务代码，输出客观测试报告）。
**Agent 可观测性（两种模式共用）**：

- **折叠面板**：每 spawn 一个子 agent，输入框上方出现一行状态（`⣾/✓/✗` + 角色 + 轮数 / 工具数 / 最近工具）；默认折叠，`Ctrl+A` 展开查看任务目标、最近输出、结果摘要与子会话文件名。
- **会话落盘**：每个子 agent 拥有独立子会话文件（血缘 `parentSession` 指向父会话），父会话同时写入 `subagent` / `subagent_end` 记录，`/tree` 会列出「子 agent 会话」清单，`/resume` 或 `cpi --session <id>` 可复查完整轨迹。
- **`/agents` 命令**：`/agents` 列出全部子 agent 运行状态；`/agents <id 前缀>` 查看详情（轮数、最近工具、子会话文件、结果或错误）。
- **前缀复用（Codex 式 fork）**：fork 子 agent 与父 agent 共用 **system 提示 + 工具面 + 完整历史前缀**，差异只发生在尾部一条 user 消息（`[Role Brief]` + `[Restrictions]` + `[Assigned Task]`）。因此 provider 端的 prompt cache 三段断点（tools / system / messages）都能命中父会话已缓存的前缀；角色限制写在尾部并由运行时执行闸强制，而不是靠改工具面（改工具面会让缓存全部失效）。面板与 `/agents` 会显示**首轮缓存 R/W**：`R>0` 即证明复用了父前缀。
- **一次性 fork 子 agent**：每次 `subagent_task` / `delegate` 都会 fork 当前会话（复制 system 提示、工具面与历史前缀），因此子 agent 与主 agent **共享 prompt cache 前缀**（成本显著低于全新会话）；子 agent 只做被指派的这一件事，返回结果后即结束，不驻留、不等待后续指派。常驻的多 agent 协同（邮箱 / 任务看板 / 空闲认领）只属于自由组队模式的 teammate。
- **teammate 同样在面板里**：自由组队的 teammate 是**持久 agent**（WORK → IDLE → … 直到收到 shutdown 或空闲超时），
  同样登记进折叠面板与 `/agents`，行尾标出 `执行中 / 空闲`；展开可见任务、用量、最近输出、交付物与**结束原因**。
  空闲超时结束后面板转为 `✓` 并保留该次运行记录（同名重新 spawn 会用 `名字@团队·2` 这类带后缀的 id，历史不丢）。
- **用量聚合**：每个子 agent 的 token / 成本从它的子会话 entry 现算（每回合与收尾各聚合一次）；teammate 不持有独立子会话，改由每回合的 `turnEnd` 事件累计（口径一致），展开面板与 `/agents <id>` 显示 `↑↓R W $`；`/agents` 末尾给出合计；**footer 的 `↑↓R W $` 已把子 agent 用量并入**（是整队的真实成本），`CH%` 与 `ctx%` 仍只反映主会话，footer 末尾的 `A<n> ▶<k>` 表示有 n 个子 agent、其中 k 个在跑。
- **后台任务**——`background: true` 的 bash 任务，结果以通知注入，带 stall 看门狗

### 记忆、任务与隔离

- **长期记忆**——Markdown 记忆文件，Stop Hook 异步提取。注入遵循**会话级冻结**：进入会话时把（MEMORY.md 索引 + 相关性检索出的正文）冻结成快照并放进 **system 段**，会话内恒定不变 —— 因此 system/消息前缀逐字节稳定，prompt cache 可复用；本会话内新抽取/更新的记忆照常落盘，但**只在下一个新会话生效**（新会话 = 新 sessionId = 新快照）。记忆相关性检索也随之从"每轮一次 LLM 调用"降为"每会话一次"。
- **`/memory-refresh`**——显式刷新当前会话的记忆快照：立即用最新记忆库重算并生效，**代价是开启新的 prompt 前缀**（此前缓存的 system/消息前缀从下一次请求起不再复用，首轮重新 cache write，之后按新前缀继续累积）。命令会明确提示这一点。
- **记忆开关**——`~/.claude-pi/settings.json` 的 `memory.enabled`（默认 `true`）；设为 `false` 后完全不注入记忆、也不做 Stop hook 提取（TUI 里可用 `/settings` 切换）。开关变更对新会话生效。
- **任务看板**——JSON 持久化任务列表，含依赖图与 claim/complete 生命周期
- **Git worktree 隔离**——认领任务时创建独立 worktree，操作局限其中，完成时自动清理
- **Skill**——`.agent/skills/` 下的 SKILL.md 按需加载注入系统提示

### 可扩展体系

- **扩展（Extension）**——TS 模块注册事件、工具、斜杠命令与 UI 交互；从三位置加载（`.agent/extensions/`、`~/.claude-pi/extensions/`、`-e`），支持 `/reload` 热重载
- **ctx.ui**——扩展可用的用户交互 API：confirm / select / input / notify / custom 组件，并可注册 entry 渲染器定制会话条目展示
- **appendEntry**——扩展向会话树追加自定义 entry，实现跨重启的状态持久化
- **MCP 集成**——标准 MCP client hub，工具以 `mcp__{server}__{tool}` 命名暴露；本地 server 将内置工具以 `mcp__local__{tool}` 呈现

### 模型与配置

- **独立配置**——LLM 传输层基于 `@earendil-works/pi-ai`；模型/凭据/设置走 cpi 独立全局目录 `~/.claude-pi/`（auth.json / models.json / settings.json，`PI_CODING_AGENT_DIR` 可覆盖），不再与 pi 共享；提供 `cpi --migrate-config` 从旧 `~/.pi/agent/` 一次性迁移
- **会话轨迹导出**——TUI `/export` 双模式：analysis（整树事件流 JSONL，含每步耗时/token/错误标记、大输出全文合并，存 `.agent/exports/`）/ portable（活动分支线性化 JSONL 供 `/import` 恢复，存 cwd）；`/import <path>` 恢复外部会话；`/settings` 配置导出模式/重试/压缩
- **运行时耗时补记**——每条 assistant/tool 消息随落盘记录真实执行耗时（durationMs）与失败标记（toolError），支撑轨迹分析与性能诊断
- **多 Provider**——openai / anthropic / gemini / deepseek 等，模型以 `provider/model` 标识，支持自定义模型（Ollama / vLLM / 代理）
- **数据根跟随项目**——在任意项目运行，`.agent/`（会话/团队/记忆/任务/Skill/worktree/扩展）自动落在该项目下，不写用户目录

## 安装与快速开始

要求 Node.js ≥ 22.18（原生运行 TS，无需构建）。

```bash
npm install
npm link              # 全局安装命令 cpi
cpi                   # 交互模式（TTY 自动进入 TUI；管道/非 TTY 走行式 REPL）
```

## 命令行

| 命令 | 说明 |
| --- | --- |
| `cpi` | 交互模式，默认继续最近会话 |
| `cpi -p` | 打印模式：`echo "任务" \| cpi -p` |
| `cpi --mode json` | 结构化输出（脚本/自动化接口） |
| `cpi -c` | 继续最近会话（默认行为） |
| `cpi --session <id>` | 恢复指定会话 |
| `cpi --fork <id>` | fork 会话到新文件 |
| `cpi --no-session` | 临时会话（不落盘） |
| cpi --refresh-models | 刷新远端模型目录（新模型/新价格；--force 跳过节流） |
| cpi --team-mode <mode> | 指定多代理协同模式（pipeline 研发预设 / ree 自由组队） |

TUI 内可用斜杠命令：`/tree`（会话树）、`/fork`、`/clone`、`/resume`、`/new`、`/name`、`/session`、`/export`（导出轨迹）、`/import`（导入会话）、`/compact`（手动压缩上下文）、`/settings`（设置）、`/team-mode`（切换协同模式）、`/agents`（子 agent 状态与子会话）、`/refresh-models`（刷新模型目录）、`/login`、`/logout`、`/model`、`/reload`（扩展热重载）等，可扩展注册。

## 模型目录自动更新

模型表来自 pi-coding-agent 的远端目录（`https://pi.dev/api/models/providers/<provider>`），按 `id` 合并到内置目录之上：**新模型追加、同名模型替换元数据**（价格/上下文窗口/thinking 映射等），结果持久化到 `~/.claude-pi/models-store.json`。

- **自动**：TUI 与交互式 REPL 启动后会后台刷新一次（不阻塞启动、失败静默）；provider 侧 4 小时节流，窗口内不发请求。
- **手动**：`/refresh-models`（TUI）或 `cpi --refresh-models`（脚本；`--force` 跳过节流）。命令输出走 stderr，不污染 `-p` / `--mode json` 的 stdout。
- **离线**：`PI_OFFLINE=1` 关闭一切模型目录网络操作，只应用本地已缓存的 overlay。
- 刷新一次后，即使离线启动也能解析到这些模型（启动只读本地缓存）。

在 `models.json` 里手工声明模型会**整体替换**该模型的元数据（未写字段退回默认值，如 128k 上下文窗口、零成本）。因此建议只声明目录里没有的模型，并在声明时写全 `contextWindow` / `cost` / `compat` 等字段。

## 模型配置

优先使用 cpi 独立全局配置（`PI_CODING_AGENT_DIR` 可覆盖 `~/.claude-pi/`）：

- `auth.json` — `/login` 保存的 API key / OAuth 凭据
- `models.json` — 自定义 provider/模型（Ollama / vLLM / 代理等）
- `settings.json` — retry 设置、defaultModel、enabledModels、compaction

首次使用旧版 pi 配置（`~/.pi/agent/`）时，可运行 `cpi --migrate-config` 一次性复制到新目录。

也可直接用各 provider 的标准环境变量（如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`），或项目内 `.env` 文件。传输错误按 retry 设置自动重试。

## 项目结构

```
src/
├── cli.ts               # 入口与运行模式分发
├── agent-loop.ts        # ReAct 主循环
├── tool.ts              # 内置工具注册表与 Schema 校验
├── hook.ts              # Hook 事件机制
├── permission.ts        # 三级权限门控
├── compact.ts           # 上下文压缩（L3 出口 / L4 摘要，自动 + 手动）
├── error-recovery.ts    # 重试/fallback/续写
├── session-manager.ts   # 树形 JSONL 会话与 fork/clone/resume
├── session-export.ts    # 会话导出（analysis 整树 trace / portable 分支）
├── session-import.ts    # 会话导入（/import，复制到会话目录）
├── project-config.ts    # 项目级配置（.agent/config.json，导出模式）
├── memory.ts            # Markdown 长期记忆
├── tasks.ts             # 任务看板
├── worktree.ts          # Git worktree 隔离
├── background-task.ts   # 后台任务与 stall 看门狗
├── teammates/           # 队友孵化、邮箱、权限冒泡、Subagent 委派
├── tui/                 # pi-tui 终端界面（滚动区/弹窗/斜杠命令）
├── extensions/          # 扩展加载器与 ctx.ui API
└── mcp/                 # MCP hub 与本地 server
```

## 扩展开发

扩展是 TS 模块，通过 `registerExtension` 注册事件监听、工具、命令与 UI 交互：

```bash
# 全局扩展目录
mkdir -p ~/.claude-pi/extensions
```

参考示例：[examples/extensions/permission-gate.ts](./examples/extensions/permission-gate.ts)。修改后执行 `/reload` 即可热重载。

## 文档

- [CONTEXT.md](./CONTEXT.md) — 术语表（领域语言）
- [docs/adr/](./docs/adr/) — 架构决策记录

## 本地开发

```bash
npm install            # 安装依赖
npm run dev            # tsx 开发运行
npm run typecheck      # tsc --noEmit 类型检查
npm test               # vitest 全量测试
```

运行时数据（会话/团队/记忆/任务/Skill/worktree/扩展）存于项目内 `.agent/`（gitignored）。

## 可靠性改进与验证

详见 [运行说明与验收证据](docs/reliability-validation.md)。主要入口：

```sh
cpi --doctor                 # 离线诊断配置、依赖、预算和沙箱能力
cpi --doctor --check-api     # 查询提供商模型目录，不打印凭据
npm run check                # 类型检查与全部测试
npm run eval:reliability     # 三次独立故障回归，保留全部结果
npm run test:pack            # tarball + 仅生产依赖安装 + CLI HTTP 往返
```

`--mode json` 保留 `turns/final`，新增 `status/error/budget`；成功退出 0、失败或超时退出 1、预算耗尽退出 2、取消退出 130。`status=success` 表示 agent 正常完成，业务正确性仍需独立验收。验证测试使用 `run_verification`，按原始程序退码报告，禁止以 `; echo` 或 `|| true` 掩盖失败。

文件工具支持预期 SHA-256、唯一上下文匹配、原子写入和检查点；`apply_patch` 先验证多个文件，再应用。`restore_checkpoint` 不覆盖修改之后的用户改动。`complete_task` 保存产物后可能返回 `ready_for_review`；审查后用 `integrate_task` 检查主工作区冲突并整合，再解除依赖。未提交或未合并的 worktree/分支会保留，不自动强制删除。
