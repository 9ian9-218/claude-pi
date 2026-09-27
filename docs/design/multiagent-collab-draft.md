# claude-pi 多代理协同架构草案：双模共存与固定研发预设（v0.2）

> **设计基调与用户决策锁定**：
> 1. **保留原有的自由组队（Free Swarm）**：保留其作为底层开放式多代理能力，支持自由命名角色、自由通信与任务看板认领；
> 2. **引入固定研发协同预设（Coding Pipeline Preset）**：用户可一键切换或配置此预设，专为代码编写任务设计，提供高确定性、职责分明、契约标准的协同流水线；
> 3. **固定编制为 1 主 + 5 专职 Agent**：原 Reviewer 拆分为**「静态审查员（Reviewer）」**与**「动态验证员（Verifier）」**，形成静态质量与动态测试的双重防线。

---

## 1. 架构定位：双模共存体系

claude-pi 的多代理系统设计为“分层双模”：

```
+---------------------------------------------------------------------------------+
|                                 用户交互面 (CLI / TUI)                           |
|       切换入口: cpi --team-mode <free|pipeline> 或 TUI 命令 /team-mode          |
+---------------------------------------+-----------------------------------------+
                                        |
        +-------------------------------+-------------------------------+
        |                                                               |
        v                                                               v
[ 模式 A: 自由组队 (Free Swarm) ]                     [ 模式 B: 固定研发预设 (Coding Pipeline) ]
- 现有能力全量保留                                     - 1 个主调度 Agent (Lead)
- create_team / spawn_teammate 自由命名角色           - 5 个固定专职角色 (Scout, Planner, Worker, Reviewer, Verifier)
- 开放式文件邮箱与广播                                - 任务信封 + 标准交付物契约 + 工具面白名单
- 任务看板 (Task Board) 声明与认领                    - 星形拓扑流转、自动化质量审查闭环 (Review-Fix Loop)
        |                                                               |
        +-------------------------------+-------------------------------+
                                        |
                                        v
                    [ 底层公共运行时与基建 (Shared Runtime) ]
                    - 进程隔离 / 协程 Loop (spawn.ts)
                    - 身份上下文 ALS (teammates/context.ts)
                    - 权限门控与冒泡通道 (permission-sync.ts)
                    - 结构化通信协议与文件邮箱 (mailbox.ts / protocol.ts)
                    - 工作区与 Git 隔离支持 (worktree.ts)
```

### 1.1 模式切换与持久化配置
- **配置文件持久化**：在 `~/.claude-pi/settings.json` 或项目级 `.claude-pi/settings.json` 中配置：
  ```json
  {
    "team": {
      "mode": "pipeline", // "pipeline" (推荐预设) | "free" (自由组队)
      "pipeline": {
        "auto_review": true,
        "max_repair_rounds": 2,
        "parallel_scout": true
      }
    }
  }
  ```
- **运行时无缝切换**：
  - **CLI 参数**：`cpi --team-mode pipeline` 或 `cpi --team-mode free`；
  - **TUI 斜杠命令**：`/team-mode pipeline` 或 `/team-mode free`，输入 `/team-mode` 查看当前模式状态。

---

## 2. 固定研发预设编制：1 主 + 5 专职 Agent

在固定预设下，团队编制收敛为 **1 个全局协调者（Lead） + 5 个专注单一职责的专家 Agent**：

| 角色代码 | 中文定位 | 核心职责 | 工具面白名单 (Hard Allowlist) | 写入权限 | 交付契约类型 |
|---|---|---|---|---|---|
| **lead** | 主调度 / 架构师 | 用户唯一直接交互面；任务剖析、派发信封、审批异常、合流交付 | 全量工具 | 允许 | 用户级解答 / 变更总结 |
| **scout** | 侦察员 | 快速定位代码位置、摸清依赖关系与调用链，提炼最小上下文包 | `read_file`, `grep`, `find_files`, `list_dir`, `view_outline` + 只读 bash | **严禁写文件** | `ScoutContextPackage` (行号/核心接口/架构摘要) |
| **planner** | 规划师 | 基于侦察上下文，制定原子化施工步骤、识别潜在技术风险与验收标准 | `read_file`, `grep`, `find_files`, `list_dir` | **严禁写文件** | `ImplementationPlan` (目标/分步改动/风险/测试点) |
| **worker** | 实现员 | 专注按规划单点实现业务逻辑与修改代码，严守规划不擅自扩充范围 | `read_file`, `edit_file`, `write_file`, `grep`, `find_files`, `list_dir`, `bash` | **允许修改** | `ChangeReport` (改动文件/影响函数/自测记录) |
| **reviewer** | 静态审查员 *(拆分项1)* | **静态白盒审查**：审查代码风格、坏味道、潜在并发/逻辑空洞、Spec 与架构一致性、安全性 | `read_file`, `grep`, `find_files`, `list_dir` + 只读受控 bash (`git diff`, `git log`) | **严禁写文件** | `ReviewVerdict` (Critical/Warnings/Suggestions + 合格裁决) |
| **verifier** | 动态验证员 *(拆分项2)* | **动态黑盒/白盒验证**：运行构建、单元测试、Linter、类型检查，构造边界用例复现验证 | `read_file`, `grep`, `find_files` + 受控执行 bash (构建/测试命令，如 `vitest`, `npm test`) | **严禁修改业务代码** (允许临时测试产物) | `VerificationReport` (测试日志/覆盖率/通过率/复现断言) |

### 2.1 审查与验证分离（Reviewer 拆成两个的核心价值）
1. **职责彻底解耦**：Reviewer 关注“代码写得好不好、规不规范、架构是否走偏”；Verifier 关注“代码能不能编过、测试能不能跑通、功能有没有回归”。
2. **权限与安全硬隔离**：Reviewer 完全不需要执行权限（纯只读，防注入）；Verifier 需要执行测试脚本（受控 Bash），但绝对不允许它修改源文件。
3. **结果判定客观化**：Verifier 的输出是确定性的 Exit Code、失败堆栈和覆盖率报告，避免了单纯由大模型“肉眼审查”放过隐蔽运行时 Bug 的弊端。

---

## 3. 标准交付物契约（Markdown 格式规范）

各个子角色之间严禁散乱文本交流，必须输出契约规定的 Markdown 格式：

### 3.1 Scout 产出：`ScoutContextPackage`
```markdown
## Context Overview
一句话总结要解决问题的代码分布与调用入口。

## Files Located
- `src/foo.ts:45-80` - 核心调用入口
- `src/bar.ts:120-160` - 状态转换处理

## Key Code & Interfaces
```typescript
interface StateMachine { ... }
```

## Dependencies & Traps
调用时的约束、坑点、或相关的测试文件路径。
```

### 3.2 Planner 产出：`ImplementationPlan`
```markdown
## Goal & Scope
明确要实现的功能与不可触碰的边界。

## Step-by-Step Plan
1. `src/bar.ts`: 修改 `handleEvent`，加入状态保护
2. `src/foo.ts`: 引入新参数并向下透传
3. `tests/foo.test.ts`: 新增异常边界用例

## Risks & Edge Cases
可能引发回归或需要提前注意的技术风险。

## Acceptance Criteria
- [ ] `npm run typecheck` 无报错
- [ ] 新增测试用例 `tests/foo.test.ts` 通过
```

### 3.3 Worker 产出：`ChangeReport`
```markdown
## Completed Work
对计划步骤的实际落地情况简述。

## Files Changed
- `src/bar.ts` - 增加状态判断
- `src/foo.ts` - 透传参数
- `tests/foo.test.ts` - 补充测试

## Implementation Notes
说明与原计划微调的地方及原因。
```

### 3.4 Reviewer 产出：`ReviewVerdict`
```markdown
## Review Summary
代码质量与规范综合评价（2-3句话）。

## Findings
- **[CRITICAL]** `src/bar.ts:135` 缺少判空，当 context 为 null 时会抛异常
- **[WARNING]** `src/foo.ts:52` 命名建议与现有风格保持一致
- **[SUGGESTION]** 抽离重复常量

## Verdict
[PASS] 或 [BLOCK] (只要有 CRITICAL 项必须为 BLOCK)
```

### 3.5 Verifier 产出：`VerificationReport`
```markdown
## Verification Summary
测试与构建执行汇总。

## Commands Executed
- `npm run typecheck`: SUCCESS
- `npm test tests/foo.test.ts`: 4 passed, 1 failed

## Failure Details (若有)
测试断言失败堆栈、未捕获异常或类型错误。

## Verdict
[PASS] 或 [BLOCK]
```

---

## 4. 协同调度拓扑与流转工作流

### 4.1 任务信封 (Task Envelope)
主调度 Agent 派发任务时不传杂乱历史，而是组装成标准信封：
```typescript
interface TaskEnvelope {
  taskId: string;
  role: "scout" | "planner" | "worker" | "reviewer" | "verifier";
  taskGoal: string;
  contextPackages?: string[];   // 上游产出的引用或压缩包
  constraints?: string[];       // 限制（如“不引入新外部依赖”）
  budget: {
    maxTurns: number;           // 轮数上限（如 scout=10, worker=25）
    maxTokens: number;          // 输出 token 预算
    timeoutMs: number;          // 墙钟超时
  };
}
```

### 4.2 典型工作流编排

#### 流水线 1：完整工程实现流水线 (`full-implement`)
适用于中大型功能、重构或 Bug 修复：
```
[User Request]
       |
       v
   (Lead 主调度)
       |
       |-- 1. 派发探测信封 ---> [ Scout 侦察员 ]
       |                            |
       |<-- 交付 ScoutContextPackage --+
       |
       |-- 2. 派发规划信封 ---> [ Planner 规划师 ]
       |                            |
       |<-- 交付 ImplementationPlan --+
       |
       |-- 3. 派发实现信封 ---> [ Worker 实干员 ]
       |                            |
       |<-- 交付 ChangeReport --------+
       |
       +---------------------------------------------+
       | 并行或顺序启动双重质检                       |
       |                                             |
       |-- 4. 静态审查信封 ---> [ Reviewer 审查员 ]  |
       |                            |                |
       |<-- 交付 ReviewVerdict -----+                |
       |                                             |
       |-- 5. 动态验证信封 ---> [ Verifier 验证员 ]  |
       |                            |                |
       |<-- 交付 VerificationReport +                |
       +---------------------------------------------+
       |
  [综合裁决]
  - 若 Reviewer & Verifier 均通过 (PASS) --> Lead 合流并向用户交付成果
  - 若任一角色不通过 (BLOCK) ------------> 触发自动修复闭环 (Review-Fix Loop)
```

#### 流水线 2：自动修复闭环 (Review-Fix Loop)
- 当 Reviewer 指出 `[CRITICAL]` 或 Verifier 测试未通过时，Lead 不打扰用户，自动打包错误信息给 Worker：
  - Worker 接收信封 `{ 任务目标, 原代码变更, Review 阻断意见, Verifier 报错堆栈 }`；
  - Worker 执行修复并提交新的 `ChangeReport`；
  - 重新触发 Reviewer / Verifier 验收（默认重试上限为 2 轮，超限则上报用户裁决）。

#### 流水线 3：单角色即时调遣 (On-Demand Dispatch)
用户在日常交互中常有局部需求，Lead 无需每次跑完整流程，可单独调遣专职 Agent：
- “帮我调研一下这几个模块怎么关联的” -> 单独派发给 **Scout**；
- “针对现有未提交改动做一个代码审查” -> 单独派发给 **Reviewer**；
- “跑一下相关的测试并验证有没有性能/逻辑问题” -> 单独派发给 **Verifier**。

---

## 5. 代码库映射改造方案（与现状衔接）

本方案完全基于现有代码渐进增强，不破坏既有机制：

### 5.1 身份与选项适配 (`src/agent-profile.ts` / `src/loop-options.ts`)
- 在 `AgentProfile` 中将 `role` 扩展为联合类型：
  `export type AgentRole = "lead" | "teammate" | "subagent" | "scout" | "planner" | "worker" | "reviewer" | "verifier";`
- 5 个专职角色从 `defaultsFor(role)` 中派生出各自专有的 Profile 配置（包括 `quietOutput`, `exitOnFinalContent`, `enableMemory=false`, 以及硬编码的工具白名单）。

### 5.2 工具集白名单化 (`src/tools/runtime.ts`)
- 将原本一刀切的 `SUBAGENT_EXCLUDED` 黑名单，改造成按角色鉴权的白名单矩阵：
  ```typescript
  const ROLE_TOOL_PERMISSIONS: Record<AgentRole, { allow: string[]; isReadOnly: boolean }> = {
    lead: { allow: ["*"], isReadOnly: false },
    teammate: { allow: ["*"], isReadOnly: false }, // 自由组队保持原样
    subagent: { allow: ["*"], isReadOnly: false }, // 兼容旧接口
    scout: { allow: ["read_file", "grep", "find_files", "list_dir", "view_outline", "bash_readonly"], isReadOnly: true },
    planner: { allow: ["read_file", "grep", "find_files", "list_dir"], isReadOnly: true },
    worker: { allow: ["read_file", "edit_file", "write_file", "grep", "find_files", "list_dir", "bash", "background_task"], isReadOnly: false },
    reviewer: { allow: ["read_file", "grep", "find_files", "list_dir", "git_diff", "git_log"], isReadOnly: true },
    verifier: { allow: ["read_file", "grep", "find_files", "list_dir", "bash_test_runner"], isReadOnly: true },
  };
  ```

### 5.3 提示词与模板独立 (`src/prompt.ts`)
- 保持 `AGENT_IDENTITY` 供主 Agent 使用；
- 为 5 个角色分别编写对应的系统提示词与输出规范，格式化注入 `{workspace}` 与契约要求。

### 5.4 调度入口收敛 (`src/tools/agent-tools.ts`)
- 在 **自由组队模式** 下：保留 `create_team`, `spawn_teammate`, `send_message`, `list_teammates`, `shutdown_teammate` 等工具；
- 在 **固定预设模式** 下：
  - 隐藏自由组队的创建/邮箱工具（防止模型幻觉）；
  - 暴露高阶派发工具：
    - `delegate(role: "scout"|"planner"|"worker"|"reviewer"|"verifier", task: string, context?: string)`
    - `run_pipeline(pipeline: "implement"|"review_and_verify", goal: string)`

---

## 6. 实施路线图（分步演进）

- **Step 1（P0，轻量验证，约半天）**：
  - 在 `src/agent-profile.ts` 与 `src/prompt.ts` 中注册 5 个专职角色及提示词/契约模板；
  - 在 `src/tools/agent-tools.ts` 中保留原有工具，给 `subagent_task` 增加可选 `role` 参数；
  - 跑通手动测试，验证各个角色的回答是否严守格式契约。
- **Step 2（P1，权限与硬隔离，约 1-2 天）**：
  - 实施 `ROLE_TOOL_PERMISSIONS` 运行时硬白名单过滤，为 Verifier 和 Reviewer 建立命令过滤保护；
  - 编写越权测试用例（如验证 Planner/Reviewer 调用写文件必被拦截）；
  - 加入 `--team-mode` 切换开关。
- **Step 3（P2，流水线编排与自动闭环，约 2 天）**：
  - 实现 Lead 的 Pipeline 自动流转器（Scout -> Planner -> Worker -> Reviewer + Verifier）；
  - 实现 Review-Fix 自动纠错重试机制；
  - 对齐 TUI 渲染中的各角色状态卡片。