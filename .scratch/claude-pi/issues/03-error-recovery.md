# 03 — 错误恢复

**What to build:** LLM 调用失败时 agent 不崩、可自愈：finish_reason=length 时升级 max_tokens 续写；429/529 指数退避 + jitter；连续失败后切换 fallback 模型。行为与 Python 版逐参数对齐（退避参数、升级阈值、切换规则）。

**Blocked by:** 02a 对话闭环

**Status:** ready-for-agent

- [ ] mock 返回 429 序列时按参数退避并最终成功，日志可见
- [ ] finish_reason=length 触发 max_tokens 升级续写
- [ ] 连续失败后切换到 fallback 模型（env 同名配置）
- [ ] 恢复路径的 vitest 测试绿灯
