# 行为等价优先：裸 OpenAI 消息结构 + 数据格式兼容 + 对拍测试

> **修订注记（ADR-0007）**："openai SDK 直操"与"环境变量名与 Python 版完全一致"条款已由 ADR-0007（传输层接入 pi-ai）取代作废；"裸 OpenAI 消息结构 + 数据格式兼容 + 对拍测试"条款继续有效。

移植的第一约束是"所有功能及机制不变"，因此 claude-pi 刻意不采用现代 TS 项目的常见抽象：LLM 客户端用 **openai npm SDK 直操裸消息结构**（`messages` 数组、`tool_calls`、`function.arguments` 字符串、`finish_reason`），而非 Vercel AI SDK 之类的抽象层（引入抽象等于重写主循环/压缩/记忆的全部消息处理）；环境变量名与 Python 版完全一致；`.agent/` 下所有持久化格式（邮箱 JSON 数组、任务 JSON、记忆 Markdown、团队配置）字节级兼容；worktree 分支名 `agent/task-<id>`。等价性由四层测试保证：vitest 移植 + 组件渲染断言 + **对拍测试**（同一场景脚本驱动 Python 版与 `--mode json`，比对输出）+ mock OpenAI 冒烟。

**Considered Options**: Vercel AI SDK / 自研格式 / 全新消息模型——均因破坏可对拍性而被否决。

**Consequences**: 代码形态与 Python 版 1:1 可对照（目录镜像、模块同名）；对拍测试是"机制不变"的机器可执行版本；未来若想升级抽象层，对拍测试就是安全网。
