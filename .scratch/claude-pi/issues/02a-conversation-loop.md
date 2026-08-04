# 02a — 对话闭环（tracer bullet）

**What to build:** 第一个端到端垂直切片：用户输入一句话，agent 流式回复，全程可见。包括：配置与 .env 加载（沿用 Python 版变量名）、openai SDK 流式客户端（裸消息结构）、系统提示组装、Agent Loop 骨架（回合上限、finish_reason 处理）、Hook 注册表（UserPromptSubmit / Stop 及内置 hook）、占位行式 REPL（交互面临时壳）、mock OpenAI 服务器（固定流式响应，CI 可跑）。对话在终端可见可演示。

**Blocked by:** 01 仓库骨架

**Status:** ready-for-agent

- [ ] REPL 中输入任意文本，agent 流式回复完整可见
- [ ] `q`/`exit`/`/new` 等既有交互命令行为与 Python 版一致
- [ ] mock OpenAI 服务器驱动下，vitest 全链路测试绿灯（含流式、finish_reason=stop）
- [ ] 系统提示、消息结构与 Python 版逐字段对齐（对拍基础）
