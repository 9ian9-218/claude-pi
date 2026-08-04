# 并发模型：async-first 单进程，不镜像 Python 线程

Python 版用线程实现队友 loop、轮询器、后台任务看门狗、线程级工作目录（threading.local）与输出互斥锁。claude-pi 不引入 worker_threads 镜像线程，而是 **async-first 单进程**：agent loop 是纯 I/O 等待（await LLM / await 子进程），协程天然并发；轮询用 setInterval；工作目录隔离用 **AsyncLocalStorage**（语义等价 threading.local）；跨 loop 输出用串行化输出队列（等价 console_lock）；邮箱文件锁用 proper-lockfile（等价 fcntl 语义，pi 同款）。

**Considered Options**: worker_threads 严格镜像线程——被否决：Python 线程同样受 GIL 限制，机制等价（并发隔离 + 有序输出）而非实现等价才是移植目标，且 worker_threads 会复杂化共享状态。

**Consequences**: 行为等价靠对拍测试保证；CPU 密集工具结果（如图像处理）若成为瓶颈，再单独引入 worker_threads。
