# 18 — 全链路冒烟

> **⚠️ 范围变更（2026-09-23，ADR-0010）**：claude-pi 为独立项目，**"与 Python 版逐场景对拍"
> 不再是验收目标**。本工单重切为：
> **保留** —— mock OpenAI 全链路 CI 冒烟（hook→tool→compact→recovery）与"差异裁决/记录"机制；
> **移除**（2026-09-23 已执行）—— 场景集里"必须与 Python 版输出一致"的判定；
> 对拍工具链 `tests/parity.test.ts` + `scripts/parity/parity-runner.ts` 已删除。
> `Blocked by` 中的 "04 上下文压缩 L1–L3" 亦已部分废止（L1/L2 不实现），依赖需重新评估。

**What to build:** 全链路机器可执行验证：mock OpenAI 驱动的场景集（对话、工具调用、错误恢复、压缩、记忆、后台任务）跑通 CI 冒烟（hook→tool→compact→recovery）；用例断言以本仓行为为准；"真回归 vs 已批准变更"的差异记录流程。

**Blocked by:** 13 运行模式, 03 错误恢复, 04 上下文压缩 L1–L3, 05 记忆, 06 后台任务

**Status:** ready-for-agent

- [ ] 场景集在 mock OpenAI 下一键跑通（对话/工具/恢复/压缩/记忆/后台）
- [ ] 差异裁决记录入库（docs 或脚本旁），已批准变更可豁免
- [ ] mock OpenAI 全链路冒烟在 CI 可跑（无真实 key）
