# Agent Loop 架构摩擦报告（claude-pi）

范围：agent-loop / loop-options / ui-events / client / error-recovery / compact / permission(+sync) / tool / hook / message-queue / output-queue / subagent 相关（tool.ts subagent_task、teammates/spawn、teammates/context、teammates/poller）。

## 1. 文件规模与职责

| 文件 | 行数 | 主职责 |
|---|---|---|
| src/agent-loop.ts | 358 | Agent Loop（Turn 编排）：注入 → L4 压缩 → 可恢复 LLM 调用 → 工具执行 → Stop hook（loop 体 76-335 共 260 行） |
| src/loop-options.ts | 70 | Loop 运行时选项袋 + Lead/Subagent/Teammate 三套身份预设 |
| src/ui-events.ts | 86 | UI 事件通道（UiEventMap + UiEventSink） |
| src/client.ts | 379 | LLM 传输层：裸 ChatMessage ↔ pi-ai Context 转换、sendMessages/completeText |
| src/error-recovery.ts | 207 | LLM 错误恢复状态机（retry/升级 64K/续写/reactive compact/abort） |
| src/compact.ts | 241 | Context Compaction：token 估算、L3 输出截断落盘、L4 摘要、reactive/compactHistory |
| src/permission.ts | 102 | Permission Gate（同步三道门，Gate 3 硬编码拒绝） |
| src/permission-sync.ts | 361 | 跨 Agent 权限冒泡（子/队 → Lead 邮箱轮询 + askUserImpl 注入） |
| src/hook.ts | 97 | Hook 注册表（UserPromptSubmit/PreToolUse/PostToolUse/Stop）+ 内置 hook |
| src/message-queue.ts | 58 | 后台任务通知队列（next/later + recipient 过滤） |
| src/output-queue.ts | 30 | 多 loop 并发输出串行化 |
| src/tool.ts | 1100 | Tool 抽象 + 19 个内置工具 + subagent_task/spawnSubagent + MCP 分发 + validateArgs + L3 出口 |
| src/teammates/context.ts | 67 | 身份上下文（AsyncLocalStorage） |
| src/teammates/poller.ts | 142 | Lead 收件箱轮询 + 三条注入队列 |
| src/teammates/spawn.ts | 195 | Teammate 异步 loop 驱动器 |
| (orbit) memory.ts 293 / prompt.ts 397 / session-manager.ts 762 / background-task.ts 330 | | 记忆注入与 Stop 提取、提示词拼装、会话树落盘/回滚、后台任务+stall 看门狗 |

## 2. 具体摩擦点（file:line）

### F1 上帝函数：agent-loop 的 Turn 体
- agent-loop.ts:76-335 单个 260 行 for 循环内交错 5 个关注点：队友/通知注入（78-100）、L4 压缩门控（101-145）、可恢复 LLM 调用+缓存诊断（148-220）、工具执行子循环（222-311）、Stop hook 与结束（313-333）。
- 20 条 import 语句（agent-loop.ts:11-39）跨 17 个模块；每轮迭代都做全套。
- 不一致：agent-loop.ts:274 后台任务路径跳过 PostToolUse（仅 282-283 前台路径触发），hook 契约在 loop 内两套。

### F2 四个重叠的选项袋（god-options）
- AgentLoopOptions（agent-loop.ts:46-53）与 LoopOptions（loop-options.ts:9-22，14 字段）双重袋；SendOptions（client.ts:64-78，10 字段）被 RecoveryOptions（error-recovery.ts:76-93，10 字段）逐字段复刻，并在 error-recovery.ts:115-126 原样转发——纯透传。
- isSubagent 双通道：AgentLoopOptions.isSubagent（agent-loop.ts:67）→ fromLegacyIsSubagent（loop-options.ts:67-69）→ LoopOptions.subagent()（loop-options.ts:42-52）；spawnSubagent 仍走旧袋（tool.ts:730 maxTurn:30/maxTokens:6000/isSubagent:true），而 spawn.ts:87-91 用新袋 LoopOptions.teammate()。同一概念两种传法。

### F3 Subagent 身份三重分裂（理解一个概念要跳 7 个文件）
- 机制 1：legacy 布尔 isSubagent → client.ts:296 quiet、系统提示（client.ts:300）、getOpenaiTools 过滤（tool.ts:976-990 + SUBAGENT_EXCLUDED tool.ts:703-719）；
- 机制 2：LoopOptions 旗标（skipMemoryStopHook 经 agent-loop.ts:326 作为位置参数传给 Stop hook）；
- 机制 3：AgentContext.role="subagent"（context.ts:5,35-41）——全仓从未被设置（grep 仅 permission-sync.ts:305 引用），permission-sync.ts:275-293 的 bubbleSubagentPermission 是死代码；实际 in-process subagent 以 lead 身份跑 checkPermissionWithBubble:322 分支。
- 再加 prompt.ts SUBAGENT_IDENTITY（subagent 系统提示）和 tool.ts:722-736（spawn 入口）。理解 Subagent = 至少 7 个文件、3 套机制。

### F4 字符串级联耦合
- "[Error]" 前缀：error-recovery.ts:68 appendErrorMessage 制造，agent-loop.ts:178-186 用 startsWith("[Error]") 判断是否落盘——两模块靠魔数约定。
- "Subagent stopped after 30 turns without final answer." 字面量重复：tool.ts:735 与 agent-loop.ts:322。
- Hook 事件是字符串键 + 位置参数：hook.ts:82-87 注册表、HookCallback = any[]（hook.ts:17）、triggerHooks(event, ...args)（hook.ts:31-40）——Stop 的 (messages, preCompress, isSubagent) 三参 arity 无类型保障，加参即破坏调用方。
- 参数三重解析：agent-loop.ts:236-241 JSON.parse + executeToolCall tool.ts:1016-1027 再 parse + validateArgs（tool.ts:1055-1099）手写 JSON-schema 子集，三条路径各自报错文案。

### F5 Context Compaction 概念横跨 6 个文件
- 门控逻辑在 loop 顶部（agent-loop.ts:105-145）：estimateContextTokensByUsage + hasValidPostCompactionUsage（usage-stats.ts）+ getCompactionThreshold；
- 会话/非会话分叉在 loop 内 if/else（agent-loop.ts:113-136：session.appendCompaction vs compactHistory）；
- reactive 压缩在 error-recovery.ts:167-178（splice 直改 messages）；
- 输出格式在 prompt.ts formatCompactedUserMessage 等 3 个函数；
- L3 出口在 compact.ts:180-191 finalizeToolOutput，被 tool.ts:1051 调用。
- compact.ts 公开面 12 个导出（阈值+估算+三流程），调用方只需"压缩一下"。

### F6 三条注入 API 各自为政
- 每轮顶部（agent-loop.ts:78-100）：processPendingLeadPermissions（permission-sync.ts:170）+ consumePendingInjections/consumePendingIdleNotifications（poller.ts:21-31）+ consumePendingNotifications（message-queue.ts:37-48）；且 bgRecipient 硬编码 undefined（agent-loop.ts:74）。
- 两种队列机制并存：message-queue/poller 是进程内模块级数组（message-queue.ts:15-16），teammates/mailbox 是 JSON 文件（文件锁）。理解 Inbox Injection 要跳 5 个文件。

### F7 原地可变契约与双消息表示
- sendMessages 改写调用方数组：client.ts:168-174 ensureSystem + 298-302 unshift 系统提示；
- error-recovery 对 messages splice/推入续写（error-recovery.ts:171, 193-195）；agent-loop replaceMessages splice（agent-loop.ts:356-358）；buildRequestMessages 只对记忆分支拷数组（agent-loop.ts:339-353）——requestMessages 与 messages 双数组同传（agent-loop.ts:146-163）易失同步。
- 双表示：ChatMessage 裸结构（client.ts:31-42）vs AssistantMessage.toolCalls；loop 用 modelDump() as unknown as ChatMessage 强转（agent-loop.ts:223，error-recovery.ts:193 同款）。

### F8 Permission Gate 双实现
- 生产路径：hook.ts:92 注册 permissionHookWithBubble（permission-sync.ts:335-359），Gate1 deny 重查（permission-sync.ts:344-351）、Gate3 冒泡 askUserImpl（permission-sync.ts:75-109 可注入）。
- 遗留同步路径：permission.ts checkPermission（79-97）+ askUser 硬编码拒绝（72-76）仍活着，permissionHook（permission.ts:100-102）只被 hook-tools.test.ts 引用，cli.ts:386 注释还在等 15a 接入。理解 Permission Gate ≈ 8 个文件（permission.ts + permission-sync.ts + teammates/context/poller/mailbox/message-types/team-helpers + mcp/names）。
- askUserImpl 默认实现（permission-sync.ts:75-88）与 permission.ts:72-76 控制台提示几乎重复。

### F9 全局可变注册表 + 每轮重建
- TOOL_MAP（tool.ts:969）可被 registerExtensionTool 突变；getOpenaiTools 每轮重建（agent-loop.ts:159 → tool.ts:976-991）每次都访问 MCP hub。
- HOOKS（hook.ts:82）、CURRENT_TODOS（tool.ts:450）、message-queue/poller 模块级队列全是进程内全局态，跨测试泄漏（各自要 clear* 函数）。
- context.ts:50 setAgentContext 用 AsyncLocalStorage.enterWith —— 跨异步边界泄漏语义，且 spawnSubagent 完全不设身份。

### F10 每轮新建 UI 通道 + 第二条通道
- cli.ts:343-351 每次 onQuery 新建 UiEventSink 并订阅；sink 本身干净（ui-events.ts:58-86，on/emit/listenerCount，无订阅者 no-op），但存在第二条 UI 通道：核心机制直接 console.log（agent-loop.ts:84,98,112,140,217,295；error-recovery.ts:141,148,171,180,190,197），REPL/json 模式靠它，TUI 靠 sink。

### F11 工具执行循环的旁路与递归
- startBackgroundTask（agent-loop.ts:274）分支吞掉 PreToolUse 之后的常规路径，返回合成文本结果；stall/完成通知经 message-queue 注入。
- subagent_task 是自递归：tool.ts:722-736 内 lazy import agent-loop 嵌套跑 30 轮 loop，无身份上下文、无 session、无 UI 事件——子 loop 与父 loop 完全脱钩（agent-loop.ts:60 的 runWithWorkdir 也只在外层生效）。

## 3. 候选的深化机会（deep module + seam）

1. **Turn 编排器（深模块）**：把 agent-loop.ts:76-335 的 5 个关注点收进 runTurn(messages, session, profile, io)，接口 = 输入消息 + 依赖，输出 = 下一动作（continue/return）。内部 seam：CompactionGate（Adapter：session 检查点链 vs 普通 compactHistory）、Injector、ToolRunner、CacheDiagnoser。修一次（如压缩门闩 bug）不再散落 6 处。
2. **Agent Profile / 身份（深模块）**：一个 AgentProfile = role(lead|subagent|teammate) + 派生策略（注入开关、quiet、exitOnFinalContent、skipMemoryStopHook、preserveSystem、工具过滤、权限冒泡走法），替代 F2/F3 的三套机制。loop-options.ts 从 14 字段旗标袋降为 3 个预设适配器；permission-sync、getOpenaiTools、prompt、client 全部从 profile 派生。同时消灭 4 个重叠选项袋。
3. **Context Compaction（在 compact.ts 上加深）**：把门控（阈值估算、usage 门闩、retainedTail）与三流程（session L4 entry、transcript 摘要、reactive）收进 maybeCompact(messages, branch, gate)，失败语义内吞（agent-loop.ts:137-143 的 catch 移入）；删除 loop 里的 if/else 分叉（agent-loop.ts:113-136）。公共面从 12 个导出缩到 2-3 个。
4. **注入通道（深模块）**：injectPending(profile): ChatMessage[] 统一 consumePendingInjections/IdleNotifications/Notifications/LeadPermissions 四条 API；Adapter：poller / message-queue / permission-sync。agent-loop.ts:78-100 的 22 行变一行。
5. **MessageLog（带回滚的深模块）**：append/truncateTo/replace/snapshot/durationAttach/ErrorTurn 类型化操作，Adapter：内存数组 vs SessionManager（session?.appendMessage 在 agent-loop 里散落 8 处）；"[Error]" 魔数变类型化 marker（F4）。
6. **Hook 类型化注册表**：仿 UiEventMap 给每事件定回调类型，杀掉 HookCallback any[] + 位置参数（hook.ts:17,31-40）。不强求深，但 F4 的 arity 泄露只在加类型后消失。

## 4. 删除测试笔记

- **ui-event.ts（UiEventSink）**：通过——删除后 onStream/onToolEvent/onTurnEnd 会重新散落到 client/error-recovery/agent-loop 三层的参数里（注释明示这是 ADR-0008 之前的形态）。seam 正确，类实现浅（Map 包装）但深度在 UiEventMap 类型。
- **loop-options.ts::fromLegacyIsSubagent（loop-options.ts:67-69）**：纯透传 shim——删除后复杂度必须落到一处（把 isSubagent 并入 LoopOptions/Profile 或删掉 legacy 通道），是强制收敛的好删除。
- **permission.ts::permissionHook（permission.ts:100-102）**：删除即消失（生产路径已用 permissionHookWithBubble，hook.ts:92；仅测试引用）——死表面对删除测试的正例，顺带暴露 F8 双实现。
- **compact.ts 整体**：删除后截断/落盘/估算/摘要复杂度回到 tool.ts、agent-loop、error-recovery、session-manager 四处——挣得保留；但其 12 导出公共面大于调用方所需，界面本身该瘦身。
- **message-queue.ts / poller 队列**：各 58/142 行，单独删不划算；摩擦在二分（两个进程内队列 + 一个文件队列）而非任一模块——合并为一个 Injection Channel（机会 4）是正确删除。
- **validateArgs（tool.ts:1055-1099）**：删除后类型错误会显形于 executeToolCall/LLM 端，但消除的是三重校验的第三个副本（F4），净简化。
- **LoopOptions 旗标袋**：删除会把 8 个布尔散回每个 agentLoop 调用点（cli.ts:202-204,357-375、spawn.ts:87-91）——复杂度不会消失，这正是它该被 Profile 取代而非删除的理由（friction 在接口形状，不在存在性）。

## 5. 硬测试区

- agent-loop：无内部 seam，测试只能整 loop 驱动 + 假 LLM（agent-loop-integration.test.ts 41-360 逐特性开整机）；压缩门控/缓存诊断/回滚分支全部端到端覆盖。
- spawnSubagent 自递归（tool.ts:722）：subagent.test.ts:69 嵌套驱动。
- permission-sync pollForPermissionResponse 默认 300s 超时（permission-sync.ts:215）——超时路径不可测。
- background-task stall 看门狗与真实子进程（background-task.test.ts）。
- SessionManager 并发锁/truncateTo 磁盘回滚路径（session-manager.ts:281-340）。
- cli.ts:343-351 每次 onQuery 的 sink 装配无单测（TUI 靠 tui/app.test.ts 集成）。

结论：核心摩擦是 F1 的上帝函数 + F2 的四个选项袋 + F3 的三重 subagent 身份；最大单项杠杆是机会 2（Agent Profile）——单独它就能消掉 F2/F3/F8 的一多半，并为机会 1/4/5 提供干净的 seam。
