# 18 — 对拍 + 全链路冒烟

**What to build:** "机制不变"的机器可执行验证：对拍脚本（同一场景脚本驱动 Python 版与 claude-pi --mode json，规范化时间戳/随机字段后比对）；场景集：对话、工具调用、错误恢复、压缩、记忆、后台任务；mock OpenAI 全链路 CI 冒烟（hook→tool→compact→recovery）；差异裁决流程（真回归 vs 已批准变更，逐条记录）。

**Blocked by:** 13 运行模式, 03 错误恢复, 04 上下文压缩 L1–L3, 05 记忆, 06 后台任务

**Status:** ready-for-agent

- [ ] 对拍脚本可一键运行，输出规范化后逐场景比对
- [ ] 核心场景（对话/工具/恢复/压缩/记忆/后台）对拍零差异
- [ ] 差异裁决记录入库（docs 或脚本旁），已批准变更可豁免
- [ ] mock OpenAI 全链路冒烟在 CI 可跑（无真实 key）
