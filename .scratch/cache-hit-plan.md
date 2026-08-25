# 缓存命中优化计划（grill 共识 · 草案 v1）

> 来源：grill 会话（缓存命中优化是否合理 → 核对 CC/pi → 分阶段实施）
> 状态：**计划已定稿（v2，含 CC 取证）**；工作区中发现阶段 1 的未提交实现
> （settings/compact/prompt/agent-loop/ui-events/app/cache-stats/集成测试——
> 与本节共识逐条吻合，非本会话所写）；是否纳入提交由用户决定。
> 事实调研见
> `docs/research/cc-source-availability.md`（网络连通性 + CC 源码可获取性）。

## 〇、定稿执行方案（grill 共识 · v3，L1–L4 全 CC 语义 + pi 式摘要，与树形协同）

### 阶段 1（修订工作区已有实现）

| # | 项 | 定稿内容 | 协同点 |
|---|---|---|---|
| 1 | L4 触发 | **CC 式**：`kE ≥ 0.92 × (window − maxOutput预留)`；kE = 分支尾部最近带 usage 的 assistant 消息的 `input+cacheRead+cacheWrite`（真实 usage，非字符估算）；maxOutput 预留照 PAA（model id 含 "3-5"/"haiku"→8192，`CLAUDE_CODE_MAX_OUTPUT_TOKENS` env，默认 32000）；0.92 可 settings 覆盖 | **压缩后门闩**：最近 compaction 之后无有效 assistant usage → 不触发（对齐 pi `hasValidPostCompactionUsage`；cpi `computeContextUsage` 已有同款逻辑可复用）——避免压缩后旧 usage 高估引发立即重复压缩 |
| 2 | L4 执行错误处理 | CC 式分类：摘要失败 `no_summary / api_error / prompt_too_long` → 提示"Conversation too long. Press esc to go up a few messages and try again." 之 cpi 版；失败**不写 compaction entry**、回合继续 | 树形无副作用（失败=无 entry 写入） |
| 3 | 摘要模板 | **pi 式**（用户定 A）：`SUMMARIZATION_PROMPT` 7 节（Goal / Constraints & Preferences / Progress(Done/In Progress/Blocked) / Key Decisions / Next Steps / Critical Context）+ `<conversation>…</conversation>` 包装；多次压缩走**更新式**（`UPDATE_SUMMARIZATION_PROMPT` + `<previous-summary>`）；`/compact 指令` → "Additional focus: …" | **previousSummary 从分支链取**：appendCompaction 前在 getBranch() 找链上最近 compaction 的 summary——树形检查点链天然是摘要更新的输入 |
| 4 | 摘要预算 | 12K → **20K**（CC PM2 实证） | — |
| 5 | tail | `slice(-5)` 按条数 → **keepRecentTokens 20K token 预算**（pi）；**保持 cpi 复制式自包含**（retainedTail 存 entry 内，resume 单文件可重建；不采纳 pi 的 firstKeptEntryId 引用式，不采纳 CC 的已读文件式） | 自包含检查点 = 树形可恢复性核心 |
| 6 | 诊断（cache-stats / footer） | **不动**（已实现，与触发算法正交） | kE 与 cache-stats 同数据源（usage 落盘）；compaction 重置点不变 |

### 阶段 2（next 会话：L1/L2/L3）

| # | 项 | 定稿内容 |
|---|---|---|
| 7 | L1 snip | **移除**（CC 无按条数裁剪；`MAX_NUM_MESSAGES`/`_splitRounds`/`formatSnippedUserMessage` 一并清理或留崩溃兜底，实施时定） |
| 8 | L2 microCompact | **移除**（CC 无旧结果回写） |
| 9 | L3 | 单条 tool 输出 **>30K 字符就地截断 + `... [N lines truncated] ...`**（Y_6=30000，env 可覆盖）落点 `src/tool.ts`；**移除尾部总预算** BUDGET_MAX_TOKENS=120K；cpi 已有 `persistLargeOutput`（落盘+预览）**保留为叠加**（截断 + 落盘引用，双保险） |

### 关键验证（阶段 1 验收）

1. 压缩后立即再触发测试：构造"压缩后分支 + tail 含旧 usage"→ 断言门闩生效（不触发）；
2. 多次压缩链：第二次压缩的摘要 = 更新式（previousSummary 传入、输出保留旧信息）；
3. 全量复用：buildSessionContext/usage-stats/cache-stats 断言不变（tail 预算化唯一影响的断言点）。

## 一、核对结论（盘点）

cpi 现有"缓存相关"机制只有：system prompt 组装缓存（合理 ✅，对齐 CC/pi）。
缺陷：**L2 microCompact 每轮就地改写旧 tool result → 无条件破坏自动缓存前缀**
（pi/CC 均不这样做）；L1 snip 按条数裁剪（CC 无此机制，Python clone 遗产）；
L3 budget 尾部预算（合理 ✅，只动尾部）；L4 autocompact 触发硬编码 480K、
文案 `[Compacted]`（pi 是 window 驱动 + `<summary>` 包裹文案）。

## 二、grill 共识决议（Q1–Q5）

| # | 决议 |
|---|---|
| Q1 | 范围 = 诊断 + L4 对齐 + L1/L2/L3 核对 CC（分阶段） |
| Q2 | **B 先行**：先做诊断 + L4；L1/L2/L3 等 CC 事实基础 |
| Q3 | 诊断 = cache-stats 纯函数 + 回合并末提示（不做 /usage 面板） |
| Q4 | L4 = 文案 `<summary>` 包裹 + 触发 window 驱动（`window - reserveTokens`，settings `compaction` 键）；tail 预算化（keepRecentTokens）**暂缓** |
| Q5 | 提示双通道（TUI turnEnd 事件 + REPL console）；原因只报 idle 超时（model 切换原因缺 entry 字段，省略并标注） |

## 三、阶段 1（本期实施）：L4 对齐 + miss 诊断

### 3.1 L4 autocompact 向 pi 对齐

- **触发参数化**：`estimateMessagesTokens(messages) > CONTEXT_LIMIT(480K 硬编码)`
  → `> contextWindow - reserveTokens`；contextWindow 取当前模型
  （`getCurrentModel()?.contextWindow`，兜底 `MODEL_MAX_CONTEXT_TOKENS`）；
  reserveTokens 默认 **16384**（pi 默认），可关（enabled=false）。
- **settings**：`PiSettings` 加 `compaction?: { enabled, reserveTokens }`
  （键名对齐 pi `settings.json` 的 `compaction` 键）；`settings.ts` 解析，
  默认 `{ enabled: true, reserveTokens: 16384 }`。
- **文案**：`formatCompactedUserMessage`/`formatReactiveCompactedUserMessage`
  的 `[Compacted]` / `[Reactive compact]` → pi 文案：
  `The conversation history before this point was compacted into the following summary:\n\n<summary>\n{summary}\n</summary>`
  （导出 `COMPACTION_SUMMARY_PREFIX/SUFFIX` 常量，对齐 pi `messages.js`）。
- **改动文件**：`src/settings.ts`、`src/prompt.ts`、`src/compact.ts`、
  `src/agent-loop.ts`（L4 触发点）。
- **既有断言更新**：`[Compacted]` 出现在 `compact.test.ts`、
  `session-manager.test.ts`、`agent-loop-integration.test.ts`（3 处）。

### 3.2 miss 诊断（对齐 pi cache-stats.js）

- **`src/cache-stats.ts` 纯函数**：
  - `scan(entries)`：相邻 assistant 消息对比——上一轮 prompt tokens 中本应
    命中缓存却重计费的部分 = miss；`missedTokens/missedCost/missCount`。
  - 判定规则（pi 语义）：idle 超过 **5min**（`CACHE_TTL_MS`）提示；miss
    ≤ **1024 tokens**（噪声下限）忽略；compaction/branch_summary **重置**
    prev（上下文合法变更——注意：pi 注释明确 model 切换**不算豁免**，
    但 cpi 缺消息级模型字段，本轮只能省略该原因，代码注释标注）；
    provider 从未报告缓存 → 不计数。
  - cost 差额：`missedTokens × (paidPerToken − readPerToken)`，均取自
    消息自带 `usage.cost`；无 cost 数据时只报 tokens。
  - `detectCacheMiss(entries, message)`：回合末（message 未落盘）检测，
    对齐 pi 契约。
- **回合末提示**：
  - `ui-events.ts`：`TurnEndEvent` 加 `cacheMiss?` 字段。
  - `agent-loop.ts`：正常 turnEnd emit 处计算并携带；无 uiEvents（REPL/
    --mode json）→ `console.log` 同文案。
  - `app.ts`：`finishAssistantTurn` 处理 cacheMiss → 渲染 dim 系统消息。
- **提示文案**（对齐 pi 语气）：`cache miss: {tokens} tokens re-billed
  (~${cost}){（idle >5min：可能原因）}`。

### 3.3 测试面（阶段 1）

| 文件 | 用例 |
|---|---|
| `src/cache-stats.test.ts`（新） | 相邻 miss 计算；idle>5min 标记；噪声<1024 忽略；compaction 重置；无缓存 provider 忽略；cost 差额；detectCacheMiss 未落盘契约 |
| `src/settings` 测试 | compaction 键解析默认值 + 自定义覆盖 |
| `src/compact.test.ts` | 新文案断言；阈值函数（window-driven，mock contextWindow） |
| `src/agent-loop-integration.test.ts` | L4 触发改 window 驱动后超限场景；turnEnd 带 cacheMiss；console 提示 |
| `src/tui/app.test.ts` | turnEnd cacheMiss → 渲染系统消息 |

### 3.4 验收

- typecheck 干净；全量测试通过（parity python3 环境失败除外，已知）；
- settings `compaction.enabled=false` 时 L4 不触发；
- 老会话（无 usage 字段）scan 不崩、不误报；
- REPL 与 TUI 均能看到 miss 提示。

## 三点五、CC 源码取证结论（2025-08-25，npm 1.0.40 = 最后 JS 版本）

> 来源：registry.npmjs.org 官方历史产物 claude-code-1.0.40.tgz（21MB 实际 56MB，
> `cli.js` 7.6MB minified 但可读）；取证物保存 `~/.cache/cc-forensics/`。
> **版本标注**：1.0.40（2025-05）；CC 自 1.1.x 转 native 二进制，2.x 行为
> 无法直接验证（1.0.40 与 2.x 的文案差异已在 zM2 vs pi 文案中观察到）。

### A. auto-compact 触发（L4 实证，对应 cpi 阶段 1）

```
LA1=0.92, Xw5=0.6, Vw5=0.8          // 触发/警告/错误 系数
jM2() = TM2 - PAA(model)            // 有效窗口 = 200_000 - maxOutput 预留
PAA: "3-5"/"haiku"→8192，CLAUDE_CODE_MAX_OUTPUT_TOKENS env，默认 32000
kE(messages) = 尾部向前第一条带 usage 的 assistant 的
               (input + cache_creation + cache_read + output)   // 真实 usage，非字符估算
触发 = autoCompactEnabled && kE ≥ 0.92 × (200K − 预留)
警告 = kE ≥ 0.6×窗口；错误 = kE ≥ 0.8×窗口（percentLeft 显示）
```

- 与阶段 1 实现（pi 式 `window − reserveTokens=16384`）对照：1M 窗口下
  pi 式 ≈ 98.4% 触发 vs CC 92%；128K 下 pi 式 ≈ 87.2% vs CC 92%。
  阶段 1 保持 pi 式（可配置），CC 式系数 0.92 作为 settings 备选（阶段 2 评估）。

### B. 压缩执行（L4 实证）

- 摘要输出预算 `PM2 = 20000`；专用摘要 system prompt；
  失败分类 `no_summary / api_error / prompt_too_long` →
  `"Conversation too long. Press esc to go up a few messages and try again."`
  （对照 cpi `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 12000` —— 备选对齐 20000）
- 压缩后 = summary user 消息（`isCompactSummary` 标记，UI 特殊渲染）
  + 保留最近内容（**CC 保留的是"已读文件内容" readFileState，不是消息 tail**
  ——与 pi/cpi 的 retainedTail 均不同）
- 文案（1.0.40）：`"This session is being continued from a previous
  conversation that ran out of context. The conversation is summarized
  below: {summary}"`＋auto 时追加"Please continue..."；**pi（及更新版 CC）
  文案为 "The conversation history before this point was compacted into
  the following summary:"——阶段 1 已采用后者（Q4 共识），1.0.40 文案留档**

### C. tool result 超长处理（L2/L3 实证）

```
Y_6 = 30000（BASH_MAX_OUTPUT_LENGTH env 覆盖）
输出 > 30K 字符 → slice(0, 30000) + "... [N lines truncated] ..."（就地截断）
```

- **CC 无"旧结果占位回写"（L2 microCompact 无对应物）**
- **CC 无按条数裁剪（L1 snip 无对应物）**
- **CC 无尾部总预算（L3 的 BUDGET_MAX_TOKENS=120K 无对应物）**——只按单条截断

## 四、阶段 2（暂缓）：L1/L2/L3 向 CC 对齐

**触发条件**：CC 事实基础齐备（见研究笔记第三节证据链），单独会话处理。

### 4.1 候选改动（已由 1.0.40 源码实证校准）

- **L1 snip（按条数裁剪）**：CC 无此机制（实证 C）→ 候选：**移除**
  `MAX_NUM_MESSAGES` 裁剪（或降级为 L4 禁用时的崩溃兜底，实施时定）。
- **L2 microCompact（旧 result 占位）**：CC 无每轮回写（实证 C）→ 候选：
  **移除**；超长结果改为**产生时**就地截断（CC 30K 风格）+ cpi 已有
  `persistLargeOutput` 落盘/预览保留（阈值域：CC 30K / pi 落盘引用模式，
  具体默认值实施时烤）。
- **L3 toolResultBudget（尾部总预算 120K）**：CC 无总预算（实证 C）→
  候选：**移除总预算**，只保留单条截断；`BUDGET_MAX_TOKENS`/`PREVIEW_TOKENS`
  一并评估。
- **上下文估算口径（新增建议）**：CC/pi 触发用**真实 usage**（最近 assistant
  消息 kE）而非字符估算 → 候选：cpi 的 L4 触发改用 usage 口径
  （`session` 带 usage 时），字符估算兜底——触发精度实质提升。
- **摘要输出预算**：cpi 12000 vs CC 20000（实证 B）→ 候选对齐 20000。
- **L4 tail 预算化**：`slice(-5)` → `keepRecentTokens`（pi 默认 20000 token）；
  CC 是保留已读文件（readFileState），与两者不同，不采纳 CC 形式。

### 4.2 证据链（已升级）

1. ✅ **CC 1.0.40 源码级**（npm 官方历史产物，minified 可读——本文件
   三点五节 A/B/C 全部为源码直接取证；证据物 `~/.cache/cc-forensics/`）
   ——注意 1.0.40 与现版 2.x 的行为差异（文案已证有差异，触发系数未证）；
2. ✅ pi 语义（本地安装包可读：`DEFAULT_COMPACTION_SETTINGS`、
   `shouldCompact`、compaction 消息形式）；
3. ✅ 官方文档级（`docs/research/claude-code-error-recovery.md` B1/B2/B6）：
   与 1.0.40 实证互相印证（autoCompactEnabled 默认开、窗口 200K、
   `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` ↔ LA1=0.92）；
4. ⚠️ 社区观测（"Earlier tool result compacted" 为 CC 2.x UI 文案，
   1.0.40 无此字符串——差异已记录，L2 移除决策不受影响）。

### 4.3 风险

- CC 未开源，任何"对齐"都只能做到语义层，参数精确值不可考 → 以
  pi/工程默认为主，注释标注 `CC 未公开：取 pi 语义`。
- L2 移除后上下文增长更快到达 L4 线——需评估触发频率（L4 每触发一次
  就是一次全量摘要成本）；保留"单条超长落盘"作为压力阀。
- 阶段 2 改动面大（涉及 compact.ts 核心 + agent-loop 调用顺序 + 大量
  既有测试），必须独立会话 + 独立提交。

## 五、提交与地图

- 阶段 1 完成后：独立提交（feat 前缀）；地图更新
  （wayfinder engineering-hazards 或新建 cache 优化条目）。
- 阶段 2 开工前：先确认 4.1 候选改动与证据链的最新结论。