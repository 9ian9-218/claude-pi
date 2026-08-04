# claude-pi 实施计划

移植自 Python 版 Claude-Code-simple（`/home/z9ian9/myproject/Claude-Code-simple`，保留为参照实现），叠加三项增强：树形会话管理（含断线恢复）、pi-tui 终端界面、扩展体系。所有决策见 `CONTEXT.md`（术语表）与 `docs/adr/`（6 项 ADR）。

## 技术栈

Node.js 22 LTS · TypeScript（tsx 开发 / tsc 构建）· npm · vitest · `@earendil-works/pi-tui`（锁版本）· openai npm SDK · proper-lockfile · jiti（扩展加载）

## 目录结构（草案）

```
claude-pi/
├── src/
│   ├── config.ts            # ← config.py（env、.agent/ 路径、workdir 覆盖）
│   ├── client.ts            # ← client.py（openai SDK、流式）
│   ├── hook.ts              # ← hook.py（事件注册表，事件集扩到 pi 全集）
│   ├── tool.ts              # ← tool.py（15+ 工具，动态注册表）
│   ├── prompt.ts            # ← prompt.py
│   ├── agent-loop.ts        # ← agent_loop.py（async）
│   ├── error-recovery.ts    # ← error_recovery.py
│   ├── compact.ts           # ← compact.py（L1-L4，L4 写 compaction entry）
│   ├── memory.ts            # ← memory.py
│   ├── tasks.ts             # ← tasks.py
│   ├── worktree.ts          # ← worktree.py（分支 agent/task-<id>）
│   ├── background-task.ts   # ← background_task.py
│   ├── message-queue.ts     # ← messageQueueManager.py
│   ├── skill-load.ts        # ← skill_load.py
│   ├── permission.ts        # ← check_permissions.py + permission_sync.py
│   ├── session-manager.ts   # 新增：树形会话（参考 pi MIT 源码）
│   ├── output-queue.ts      # 新增：串行化输出（等价 console_lock）
│   ├── extensions/
│   │   ├── loader.ts        # 新增：jiti 加载三位置扩展
│   │   ├── api.ts           # 新增：ExtensionAPI（on/registerTool/registerCommand/appendEntry）
│   │   └── ui.ts            # 新增：ctx.ui（confirm/select/input/notify/custom）
│   ├── teammates/
│   │   ├── context.ts       # ← context.py（AsyncLocalStorage）
│   │   ├── mailbox.ts       # ← mailbox.py（proper-lockfile）
│   │   ├── poller.ts        # ← poller.py（setInterval）
│   │   ├── spawn.ts         # ← spawn.py（异步 loop）
│   │   ├── lifecycle.ts     # ← lifecycle.py
│   │   ├── message-types.ts # ← message_types.py
│   │   ├── protocol.ts      # ← protocol.py
│   │   ├── autonomous.ts    # ← autonomous.py
│   │   └── team-helpers.ts  # ← team_helpers.py
│   └── tui/
│       ├── app.ts           # 新增：TUI host（pi-tui 主循环、overlay）
│       ├── scrollback.ts    # 新增：Markdown 渲染滚动区
│       ├── status-bar.ts    # 新增：模型/Token/工作目录/状态行
│       ├── permission-dialog.ts  # 新增：权限弹窗
│       └── commands.ts      # 新增：斜杠命令注册表
├── cli.ts                   # 入口：模式分派（TUI / -p / --mode json）
├── tests/                   # vitest（每模块一个 spec）+ 对拍脚本
└── .agent/                  # 运行时数据（sessions/teams/memory/tasks/skills/worktrees/extensions）
```

## 阶段计划

### Phase 0 — 仓库骨架
package.json / tsconfig / vitest / tsx / .gitignore / README / .env.example。`npm init` 起步，pi-tui 锁版本（`@earendil-works/pi-tui@0.83.0`）。

### Phase 1 — 核心机制移植（对照 Python 逐模块）
顺序：config → client → hook → tool → prompt → agent-loop → error-recovery → compact → memory → background-task → tasks → worktree → skill-load → message-queue → output-queue。
**每模块交付即带 vitest 移植测试**（Python 版 `tests/run_tests.py` 用例逐条移植）。
注意点：`input()` → TUI 前先用占位 REPL（Phase 4 替换）；threading → async/AsyncLocalStorage；fcntl → proper-lockfile；`get_workdir()` → AsyncLocalStorage 读取。

### Phase 2 — 多 Agent（teammates + 权限同步）
context / mailbox / poller / spawn / lifecycle / message-types / protocol / autonomous / team-helpers / permission。
**验收**：Lead + 2 个 Teammate 全流程（孵化 → 邮件 → 权限请求 → 结果回传 → idle 轮询）脚本测试通过。

### Phase 3 — 会话机制（树形会话 + 断线恢复）
自实现 session-manager.ts：JSONL 追加、树索引、`branch()`/`branchWithSummary()`/`resetLeaf()`、fork/clone（createBranchedSession）、buildContextEntries/buildSessionContext、compaction entry（retainedTail）、branch_summary。
CLI：`-c`（继续最近）、`-r`（浏览选择）、`--session <id>`、`--fork <id>`、`--no-session`（临时）。
压缩联动：L4 Auto Compact 写 compaction entry；L1/L2/L3 保持发送前视图变换不落盘。
**验收**：树操作单测全绿（分支/切回/fork/clone/压缩检查点/上下文重建）+ 断线恢复演练（模拟崩溃 → resume → 上下文一致）。

### Phase 4 — TUI + 运行模式
cli.ts 模式分派：默认交互 TUI / `-p` / `--mode json`。pi-tui 布局（档位 2）：Markdown 滚动区、底部输入（IME 支持）、状态行（模型/Token/工作目录/worktree 指示器）、权限弹窗、agent 配色（队友消息）、后台任务通知、`/` 命令补全。
斜杠命令：/new、/tree、/fork、/clone、/resume、/name、/session、/help、/reload（Phase 5 启用）。
`-p`：管道 stdin 合并进首轮提示，输出后退出；`--mode json`：结构化输出（对拍接口）。
**验收**：TUI 走查清单全过（见下）+ 组件渲染断言测试。

### Phase 5 — 扩展体系
loader.ts（jiti 加载三位置：`.agent/extensions/`、`~/.claude-pi/extensions/`、`-e`）、ExtensionAPI：事件全集（session_start/end、session_before_switch/shutdown、session_before_fork、session_before_compact/session_compact、session_before_tree/session_tree、user_prompt_submit、pre/post_tool_use、stop、model 事件）、registerTool、registerCommand、ctx.ui（confirm/select/input/notify/custom）、appendEntry、自定义渲染器、`/reload` 热重载。
**验收**：示例扩展（权限门、路径保护、git checkpoint、自定义命令）+ 扩展 API 测试。

### Phase 6 — 对拍 + 冒烟
mock OpenAI 服务器（本地 HTTP，固定流式响应，不依赖真实 key）；对拍脚本（同一场景脚本驱动 Python REPL 与 `claude-pi --mode json`，比对工具调用序列与最终输出）。
**验收**：四层测试全绿；核心场景对拍零差异（差异逐条裁决：真回归 vs 已批准的行为变更）。

### Phase 7 — MCP 里程碑（独立，不阻塞 1-6）
`@modelcontextprotocol/sdk` 移植：hub.ts（← mcp_integration/hub.py）、names.ts、schema_strict.ts、local_server（← local_mcp_server.py，SSE/stdio）。`.agent/mcp.json` 配置。范围：A+C 已完成、B 独立验收。

## 测试策略（四层）

| 层 | 工具 | 覆盖 |
|----|------|------|
| 单元 | vitest | Python 版全部用例移植 + 新增（session-manager、扩展 API、output-queue） |
| 组件 | vitest + mock Terminal | pi-tui 组件 `render(width)` 输出断言、按键注入 |
| 对拍 | 场景脚本 | Python vs `--mode json` 行为等价 |
| 冒烟 | mock OpenAI 服务器 | hook→tool→compact→recovery 全链路，CI 可跑 |

## TUI 走查清单（验收用）

- [ ] 流式输出渲染（Markdown/代码块/长行换行）
- [ ] 中文输入（IME 候选框定位正确）
- [ ] 权限弹窗（拒绝/允许/始终允许）
- [ ] 队友消息注入（agent 配色区分）
- [ ] 后台任务通知注入
- [ ] worktree 切换指示器（claim → 隔离 → complete → 恢复）
- [ ] /tree 切分支（含 branch_summary 生成）
- [ ] /fork、/clone 全流程
- [ ] /resume、-c、--session 断线恢复演练
- [ ] 扩展加载（三位置）+ /reload 热重载
- [ ] -p 管道输入、--mode json 输出
- [ ] 窗口 resize、Ctrl+C 退出

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| pi-tui 未到 1.0，API 可能变动 | 锁版本；核心 UI 与库解耦（薄封装层） |
| 对拍输出噪音（时间戳/随机分支名） | 对拍脚本规范化字段；差异逐条裁决 |
| 会话格式自管版本与 pi 未来差异 | entry 子集固定；升级走显式迁移 |
| mid-turn 崩溃丢回合（pi 语义） | 文档声明；`-p` 场景可重跑 |
| 扩展执行任意代码 | README 显著警示（ADR-0006） |

## 验收标准（总）

四层测试全绿 + TUI 走查清单全过 + 核心场景对拍零差异。Python 版保留为参照，不做删除决策。
