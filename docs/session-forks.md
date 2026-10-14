# 会话树、独立 session 与 worktree

会话树保存对话的分支；Git worktree 隔离项目文件。两者可以分别使用，也可以在分叉时绑定。

## TUI 操作

| 命令 | 行为 |
| --- | --- |
| `/tree` | 展示完整树，包括已离开的分支。`●` 表示当前路径，`○` 表示其他路径，缩进表示深度 |
| `/tree <entryId>` | 在同一 session 内切换节点；历史记录保留 |
| `/tree <entryId> --before` / `--after` | 显式选择节点之前或之后 |
| `/tree <entryId> --summarize` | 切换前调用 LLM 总结离开路径的后缀，成功后写入 `branch_summary` |
| `/fork` | 从完整树任意节点创建新 session，自动切换到副本 |
| `/fork <entryId> --after` | 从指定节点之后创建新 session |
| `/fork <entryId> --isolated` | 复制所选对话前缀，并创建独立 worktree |
| `/clone` / `/clone --isolated` | 复制当前活动路径，选择共享目录或独立 worktree |
| `/resume` | 恢复会话；隔离会话仍在原项目的列表中 |
| `/session` | 查看会话文件、父会话、执行目录、worktree ID 和基线 SHA |

选择 user 消息默认回到它之前，并把原文填回编辑器，便于修改后重问。选择其他节点默认包含该节点。
显式 `--after` 可以保留选中的 user 消息。切换、分叉和恢复会重建完整聊天历史，并恢复所选路径上的模型和思考强度。

`/tree --summarize` 会增加一次 API 调用。摘要输入有长度上限，计费用量记录在摘要节点并计入 footer。
生成失败或空摘要会取消切换；不指定该参数时，树导航不调用模型。

## CLI 操作

```bash
# 复制当前活动路径，延续现有 --fork 的包含节点语义
cpi --fork <session-id-or-jsonl-path>

# 从任意历史节点开始一个独立会话（entryId 可在 /tree 中查看）
cpi --fork <session-id-or-jsonl-path> --fork-entry <entryId> --fork-position after

# 从 user 消息之前分叉，并隔离项目文件
cpi --fork <session-id-or-jsonl-path> --fork-entry <entryId> \
  --fork-position before --fork-workspace isolated

# 断线或进程退出后恢复
cpi --session <new-session-id-or-jsonl-path>
```

`--fork-position` 为 `before|after`，默认 `after`；`--fork-workspace` 为 `shared|isolated`。
普通 session 默认共享目录。已有隔离 session 的后续 fork/clone 默认创建另一个 worktree，
显式共享它的独占租约会报错。每个 fork 都有独立 JSONL 文件和新的 session ID，原会话不会被切换。

## 落盘和恢复

JSONL header 保存 `parentSession` 和 `fork: {sourceSessionId, sourceEntryId, position}`。
跨目录分叉在目标项目的会话目录创建文件，header 的 `cwd` 也指向目标目录。
原地导航保存 `activeLeafId` 和 `cursorEntryCount`；选中根节点之前时 cursor 为 `null`。
恢复根据 cursor 重建路径；追加后清除 cursor。若崩溃发生在追加和 header 清理之间，新增条目数量
会让旧 cursor 失效，恢复到最新有效条目。旧格式文件继续使用最后一个有效条目。
切换 session 时释放旧 JSONL 的文件锁，允许同一进程再次恢复它；异步分叉/摘要命令期间暂缓新提交。

隔离 session 额外保存 `projectCwd` 与
`workspace: {id, recordPath, worktreePath, baseSha}`。会话列表按 `projectCwd` 分组，执行使用 worktree 的 `cwd`。
租约所有者是 `session:<sessionId>`，权威状态仍在主仓库 `.agent/workspaces/`。
每次执行先恢复并验证租约，再运行 hook、追加用户输入及调用模型。活跃的其他进程、已关闭租约、
缺失或重定向的 worktree 都会阻止执行。退出进程的租约可以在恢复时重新领取并更新 generation。
委派 Agent 已有的独立工作目录和身份继续由其工作区管理。

导入会话创建新的 session ID、使用当前项目目录，保留来源信息，并移除外部 worktree 绑定。

## 工具回合和文件快照边界

可以在 assistant 工具调用或部分工具结果处选节点。原始 JSONL 前缀保留，发送给模型的上下文会
撤销尚未闭合的工具轮次并加入中断标记；后续用户消息继续保留。不匹配的工具结果会被拒绝。
这提供协议安全的继续执行，不代表保存了正在运行的工具进程，也不保证自动重试没有副作用。

独立 worktree 从**分叉时当前文件内容**建立私有 Git 基线，包括未提交修改，使用临时 index，
保留原工作区的 HEAD 和暂存区；私密运行目录与凭证文件不进入快照。`baseSha` 是该基线的 commit。
选择历史对话节点不会把代码恢复到历史时刻，也不会撤销已经发生的外部操作。

文件修改保留在独立分支和 worktree 中，可通过 `/session` 获取目录，执行 `git -C <目录> status`
和 `git -C <目录> diff <baseSha>` 审查。退出或切换 session 后保留工作区产物，后续通过原 session 恢复。
任务工作区的整合与产物保留见 [Git 工作区隔离与恢复](workspace-isolation.md)。

## 验证

`tests/session-fork.test.ts` 使用真实临时 Git 仓库与子进程，验证历史分叉、header 持久化、根 cursor、
追加后的崩溃恢复、并发隔离、脏文件快照、原 index/HEAD 保留、跨进程租约恢复和 CLI 参数。
TUI 回归验证旧分支可见、user 编辑器填充以及模型/思考强度恢复；摘要测试使用 mock，避免真实计费调用。
