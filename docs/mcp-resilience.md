# MCP stdio 生命周期与故障防护

cpi 使用 SDK `Client` 完成协商、JSON-RPC 请求管理与工具结果 schema 校验；
项目的 `ManagedStdioTransport` 管理子进程、管道、流量与解析边界。
Python、Node 等 Server 使用同一生命周期，不要求 Server 安装 Node SDK。

## 连接、调用与退出

CLI 的 REPL、TUI、print、json 模式都会在执行前加载受信任的 `autoConnect` 配置。
初始化和工具发现共用启动 deadline；连接中的 Server 也纳入 shutdown。
同名连接先预留记录，并发请求不会重复启动进程。工具发现通过全部检查后一次性注册；
名称归一化冲突、超长名称与保留的 `local` 名称会被拒绝。
原始工具名保留用于调用，不把归一化后的名字错误地发给 Server。

`ready` 状态允许调用；连接退出或熔断时立即移除工具。连续请求失败达到阈值后进入
`open`，冷却期内拒绝重连。成功调用清零连续失败；业务 `isError` 结果不算连接失败。
用户取消返回 `cancelled`，请求 deadline 返回 `timeout`，不再统一降为普通错误。

自动重启默认关闭。配置显式开启后，冷却期采用有限退避，每次重启重新检查当前配置
的信任指纹，最多重启指定次数。耗尽后需要显式恢复；不重放失败工具调用。
用户取消初始化和主动 disconnect/shutdown 会取消重启。

Linux/macOS 子进程使用独立进程组。关闭时先结束 stdin，等待 grace，再 SIGTERM，
等待 grace，最后 SIGKILL，并等待管道结束。直接子进程先退出时也回收同组后代。
退出流程幂等，并发 shutdown 会等待同一清理过程。Windows 提供 `taskkill /T /F`
回收路径，但本次验证运行在 Linux；Windows 命令解析与回收尚需原生主机验证。

所有模式经过 `finally` 清理；SIGINT/SIGTERM 中止启动或当前执行，fatal handler 在
有限时限内等待 MCP 回收后退出。TUI 的显式进程退出发生在清理完成之后。
宿主进程遭 SIGKILL 时不能执行这些回调，仍需要外部进程监督处理这一边界。

## 输入与输出限制

| 项目 | 默认值 |
| --- | --- |
| 初始化及工具发现总 deadline | 30 秒 |
| 工具调用 deadline | 60 秒 |
| 关闭 grace | 每阶段 500 毫秒 |
| 连续失败熔断阈值 | 3 次 |
| 初始冷却期 | 30 秒 |
| 自动重启次数上限 | 2 次，须开启 `autoRestart` |
| 每 Server 并发请求 | 4 个 |
| 单帧输入／输出 | 1 MiB |
| JSON 深度／结构 token 上限 | 64／50,000 |
| 消息速率 | 每秒窗口 200 条 |
| stdout／stderr 字节速率 | 各每秒窗口 4 MiB |
| 协议错误阈值 | 10 秒窗口内 3 次 |
| 内存保留的 stderr 尾部 | 16 KiB；状态接口展示最多 1 KiB |
| 格式化工具结果 | 64 KiB，含截断提示／错误包装 |
| 每 Server 工具数量／元数据 | 128 个／256 KiB |
| Hub Server 数量／工具元数据总量 | 16 个／512 KiB |
| MCP 结果产物配额 | 8 MiB，最多 128 个文件 |

stderr 始终读取，不写无限日志。超出速率时终止连接；正常的大日志只保留有限尾部。
stdout 在 JSON.parse 前限制帧大小、消息速率、UTF-8 编码、嵌套深度和结构复杂度。
未结束的巨大帧、流量溢出与复杂度溢出直接熔断；少量坏帧可恢复，达到错误阈值则关闭。
工具数量和元数据大小在 SDK 编译 outputSchema 前先核验。

文本移除 ANSI/OSC 转义和不可打印控制字符，规范换行，按 UTF-8 字节安全截断。
诊断不会反射非法原始帧；状态接口不展示 command、args、env，并遮蔽具有凭据含义的
环境变量值。默认过滤继承的凭据环境；Server 所需凭据应在配置 `env` 中显式提供。

大结果经 L3 的 2,000 token 判定后，保存到当前工作区 `.agent/mcp/results/`，返回
500 token 预览与路径。保存受跨进程配额锁保护，删除最旧的 cpi 结果文件后再写入；
超出单次可用配额时仅提供预览。旧路径可能因轮转失效。它不限制会话、用户文件或
其他工具产物的磁盘占用；内置工具原有的 L3 行为保持独立。

这些限制保护 Client 的传输与常见解析路径，不是整个 Server 的 OS 沙箱，不能给
任意第三方程序或复杂 schema 验证代码提供硬 CPU/RSS 保证。MCP 描述和返回文本仍是
不可信数据；控制字符清洗不证明没有提示注入。取消通知也不证明外部操作已停止或回滚。

## 配置与操作

`.agent/mcp.json` 示例：

```json
{
  "mcpServers": {
    "example": {
      "command": "python3",
      "args": ["-u", "/absolute/path/server.py"],
      "autoConnect": true,
      "autoRestart": false,
      "limits": {
        "startupTimeoutMs": 30000,
        "requestTimeoutMs": 60000,
        "failureThreshold": 3,
        "cooldownMs": 30000,
        "maxRestarts": 2
      }
    }
  }
}
```

检查配置后执行 `cpi --trust-project-code`，然后启动 cpi。配置有变化时需重新授予信任。
`limits` 接受表中对应的 `McpLimits` 字段；未知字段、无效整数和超过硬上限的值拒绝。
配置文件最多 256 KiB；`cwd` 相对项目根解析，默认也是项目根。

主 Agent 可调用 `connect_mcp(name)`、`disconnect_mcp(name)`、`restart_mcp(name)` 和
`list_mcp_servers()`。连接／重启工具只接受已配置的名称，并要求当前配置受信任；
不接受模型提供的任意启动命令。管理工具不授予 Worker、Subagent 或队友。
SDK 的程序化 `connectStdio(config)` 保留，用于明确受信任的宿主调用。

## 验证

`tests/mcp-resilience.test.ts` 使用受控 Node/Python 子进程，覆盖日志阻塞、超时与取消、
异常退出、垃圾帧、UTF-8、巨大无换行数据、深层 JSON、流量、发现限制、并发与 stdin
背压、顽固进程组、结果 schema、输出清洗与配额、信任及有限重启。
`tests/mcp-cli-lifecycle.test.ts` 验证 REPL、print、json、真实伪终端 TUI、启动期 SIGTERM
和 fatal 退出。模型调用仅使用本地 HTTP mock，不访问付费模型。
