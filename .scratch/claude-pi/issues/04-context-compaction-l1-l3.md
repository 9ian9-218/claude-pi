# 04 — 上下文压缩 L1–L3

**What to build:** 长对话下上下文可控：L3 Budget（超大工具结果落盘、上下文留预览）、L1 Snip（裁剪中间消息）、L2 Micro（旧工具结果换占位符）、prompt_too_long 反应式压缩后重试（一次）。触发阈值与 Python 版一致（消息数、token 量）。L4 不在此工单——它需要会话树机制（见 12），届时迁移为 compaction entry。

**Blocked by:** 02a 对话闭环

**Status:** ready-for-agent

- [ ] L3：超大工具结果落盘且上下文仅保留预览，预览可读回
- [ ] L1：消息数超阈值后中间消息被裁剪且对话仍正确
- [ ] L2：旧工具结果替换占位符，触发时机一致
- [ ] prompt_too_long 触发反应式压缩并重试一次成功
- [ ] 压缩行为对拍测试场景就绪（与 Python 版同输入同输出）
