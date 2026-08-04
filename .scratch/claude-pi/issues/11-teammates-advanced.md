# 11 — Teammates 进阶

**What to build:** 协作协议与自治：权限同步（Teammate 对危险操作发权限请求 → Lead 审批 → 响应回传，轮询间隔对齐）；protocol（结构化 request_id 消息）；autonomous（idle 轮询、任务看板自动 claim、超时与身份再注入阈值对齐 Python 版常量）。

**Blocked by:** 10 Teammates 核心

**Status:** ready-for-agent

- [ ] Teammate 危险操作触发权限请求，Lead 响应后 Teammate 继续/中止
- [ ] 协议消息含 request_id 且可关联请求与响应
- [ ] 自治 Teammate 空闲轮询并自动 claim 看板任务
- [ ] 权限请求全流程（含主线程消费）的 vitest 测试绿灯
