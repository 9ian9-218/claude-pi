# 06 — 后台任务

**What to build:** 长耗时 bash 后台化：run_bash(background:true) 启动子进程，stall 看门狗监测输出停滞与键盘等待模式（正则与 Python 版一致），完成后结果以 task_notification 注入上下文并可见；kill_bg_task 可终止。超时与看门狗参数对齐 Python 版。

**Blocked by:** 02b 工具闭环

**Status:** ready-for-agent

- [ ] 后台命令运行时 REPL 不被阻塞
- [ ] 完成通知注入上下文并显示
- [ ] 停滞/等待输入模式被看门狗识别并通知
- [ ] kill_bg_task 可终止后台任务
- [ ] 看门狗与通知的 vitest 测试绿灯
