# claude-pi

claude-pi 是一个类 Claude Code 架构的 TypeScript Agent 运行时：移植自 Python 版 Claude-Code-simple（保留其全部机制），并引入 pi 风格的树形会话管理、显式运行模式、pi-tui 终端界面与可扩展接口体系。

## 会话与恢复

**会话 (Session)**:
一次可持久化的 Agent 对话，存储为 `.agent/sessions/` 下的 JSONL 文件，文件内以 entry 树组织。
_Avoid_: 聊天记录、对话历史、messages

**会话树 (Session Tree)**:
会话文件内由 entry 通过 `parentId` 链接构成的树形结构；分支在原地进行，不创建新文件。
_Avoid_: 会话列表

**Entry**:
会话树的基本节点，带 `id` / `parentId` / `timestamp` 的记录；类型包括 message、compaction、branch_summary、model_change、session_info、label、custom。
_Avoid_: 行、消息

**Leaf**:
会话树当前所处位置（最新 entry）；上下文构建从 leaf 回溯到根。
_Avoid_: 当前指针

**分支 (Branch)**:
在历史 entry 上继续产生新 entry，形成分叉路径。
_Avoid_: 新会话

**Fork**:
从历史 user message 创建新会话文件的操作，复制该点之前的活动路径，选中消息可修改后作为新会话起点。

**Clone**:
把当前活动分支完整复制到新会话文件的操作，保留全部历史。

**Resume**:
重新打开已有会话文件并从其 leaf 继续。
_Avoid_: 续聊、继续会话（resume 特指文件级操作）

**Compaction Entry**:
上下文压缩产生的树内记录，含摘要与 retainedTail 检查点，压缩后上下文可从该点重建。
_Avoid_: 压缩标记

**Branch Summary**:
切换分支时对放弃路径生成的 LLM 摘要记录（branch_summary entry）。

**断线恢复 (Crash Recovery)**:
进程崩溃后通过 reopen 会话文件 + resume 从 leaf 重建上下文的恢复能力；mid-turn 未完成回合不落盘。
_Avoid_: 自动续写

## 多 Agent

**Lead**:
默认团队负责人 agent，唯一拥有用户交互与权限审批权的角色。

**Teammate**:
由 Lead 孵化的工作 agent，在独立异步 loop 中运行，通过邮箱通信，工具集受限。
_Avoid_: worker、子代理（Subagent 是另一机制）

**Subagent**:
进程内一次性子 Agent，用于委派单个任务，结束后返回结果。

**邮箱 (Mailbox)**:
Teammate 之间基于 JSON 数组文件的消息通道，写操作用文件锁保护。
_Avoid_: 队列、消息总线

**队友注入 (Inbox Injection)**:
Lead 轮询邮箱后把队友消息作为 user turn 注入上下文。

**权限请求 (Permission Request)**:
Teammate 对危险操作向 Lead 发起的审批请求；Lead 主线程消费并响应。
_Avoid_: 审批、授权（权限请求是具体机制名）

## 运行时机制

**Agent Loop**:
ReAct 主循环：注入 → 压缩 → 发送 → Hook → 执行工具 → 循环，最多 100 回合。
_Avoid_: 主循环

**回合 (Turn)**:
用户输入后到模型停止（或工具调用结束）的一次完整处理周期。

**Hook**:
事件驱动的扩展挂载点（UserPromptSubmit / PreToolUse / PostToolUse / Stop 等）。
_Avoid_: 回调、事件（Hook 是项目机制名）

**权限门控 (Permission Gate)**:
三级权限检查：黑名单 → 规则 → 用户确认。
_Avoid_: 权限系统

**上下文压缩 (Context Compaction)**:
四层压缩机制：L3 Budget（超大结果落盘预览）、L1 Snip（裁剪中间消息）、L2 Micro（旧结果占位）、L4 Auto Compact（LLM 摘要，写 compaction entry）。
_Avoid_: 摘要

**后台任务 (Background Task)**:
`background: true` 的 bash 任务，结果以 task_notification 注入；带 stall 看门狗。
_Avoid_: 异步任务

**Stall 看门狗 (Stall Watchdog)**:
检测后台任务输出停滞或等待键盘输入的模式，超时后通知。

**Worktree 隔离 (Worktree Isolation)**:
claim 任务时创建 git worktree（分支 `agent/task-<id>`），所有操作局限其中；complete 时清理。
_Avoid_: 沙箱、隔离环境

**记忆 (Memory)**:
Markdown 长期记忆文件，Stop Hook 异步提取，按相关性注入上下文。
_Avoid_: 知识库

**任务看板 (Task Board)**:
JSON 持久化的任务列表，含依赖图与 claim/complete 生命周期。
_Avoid_: 待办、todo

**Skill**:
`.agent/skills/` 下的 SKILL.md 定义，按需加载注入系统提示。
_Avoid_: 插件（插件是扩展）

**Fallback 模型**:
429/529 连续失败后切换的备用模型。

## 交互面

**运行模式 (Run Mode)**:
显式选择的运行方式：交互 TUI（默认）、`-p` 打印、`--mode json` 结构化输出；无自动回退。
_Avoid_: 非交互模式

**斜杠命令 (Slash Command)**:
TUI 中以 `/` 开头的命令（/tree、/fork、/clone、/new、/resume、/name、/session 等），可扩展注册。
_Avoid_: 指令

**扩展 (Extension)**:
TS 模块，通过注册事件监听、工具、命令、UI 交互扩展 claude-pi；从三位置加载（`.agent/extensions/`、`~/.claude-pi/extensions/`、`-e`），支持 `/reload` 热重载。
_Avoid_: 插件、hook（hook 是内置事件机制，扩展是其开放形式）

**ctx.ui**:
扩展可用的用户交互 API（confirm / select / input / notify / custom 组件）。
_Avoid_: UI 接口

**appendEntry**:
扩展向会话树追加自定义 entry（custom）以实现跨重启状态持久化。

## 数据与测试

**.agent/ 数据根 (.agent Data Root)**:
项目内运行时数据目录（teams / memory / tasks / skills / worktrees / sessions / extensions），不写用户目录。
_Avoid_: .claude（旧名）；例外：扩展的全局位置是 `~/.claude-pi/extensions/`

**对拍测试 (Parity Test)**:
同一场景脚本分别驱动 Python 版与 claude-pi（`--mode json`），比对输出以验证行为等价。
_Avoid_: 对照测试、回归测试（对拍特指跨实现比对）
