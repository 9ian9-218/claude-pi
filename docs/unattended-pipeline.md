# 无人值守 Coding Pipeline

支持目标是 Linux、已初始化的 Git 仓库、已准备好的依赖与可运行的 bubblewrap。项目的独立验收入口必须受控。缺少隔离、验收证据或模型预算时，任务阻断并保留产物，不退回可信 shell、不宣称完成。

## 使用

开启 cpi --team-mode pipeline。Lead 用 run_pipeline(goal) 执行写入任务；delegate(role="worker", task=...) 接入同一流程。Scout/Planner 可按复杂度选用。Reviewer 独立检查冻结候选；Verifier 是受限角色下的确定性验收执行器，不由模型自行选择成功标准。

有原始 npm test 的项目自动使用原测试与 typecheck。其他项目须由用户配置 .agent/pipeline.json：

    {
      "maxRepairs": 2,
      "commands": [
        {
          "command": "python3 -m pytest",
          "requirement": "独立验收和原有回归全部通过",
          "kind": "test",
          "minTests": 12
        }
      ]
    }

验收配置在任务开始时冻结。原始测试、包与依赖入口等受保护；可以增加业务测试，不能用改写独立验收来让自己的实现通过。原有回归测试不等于新需求已被完整覆盖；工业任务应配置针对需求的独立验收。不能解析测试数量、零测试、命令失败、Reviewer BLOCK、候选变化都不会通过准入。

## 生命周期与恢复

Worker -> 冻结候选 -> Reviewer + 独立验证 -> 版本一致的准入 -> 集成 -> 集成后复验 -> completed。

失败检查至多触发 maxRepairs 次修复；每次修复使旧证据失效。测试环境故障直接 blocked。产物与 worktree 保留，主工作区的冲突不会被覆盖。流水线未完成时，Lead 即使宣称完成，公共 RunResult 也返回 error，CLI 非零退出。实际业务完成仍须检查工具返回的 pipeline status=completed；一般 Agent Loop 的成功不代表任意业务正确性。

记录位于 .agent/pipelines/pipeline-<UUID>.json。通过 run_pipeline(goal="", pipeline_id="<ID>") 恢复；原目标与验收计划不会由恢复参数替换。仍存活的协调者不允许被接管。文件集成事务在应用前记录恢复 ID；未结束事务恢复，完成但未确认的集成重新验收，复验失败使用原检查点回退。检测到用户后续编辑时保留冲突并阻断，未知的活进程也不凭旧 PID 盲目终止。

任务取消会停止模型/工具执行，并保留候选。原文件事务及审计记录保留。数据库、部署等外部副作用不属于此流程；pipeline Lead 默认拒绝自由组队、通用可写 subagent 和未声明的外部工具。

## Teammate 与消息

Free Swarm 队友使用独立持久会话，成员记录 owner 信息；仅可核验的已退出进程才允许同名恢复。旧格式且无法核验的活动成员需人工处理。

shutdown_teammate 的 force=true 取消当前工作并等待结束；默认仍是 graceful shutdown。权限等待与空闲等待可取消。

消息按稳定 ID 确认，仅 ACK 已消费的消息；Lead 会话写入后才 ACK，重投递按会话中的 delivery marker 去重。损坏邮箱保留现场并拒绝继续写，单消息与积压受限。显式 --no-session 不提供会话重启恢复；无人值守使用默认持久会话。

## 验证范围

回归包含：越权路径、无凭证禁止集成、过期证据、验收篡改、有限修复、嵌套 worktree、事务回退和用户冲突、消息并发/重投、真实只读沙箱执行。

CI 必须探测成功的 Linux bubblewrap，并跑类型检查、全量回归、三次故障评测及生产包安装。没有实际业务分布的大规模评测，不能承诺任意任务的成功率或通用工业认证。上线应按任务类别、风险及允许人工介入率设 SLO，并保留失败与全部修复记录。
