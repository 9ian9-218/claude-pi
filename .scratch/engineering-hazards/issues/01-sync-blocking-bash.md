---
title: "研究：run_bash 同步执行阻塞整个事件循环"
labels: ["wayfinder:research"]
parent: ../map.md
---

## Question

`run_bash` 用 `spawnSync`（120s 超时、16MB buffer）——同步子进程会**阻塞 Node 事件循环**。
实证以下影响面并给出结论：

1. bash 执行期间 TUI 渲染/输入、流式输出、teammates 收件箱轮询、后台任务、权限弹窗是否全部冻结？
2. Esc 中断在 bash 执行期间是否无效（`signal` 检查只在工具循环顶部）？超时后 `spawnSync` 杀子进程，孙进程（`&` 后台、daemon）是否存活（无进程组终止）？
3. 对比：pi 的异步实现、Python 原版的 subprocess 方案；改为异步 `spawn` 的侵入面（tool.ts 内还是全链路）。
4. 分发场景下，用户在较大仓库跑 `npm install`/`git grep` 等命令的体感与阻塞时长实测。

结论产出：阻塞面清单 + 修复候选方案与侵入面评估（不实施）。

## ADR 边界

ADR-0002（async-first）明写并发模型是 "await 子进程"——spawnSync 是**实现违背已定设计**，
不是新增哲学。结论请分两出口：
- **哲学内解**：bash 执行异步化（spawn），拉回 ADR-0002 承诺
- **哲学外解**：维持同步阻塞 + 文档声明为已知限制（需要决策票明确接受）

