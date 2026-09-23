# CC 源码可获取性调研（L1/L2/L3 对齐的事实基础）

> 会话：grill 缓存命中优化 · 结论：本次网络可通，CC 本体不可读（native binary），
> 官方历史版本有 JS 实现片段；L1/L2/L3 对齐的可行证据链见文末。

## 一、连通性实测（2025-08-25）

| 端点 | 结果 | 备注 |
|---|---|---|
| https://github.com | 200（~12s） | 可达但慢（受限带宽） |
| https://raw.githubusercontent.com | 200（~12s） | 同上 |
| https://registry.npmjs.org | 200（0.8s） | 快，可靠 |
| https://code.claude.com | 000 | 不可达（当前网络） |
| https://docs.anthropic.com | 301 | 可达（重定向） |

## 二、CC 实现本体的可获取性

- **现状（latest 2.1.245）**：`@anthropic-ai/claude-code` npm 包是**安装器**
  （27KB tarball），真实实现为各平台 native binary
  （`@anthropic-ai/claude-code-linux-x64` 等 optionalDependencies，bun 编译产物）
  ——**闭源二进制，不可读**。无"泄露源码"流通于官方渠道，GitHub 逆向仓库需
  慢速网络另行挖掘（github 可达但慢）。
- **历史版本（验证 0.2.9，2024-12）**：tarball 12MB，内含 `cli.mjs`（4.8MB，
  UI/React bundle，变量名压缩）与 `vendor/`（Anthropic SDK、ripgrep）。
  **核心 agent/context 逻辑未暴露**在 cli.mjs 与 vendor 的直接字符串层
  （`compacted into the following summary` 等关键词无命中；变量已 minify）。
- 可用线索：cli.mjs 中 `snipLine`、`truncate` 等工具函数是**前端 UI** 的，
  不能作为上下文管理语义的证据。

## 三、结论与证据链建议（供 L1/L2/L3 会话使用）

CC 阈值/行为的三层证据（按可信度排序）：
1. **官方文档级**（已有 `docs/research/claude-code-error-recovery.md`：B1
   auto-compact 参数、B2 /compact 恢复、B6 /context 预警）；
2. **pi 语义**（CDN 可读：`DEFAULT_COMPACTION_SETTINGS` enabled/reserveTokens
   16384/keepRecentTokens 20000、`shouldCompact` = tokens > window - reserve；
   pi 从不就地改旧消息，压缩只发生在 compaction 边界 + 尾部 tool budget）；
3. **社区观测**（github 慢速可搜；CC 的 "Earlier tool result compacted" 文案
   为社区广泛报告，本次未能从官方包验证——现状版本为二进制）。

**建议**：L1/L2/L3 以 pi 语义为主基准 + 文档级 CC 行为为约束（不引入无从
考证的 CC 私有阈值）；若需更实 CC 数据，可尝试 1.x 中期版本（npm registry
有全部 495 个版本，1.x 是否 JS 需逐一验证）或 github 逆向仓库慢速拉取。

## 四（补）、CC 1.0.40 源码取证成功（2025-08-25）

- 通路：**mihomo 代理（7890）**（用户配置 ~/.config/mihomo，会话内手动启动
  使用、用后即停——未写入任何全局配置/环境变量，不影响其他服务）；
  github 直连 12s 慢、代理 0.65s；registry.npmjs.org 直连快。
- 版本分界：0.2.9(12MB JS) → **1.0.40(56MB JS，最后可读版本)** →
  1.1.1(4KB 安装器占位) → 2.1.x(native 二进制)。
- 证据物：`~/.cache/cc-forensics/cc-1.0.40-cli.js`（7.6MB minified 可读）。
- 核心结论（细节入 `.scratch/cache-hit-plan.md` 三点五节）：
  - 触发 = kE（真实 usage 口径）≥ 0.92 × (200K − maxOutput 预留 32K)；
  - 单条输出 >30K 字符就地截断 + `[N lines truncated]`；
  - 无按条数裁剪、无旧结果回写、无尾部总预算——L1/L2/L3 均无 CC 对应物；
  - 压缩 = summary user 消息(isCompactSummary) + 保留已读文件(readFileState)。
- 注意：1.0.40 与 2.x 存在行为差异（压缩文案已证不同），引用时标注版本。

## 五、本会话落地（grill 共识）

- L4 autocompact：形式向 pi 对齐（文案 `<summary>` 包裹 + window 驱动触发 +
  settings `compaction` 键：enabled / autoCompactPct / keepRecentTokens）
- 诊断：cache-stats 纯函数（idle 5min / 噪声 1024 / compaction 重置）+ 回合末
  提示（TUI turnEnd 事件 + REPL console 双通道）
- L1/L2/L3：L1/L2 判定**移除**（本文件 §三 结论：CC 无按条数裁剪、无旧结果回写；
  且就地改写会破坏缓存前缀）；L3 = 单条输出截断 + 落盘预览，已落地 `finalizeToolOutput`

> **2026-09-23 修正**：阈值/预留/摘要预算改为按模型窗口派生（窗口读不到兜底 256K，
> 预留 = min(模型 maxTokens, 应用单次输出上限 64K, 窗口/2)），`retainedTail` 固定 20K，
> `reserveTokens` 不再是默认值（仅显式覆盖项），手动 `/compact [额外指令]` 已实现。
> 详见 `.scratch/cache-hit-plan.md` 文首修正块；词表见 `CONTEXT.md`。