# Claude Code 错误恢复机制调研（对照 claude-pi）

> 调研时间：基于官方文档（`code.claude.com/docs/en/errors`、`/checkpointing`、`/settings`、
> `/model-config`、`platform.claude.com/docs/en/agent-sdk/file-checkpointing`）+ 社区 GitHub issue。
> 目的：列出 Claude Code 有而 claude-pi 尚未实现的恢复手段，供移植设计参考。

## 一、claude-pi 已有 vs Claude Code 全景

claude-pi 现有（`src/error-recovery.ts` + `session-manager.ts`）：

- 指数退避重试（`retryAssistantCall`，默认 3 次 / 2s）
- `finish_reason=length` → max_tokens 8K→64K 升级 → 续写提示（≤3 次）
- context overflow → reactive compact（一次）
- 树形会话 + 崩溃后 reopen/resume 重建上下文

## 二、Claude Code 有而 claude-pi 没有的（缺口清单）

### A. 传输层

| # | 机制 | CC 行为 | 移植要点 |
|---|------|---------|----------|
| A1 | **重试预算分级** | 响应未开始流式 → 用满重试预算；已开始输出 → 不重试（保留部分结果） | 需要区分"流式产出阶段"状态机 |
| A2 | **流式半途失败保留已完成输出** | 保留已完成的文本块/工具调用，追加 `The response above may be incomplete`，从完成点继续回合；不重跑工具避免双重副作用；`-p` 模式打印最后完成块；用户回 `continue` 续上 | 需记录每轮已产出的块 + 工具执行结果缓存 |
| A3 | **流停滞看门狗** | 20s 无数据（advisor 90s）→ abort 停滞连接并重发一次（不计入重试预算）；spinner 显示 `Waiting for API response · will retry in` | `AbortSignal.timeout` + 字节/事件级 watchdog |
| A4 | **降 max_tokens 重试** | 请求因 input+max_tokens 超上下文被拒 → 降低 max_tokens 重试；降无可降才转 compact | 与现有"升级"路径互补，两条都要 |
| A5 | **无限重试模式（CI）** | `CLAUDE_CODE_RETRY_WATCHDOG=1`：429/529 无限重试；其他瞬态错误默认 300 次（≈3h 退避）；`CLAUDE_CODE_MAX_RETRIES` 上限 15，可调 | 无人值守场景 |
| A6 | **重试标签分级披露** | spinner 显示 `Retrying in Ns · attempt x/y`；第 3 次起揭示具体原因（网络断/TLS/限流），首两次只显示 `API error` | 日志可观测性 |
| A7 | **休眠检测** | 检测电脑休眠打断请求 → 按断连处理，标签注明 `Connection lost while your computer was asleep` | 平台 API 监听休眠事件 |
| A8 | **429 细分** | 临时 429 重试；网关 spend-limit 429（`x-should-retry: false`）不重试直接报错 | 检查响应头 |
| A9 | **TLS 策略** | 证书校验失败不重试立即报错（瞬态握手超时仍重试） | 按错误类型分类 |
| A10 | **Subagent 部分输出保留** | 前台 subagent 已产出的文本标记 incomplete 注入给主 Agent；`terminated early` 后可 resume subagent | subagent 结果分级 |

### B. 上下文/请求层

| # | 机制 | CC 行为 | 移植要点 |
|---|------|---------|----------|
| B1 | **Auto-compact 默认开启** | `autoCompactEnabled=true`、`autoCompactWindow`（100K–1M）、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`（触发百分比）；1M 模型超 200K 自动压回 | **有意不采纳**（2026-09-23 决定）：本项目阈值 = 0.92 ×（模型真实窗口 − 输出预留），不引入固定压缩窗口；只有比例可配（`compaction.autoCompactPct`） |
| B2 | **`/compact` 失败恢复** ✅ 已实现（2026-09-23） | 压缩失败（`Conversation too long`）→ 提示回退几轮再试 | 手动 `/compact [额外指令]`：强制压（不看阈值）、失败不写 entry、提示 `/tree` 回退重发。cpi 无 `/clear`，未照搬该建议 |
| B3 | **`/context` 占用分解** | 查看系统提示/工具/记忆/消息各自占用量 | 诊断工具 |
| B4 | **MCP 工具定义挤占上下文** | `/mcp disable` 移除未用 server 的工具定义释放窗口 | |
| B5 | **图片自动降采样** | 8000px→2000px；无法处理 → 文本占位并重试；请求超 32MB 自动丢弃最旧附件 | 附件管理 |
| B6 | **压缩窗口预警** | `/context` 顶部警告 `Context is 94k tokens past the 200k-token compaction window — run /compact` | 提前干预 |

### C. 会话层

| # | 机制 | CC 行为 | 移植要点 |
|---|------|---------|----------|
| C1 | **resume 失败可重试** | `Failed to resume the conversation. Run claude --resume <id> to retry`，不挂死 | 错误信息给命令 |
| C2 | **跨项目会话选择** | `--resume` 选择器 Ctrl+A 跨项目搜索 | 会话索引 |
| C3 | **`/clear` + 找回** | `/clear` 后同进程内 rewind 菜单出现 `/resume (previous session)` 入口 | 进程内暂存 |
| C4 | **Remote Control 重连** | 断线后 `/remote-control` 重试；失败本地会话继续运行 | |

### D. Checkpoint / Rewind（详见下文第三节）

| # | 机制 |
|---|------|
| D1 | 每个 user prompt 自动创建 checkpoint（文件快照 + UUID） |
| D2 | `/rewind` / 双击 Esc → 5 种恢复动作（代码+对话 / 只对话 / 只代码 / 双向压缩） |
| D3 | 快照随会话保存，resume 后仍可 rewind |
| D4 | 100 个最近 checkpoint；30 天清理（`cleanupPeriodDays`） |

### E. 模型层

| # | 机制 | CC 行为 |
|---|------|---------|
| E1 | **高负载提示换模型** | 529 时提示 `Opus is experiencing high load, please use /model to switch to Sonnet`（容量按模型计） |
| E2 | **自动模型回退** | Fable 5 被安全分类器拦截 → 自动回退其他模型（第三方 provider 用 `ANTHROPIC_DEFAULT_FABLE_MODEL` 指定回退 ID）。注：旧版 `fallbackModel` 设置项已从 settings 表移除 |
| E3 | **限额按模型解耦** | Opus 限额只限 Opus，`/model` 换模型继续工作 |

### F. 认证/配额/诊断

| # | 机制 |
|---|------|
| F1 | OAuth token 过期自动刷新并重试一次（含 auto mode classifier 请求） |
| F2 | `/usage` 查看限额与重置时间；`/usage-credits` 购买额外用量；`/status` 核对当前凭据 |
| F3 | `claude --debug` / `/debug` → `~/.claude/debug/*.txt` 调试日志 |
| F4 | `/feedback` 携带 transcript 上报错误 |
| F5 | Auto mode 分类器失败 → 回退手动审批（交互式）；headless 才 abort |

---

## 三、Claude Code Checkpoint 详解

### 3.1 整体定位

Checkpointing = 会话级的**文件快照 + 对话回退**机制，回答"Claude 改坏了代码/聊歪了，如何回到之前某一点"。
它与版本控制互补（官方明言"Not a replacement for version control"），是**快速、会话级**的恢复手段。

### 3.2 生命周期与触发

- **触发点：每个 user prompt**。用户每发一条消息，就创建一个新的 checkpoint，作为后续回退的还原点
- **容量：每个会话保留最近 100 个 checkpoint 的快照**。淘汰旧 checkpoint 时删除不再被引用的快照文件，但**每个文件的首份快照永久保留**——它是 VS Code 扩展做"会话 diff 基线"用的
- **持久化：checkpoint 随会话保存**（存在 transcript/会话数据里），所以 resume 会话后 `/rewind` 依然可用
- **清理：随会话 30 天后删除**（`cleanupPeriodDays` 可调）
- **存储位置**：`~/.claude/file-history/<session-id>/`（按会话组织的版本化文件副本）；会话本体在 `~/.claude/projects/<项目路径>/<session-id>.jsonl`

### 3.3 捕获什么

只追踪**文件编辑工具**（Write / Edit / NotebookEdit）造成的修改：

- 会话期间**新建的文件**
- 会话期间**修改过的文件**
- 修改前文件的**原始内容**（写前备份）

**不追踪**（官方文档明确）：

- Bash 命令改的文件（`rm` / `mv` / `sed -i` / `echo >` 等）
- 后台 subagent 的编辑（前台 `context: fork` skill 例外）
- 会话外的外部改动（其他会话/手动编辑）
- 符号链接与硬链接路径（v2.1.216 起 restore 时跳过并警告 `Restored the code, but skipped N files`）

### 3.4 实现机制（SDK 侧官方描述）

`platform.claude.com/docs/en/agent-sdk/file-checkpointing` 给出了数据流：

1. **启用**：`enable_file_checkpointing=True`（SDK）/ 默认开启（CLI）
2. **写前备份**：Agent 通过 Write/Edit/NotebookEdit 修改文件**之前**，SDK 先把文件原内容备份到快照存储（`~/.claude/file-history/<session>/`，版本化）
3. **checkpoint UUID**：响应流里每条 user message 携带一个 checkpoint UUID，作为还原点标识
4. **恢复（rewind）**：`rewindFiles()` / `rewind_files()` 语义 =
   - **删除**会话期间新建的文件
   - **把修改过的文件恢复**到该 checkpoint 时刻的内容
   - **不动对话**：rewind 只还原磁盘文件，conversation 历史与上下文保留
5. **跨会话可用**：checkpoint UUID 与快照持久化，resume 后仍可 rewind（需 `replay-user-messages` 参数接收 UUID）

### 3.5 恢复菜单（CLI 侧）

`/rewind` 或**双击 Esc**（输入框为空时）打开 rewind 菜单，列出会话中每个 prompt，可选 5 种动作：

| 动作 | 效果 |
|------|------|
| **Restore code and conversation** | 代码+对话都回退到该点 |
| **Restore conversation** | 只回退对话，保留当前代码 |
| **Restore code** | 只还原文件改动，保留对话 |
| **Summarize from here** | 从该点向后压缩成摘要（释放上下文，类似定向 `/compact`） |
| **Summarize up to here** | 该点之前的对话压缩成摘要，后面保留 |

交互细节：

- 恢复后，所选消息的原始 prompt 会**恢复到输入框**，可直接重发或编辑
- 压缩不改变磁盘文件，原文留在 transcript 中可再引用
- `/clear` 之后，菜单顶部多一项 `/resume (previous session)`，可找回被清掉的会话
- 想分支而非压缩：用 `/branch` 或 `claude --continue --fork-session`

### 3.6 实现争议：内部快照 vs git

**官方文档**：checkpoint 使用 Claude Code 自有的文件编辑快照（`~/.claude/file-history/`），**不使用 git**。

**社区观察**（GitHub issues，2026-06）与文档矛盾：

- 用户通过 `git reflog` / `reference-transaction` hook 抓到 Claude Code 进程在工具调用前后执行
  `git stash` → `git reset --hard -q --no-recurse-submodules`，把工作区反复重置回 HEAD，
  多次抹掉未提交的 staged 改动（`tengu_use_file_checkpoints` Statsig 开关为 true 时触发，间歇性 debounce）
- 另一用户报告每 10 分钟 `git reset --hard origin/main` 毁掉未提交改动（90+ 条 reflog 记录）
- 结论：**部分构建/特性开关下实现是 git 操作而非文档所述的自有快照**，且存在工作区数据风险；
  官方文档与实现不一致的问题已被用户要求修复（提供关闭开关、恢复必须还原工作区）

历史沿革：早期版本（2025 年前后）Claude Code 的 "Checkpoint" 就是**自动 git commit**
（消息形如 `Checkpoint: <hash>`），后来才迁移到内部快照方案；上述 issue 表明 git 操作路径
在特定 gates 下仍然存在。移植时应以文档语义（写前备份快照）为准，并避免任何 git stash/reset。

### 3.7 已知局限（移植时要避免的坑）

- bash 修改不追踪 → rewind 会漏掉"代码没问题但配置被 bash 改了"的变更
- 后台 subagent 编辑不恢复（需 git 兜底）
- symlink/hardlink 跳过（v2.1.216 前会穿过链接读写，危险）
- 快照仅 100 份/会话、30 天清理，不是长期历史
- 不替代版本控制（长期历史交给 git）

### 3.8 对 claude-pi 的移植建议（落地要点）

1. **存储**：`.agent/checkpoints/<session-id>/` 按会话组织；JSONL 会话树里每条 user entry 记一个 checkpoint UUID
2. **写前备份**：在 `write_file` / `edit_file` 工具执行前备份原文件（只备份首个改动版本即可，rewind 语义是"回到某点"，增量中间态可省）
3. **还原语义**：`rewind(uuid)` = 删除该点之后新建的文件 + 恢复该点之后被改文件的内容；对话回退单独走现有树形会话（entry 树天然支持"回退到某 entry"）
4. **保留基线**：每个文件首份快照保留（供 diff/审计）
5. **安全**：跳过 symlink/hardlink；恢复前校验路径仍在快照时位置
6. **容量**：每会话 100 份上限；随 `cleanupPeriodDays` 清理
7. **避免**：任何 git stash/reset 实现路径

## 四、来源

- Claude Code Error reference：https://code.claude.com/docs/en/errors
- Checkpointing：https://code.claude.com/docs/en/checkpointing
- Settings：https://code.claude.com/docs/en/settings
- Model config（自动模型回退）：https://code.claude.com/docs/en/model-config
- Agent SDK File checkpointing：https://platform.claude.com/docs/en/agent-sdk/file-checkpointing
- 社区 issue：`anthropics/claude-code` #65782（fallbackModel 移除）、git stash/reset 观察报告（2026-06）、每 10 分钟 `git reset --hard` 报告
