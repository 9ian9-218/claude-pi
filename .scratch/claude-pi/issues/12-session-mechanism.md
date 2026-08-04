# 12 — 会话机制

**What to build:** 树形会话与断线恢复：自实现 session-manager（JSONL 树、id/parentId、原地分支、buildSessionContext 从 leaf 回溯、fork/clone/resume、compaction entry 含 retainedTail、branch_summary、model_change/session_info/label/custom 子集，格式形状同 pi v3、版本自管）。Agent Loop 改为经会话读写（L4 迁移为 compaction entry 写入）；CLI 支持 -c / -r / --session / --fork / --no-session；崩溃后 resume 从 leaf 重建上下文。

**Blocked by:** 02a 对话闭环, 04 上下文压缩 L1–L3

**Status:** ready-for-agent

- [ ] 会话落盘 .agent/sessions/（--<path>-- 按 cwd 组织），格式形状同 pi v3
- [ ] /fork /clone /resume（文件级）语义正确，血缘 parentSession 记录
- [ ] 分支与 branch_summary 生成正确，上下文从新 leaf 重建
- [ ] L4 压缩写 compaction entry（retainedTail），压缩后上下文可重建
- [ ] 崩溃演练：kill 进程 → -c 恢复 → 上下文与崩溃前一致
- [ ] 树操作（分支/切回/fork/clone/压缩检查点）的 vitest 测试绿灯
