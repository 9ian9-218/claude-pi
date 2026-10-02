# 运行与验收记录（2026-10-02）

本次在基线 `66d94a894291dfe63b68e5bc37832680824e7088` 上实现，以下记录对应本地验收快照。此前评估原始证据位于 `/workspace/claude-pi-assessment.md` 和同名 evidence JSON；这些文件描述修改前的行为。

## 已实现

- ToolRuntime 集中校验和授权，角色限制同时覆盖本地 MCP 别名；冻结授权参数，控制 Hook 异常拒绝执行，观察 Hook 异常仍可隔离。角色列表与实际工具一致。
- 工具返回机器可读状态和 shell 真实退码；会话记录 `toolStatus/execution` 与 `tool_started/tool_completed/run_end`。CLI 输出最终状态和共享预算，print/json 模式的 SIGINT/SIGTERM 会取消执行并以 130 返回。可恢复的单工具错误允许模型继续修复，最终 `success` 不等同于业务测试全部通过。
- `run_verification` 对直接验证命令保存真实退码、验收目标和日志，拒绝退码掩盖。新回归验证测试失败确实为 error/exit 1。
- 前后台复用异步 ProcessRunner，前台默认 120 秒超时，可传 `timeout_ms`；POSIX 取消发送进程组 TERM，250 ms 后 KILL。预览默认 64 KiB、后台 50,000 字节；日志上限 16 MiB，截断明确提示。`background_job` 可查询、等待或取消。后台记录重启后标为 unknown_after_restart，不凭旧 PID 盲目终止其他进程。不提供交互 stdin，交互程序必须改用非交互模式。
- 文件读取提供 SHA-256；编辑拒绝歧义与 stale hash，多文件 patch 预检、原子写入、失败回退。检查点保存原始字节和文件模式，恢复前检查当前版本。检查点/执行日志保留已经发生的副作用；shell 外部副作用没有自动回滚承诺。
- 完成任务前导出二进制 Git patch、新文件及 base/head SHA 和文件哈希。待审查产物保持依赖阻塞。显式 integrate_task 进行完整预检和冲突拒绝，保留检查点、不提交、不改暂存区。安全清理仅处理 clean 且 merged 的分支；dirty/unmerged 产物保留。符号链接产物暂不自动集成，会拒绝并保留 worktree。
- 自动加载根及子目录作用域的 AGENTS.md/CLAUDE.md；文件读取展示作用域指令，第一次尚未看过的目录编辑会先返回指令。repository_info 发现多包测试入口；symbol_search 提供词法定义/引用候选。当前没有完整 LSP/类型感知引用服务。
- TaskBudget 在 AsyncLocalStorage 中由父子 agent 共享，模型主请求、重试、压缩、记忆调用统一记账；请求前预留输入/输出 token 和费用，失败无 usage 时保守记入预留量。默认请求 100、工具 500、token 1,000,000、时长 30 分钟、并发模型请求 6。提供商报出的用量仍可能偏离预留，预算检查会随后停止；它不是服务商账单硬上限。
- 模型请求默认总时长 300 秒、首 token 60 秒、流停滞 60 秒；可取消包括挂起的 SSE。停滞后的部分文本保留并标记未完成，不作为最终答案。未知价格在 doctor/TUI/budget 中明确标识，费用限额存在而价格未知时在请求前拒绝。
- 项目扩展及自动 MCP 启动使用配置目录中的信任指纹；项目扩展树和 MCP 配置变化要求重新信任。user 目录扩展和 -e 是用户授权代码；这是宿主代码信任，不是对任意扩展的沙箱。扩展不得替换内置工具，reload/unload 注销 hooks/tools/commands/renderers，失败加载也清理注册项。导入项目外的依赖仍需用户信任。
- doctor 显示配置位置、官方模型目录/鉴权、代理/CA、Git/rg、预算、后台任务和真实 sandbox 探测，不输出 key。发布入口修复了 node_modules 中的 TS 加载问题，包排除测试与运行凭据。CI 提供 Linux Node 22.18/24 回归与故障评测，以及 Linux/macOS/Windows 生产包 smoke 矩阵。远端 CI 在推送后触发；这里记录本地验收时的状态。

## 配置预算和超时

使用 `CLAUDE_PI_MAX_REQUESTS / TOOLS / TOKENS / COST / DURATION_MS / CONCURRENCY`，例如：

```sh
CLAUDE_PI_MAX_REQUESTS=20 CLAUDE_PI_MAX_DURATION_MS=300000 cpi -p --no-session '任务'
```

这里的 `TOOLS` 等为完整变量 `CLAUDE_PI_MAX_TOOLS`。请求超时可用 `CLAUDE_PI_REQUEST_TIMEOUT_MS`、`CLAUDE_PI_FIRST_TOKEN_TIMEOUT_MS`、`CLAUDE_PI_STREAM_IDLE_TIMEOUT_MS`。费用单位与 provider 元数据一致，通常为美元；定价缺失不能设成本限额。token 预留使用保守字节估算，可能比实际用量更早停止。已发生的远端计费无法由本地撤销。

## 本机验证

最后的运行结果见下方记录及 `.agent/evals/latest.json`；保留每一次故障评测结果，不将失败重跑覆盖成成功。

当前 Debian / Node 24.19.0 环境允许本地 HTTP mock 和进程组测试，但禁止嵌套隔离空间。doctor 实测 bubblewrap 失败，受限 verifier 不会降级成可信 shell。其源码写保护/外部路径/网络隔离的成功路径须在允许 bubblewrap 的 Linux 主机验证；当前仅验证拒绝和无副作用路径。Windows 完整进程树取消尚未实现，只能终止直接子进程；macOS/Windows 完整测试尚未本机运行。

本次 DeepSeek Flash 官方 API 的小型编码任务独立原测试 23 项；错误实现先失败，agent 修改实现后由外部再次运行原测试，测试文件哈希未变。新工具实测先返回 verification error / exit 1，修复后返回 verification success / exit 0；其中一次 stale hash 编辑被拒绝，模型读文件后自行重试。该单任务只证明 API、指令、编辑、错误自纠正和验收链路；不能用作工业产品或完整 benchmark 的成功率排名。其价格元数据未知，费用不宣称为零。

最终验收目标：类型检查通过、65 个测试文件 / 586 项测试通过；35 项故障案例三次独立重复（105 项）均通过，不允许 skip 或缺失案例计为通过；生产 tarball 仅生产依赖安装后 CLI 版本与真实本地 HTTP JSON 往返通过。当前 Node 24.19.0 / Linux 结果汇总保存在 `/workspace/claude-pi-improvement-validation.json`。其中的 SHA 为基线，working diff 指纹用于标识验收时的实现快照。
