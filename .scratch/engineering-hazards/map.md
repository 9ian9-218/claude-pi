---
title: "claude-pi 工程隐患排查与修复计划"
labels: ["wayfinder:map"]
---

# 地图：claude-pi 工程隐患排查与修复计划

## Destination

claude-pi（TS Agent 运行时，将分发至 npm install）的工程隐患全部完成**实证研究**，
五张修复决策票由用户**逐张亲自裁决**。走到地图尽头 = 「分发就绪的优先修复计划」定稿：
修什么、优先级、怎么做——全部锁定，**不执行修复**（执行是地图完成后的独立努力）。

## Notes

- **域**：工程隐患评估（claude-pi，TypeScript 类 Claude Code Agent 运行时）
- **技能**：研究票 → `/research`（AFK，agent 独立完成，每会话一张）；决策票 → `/grilling` + `/domain-modeling`（HITL，与用户实时对话）
- **决策模式**：用户逐张亲自裁决，一张票一次对话；agent 不代替用户裁决
- **高权重透镜**：分发场景（npm install）→ 打包、依赖、安全信任、数据卫生权重最高
- **基线文档**：`docs/research/claude-code-error-recovery.md`（CC 对照，决策票输入）
- **ADR 边界约定**：票 01/06/09/10 涉及设计哲学（ADR-0002/0004/0006/0007）——研究结论须分
  「哲学内解 / 哲学外解」两出口；哲学先不重审，是否跨线由决策票裁决时定
- **偏差说明**：本环境无 subagent 工具，研究票由后续工作会话逐张解决（skill 的 "研究票并行" 降级为串行），已在票内注明

## Decisions so far

<!-- 索引：每张已关闭的票一行，一行为一句要点 -->

- [02-session-torn-line](issues/02-session-torn-line.md) — open() 逐行容错，torn line 跳过，恢复不崩溃【已实施】
- [03-session-concurrent-writes](issues/03-session-concurrent-writes.md) — 会话文件锁（pid 存活判 stale）+ 并发时 truncateTo 不重写磁盘【已实施】
- [04-process-crash-surface](issues/04-process-crash-surface.md) — src/fatal.ts 顶层兜底：uncaughtException/unhandledRejection → 提示+退出码 1【已实施】
- [05-distribution-packaging](issues/05-distribution-packaging.md) — tsx 升 dependencies + bin/cpi.js shim（免构建分发）【已实施】
- [07-data-hygiene-transcripts](issues/07-data-hygiene-transcripts.md) — .gitignore 补 .transcripts/；清理保留期留 fog【已实施】

## Not yet specified

- **修复实施**：决策票定稿后的执行方式（何时做、谁做、如何回归验证）——目的地之外，待地图走完后作为新 effort
- **CC 恢复机制对照项**：此前调研的 CC 错误恢复缺失项（流式半途保留、流停滞看门狗、降 max_tokens 重试等）哪些应纳入修复范围——待研究票 08/09 出结论后按需毕业
- **pi-ai 依赖漂移策略**：锁定 0.83.0 vs 跟随上游——研究票 05/11 出结论后可能毕业
- **会话保留与清理策略**：无 30 天清理机制，.transcripts/ 无保留策略——研究票 07 出结论后可能毕业
- **并行会话 UX**：跨进程并发写会话的冲突提示方案——研究票 03 出结论后可能毕业

## Out of scope

（尚无——研究票暴露后由地图维护者裁决）

## 票索引（child issues）

| 票 | 类型 | 阻塞 |
|---|---|---|
| 01-sync-blocking-bash ⚠ADR-0002 | research | — |
| 02-session-torn-line ✅已实施 | research | — |
| 03-session-concurrent-writes ✅已实施 | research | — |
| 04-process-crash-surface ✅已实施 | research | — |
| 05-distribution-packaging ✅已实施 | research | — |
| 06-security-trust-boundaries ⚠ADR-0006 | research | — |
| 07-data-hygiene-transcripts ✅已实施 | research | — |
| 08-headless-robustness | research | — |
| 09-context-cost-control ⚠ADR-0007 | research | — |
| 10-performance-context-rebuild ⚠ADR-0004 | research | — |
| 11-engineering-hygiene | research | — |
| 12-decision-stability | grilling | 01,02,03,04 |
| 13-decision-distribution | grilling | 05,11 |
| 14-decision-security-data | grilling | 06,07 |
| 15-decision-headless-cost | grilling | 08,09 |
| 16-decision-performance | grilling | 10 |