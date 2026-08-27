# ADR-0009: 会话轨迹导出与独立配置

- 状态：已采纳
- 日期：2026-08-27

## 背景

需要把 agent 的任务执行全过程（消息、工具调用、耗时、token 用量）导出为可分析
文件，用于轨迹合理性分析与运行错误发现；同时 cpi 的配置此前与 pi 共享
`~/.pi/agent/`（ADR-0007），需要独立。

## 决策

### 1. 双模式会话导出（TUI `/export`）

- **analysis（测试/分析）**：导出**整棵会话树**为 JSONL 事件流——首行 meta
  （sessionId/cwd/时间/usageTotals），其后每 entry 一行事件
  `{type, id, parentId, time, data}`；message 事件携带运行时补记的
  `durationMs`（模型请求/工具执行）、`usage`（token 明细）、`toolError`
  （失败标记）；`<persisted-output>` 大输出引用合并 `.task_outputs` 全文；
  旧会话（无 durationMs）按相邻 entry 时间差推导 `durationMsInferred`。
  默认输出 `.agent/exports/trace-<sessionId>-<ts>.jsonl`。
- **portable（会话移植）**：仅导出**当前活动分支**，pi `exportToJsonl` 式
  线性化 JSONL（header + 链式 parentId），**剥离全部性能字段**，供 `/import`
  恢复会话。默认输出 cwd 下 `session-<ISO>.jsonl`。

默认模式由项目级配置 `.agent/config.json` 的 `export.mode` 决定
（`/settings` 设置页可改）；`/export --analysis|--portable [path]` 临时覆盖。

### 2. 运行时耗时补记

agent-loop 为每条落盘消息补记真实耗时：assistant 消息带模型请求
`durationMs`（发出→响应完成），tool 消息带工具执行 `durationMs` 与失败标记
`toolError`。字段随消息 entry 持久化（向后兼容，旧文件无字段时导出侧推导）。

### 3. 会话导入（TUI `/import <path>`）

校验 header 后把外部会话文件复制到当前项目会话目录并打开，继续对话落在副本
上不污染源文件（显示确认；非法文件给出明确错误）。

### 4. 独立配置（ADR-0007 修订）

- 全局配置目录改为 `~/.claude-pi/`（auth.json / models.json / settings.json）；
  `PI_CODING_AGENT_DIR` 仍可覆盖。启动时未显式设置该 env 时注入进程环境，
  使 pi-ai ModelRuntime 与本地 settings 读取一致指向新目录。
- 项目级 `.agent/config.json` 承载项目相关设置（export.mode）。
- 一次性迁移：`cpi --migrate-config` 从 `~/.pi/agent/` 复制缺失的
  auth/models/settings；启动检测到旧配置且新目录为空时给出提示。
- `/settings` 设置页：导出模式（项目级）、自动重试、自动压缩（全局级）。

## 后果

- 轨迹分析零前置成本：一个 JSONL 文件按行流式读取即可重放执行过程。
- 旧会话导出耗时质量为推导值（inferred），新会话为真实测量值。
- 与 pi 不再互相读写配置；迁移命令一次性完成。