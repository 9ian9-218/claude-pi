# 运行模式：显式模式（交互 TUI / -p 打印 / --mode json），无自动回退

Python 版是裸 `input()` REPL，天然支持管道。claude-pi 效仿 pi 的四模式设计：默认交互 TUI、`-p` 一次性打印（管道 stdin 合并进首轮提示）、`--mode json` 结构化输出（脚本与对拍测试接口）；**不做 TTY 自动检测回退**。

**Considered Options**: TTY 检测 + 自动回退行式 REPL——被否决：回退路径会成为永久的第二套 UI 需要维护，而显式模式把"人机交互"与"程序驱动"彻底分开，脚本场景用 `-p`/`--mode json` 更明确。

**Consequences**: 交互命令集随之重新定义（/new 从"清空内存 messages"变为"开新会话"）；REPL 不再作为交互界面存在，但 `--mode json` 成为对拍测试的驱动接口。
