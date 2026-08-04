# 会话机制：复制 pi 的 JSONL 树形会话，格式形状相同、版本自管、自实现

claude-pi 引入 pi 的会话上下文管理机制：会话是 `.agent/sessions/` 下的 JSONL 文件，entry 以 `id`/`parentId` 构成树（原地分支，不新建文件），支持 `/tree`（导航/切分支）、`/fork`、`/clone`、`/resume`、`-c`/`-r`/`--session`/`--fork` CLI 操作；上下文从 leaf 回溯构建，压缩写 compaction entry（含 retainedTail 检查点），切分支写 branch_summary。存储于 **`.agent/sessions/` 项目内**（延续"运行时数据不写用户目录"原则），保留 pi 的 `--<path>--` 按 cwd 组织。**格式形状同 pi v3 但版本自管**（entry 子集：session/message/compaction/branch_summary/model_change/session_info/label/custom），不承诺与 pi 文件互通。**自实现 session-manager**（参考 pi MIT 源码），不依赖 pi-coding-agent——其 Anthropic 风格消息模型与 ADR-0005 的裸 OpenAI 消息结构冲突。

**Consequences**: 天然获得断线恢复能力（崩溃后 resume 从 leaf 重建上下文）；mid-turn 未完成回合不落盘（pi 语义）；队友 loop 随进程死亡但邮箱/看板持久化；扩展获得 appendEntry 持久化能力（custom entry 白送）。
