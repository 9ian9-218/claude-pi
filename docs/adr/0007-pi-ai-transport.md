# 传输层接入 pi-ai：多 provider + pi 风格配置面，自实现 loop 保留

主驱动从"与 Python 版逐字节对齐"转向"多 provider + 与 pi 生态对齐"后，ADR-0005 的"openai SDK 直操 + env 变量名对齐"条款不再成立。选定 **`@earendil-works/pi-ai@0.83.0`**（精确锁定，与 pi-tui 同版本）作为唯一 LLM 传输层：`client.ts` 内部改用 pi-ai 的 Models/stream，**对外签名与内部裸 OpenAI JSON 消息结构保留**（agent-loop / session-manager / compact / memory 一行不动）；配置面整体迁移到 pi 风格，**共享 `~/.pi/agent/`**（auth.json / models.json / settings.json）。

**Considered Options**: 保留 env override 通道（OPENAI_MODEL / OPENAI_BASE_URL 双轨）——被否决：配置双源违背"与 pi 一致"，对拍/测试改为程序化注册 provider 即可覆盖；引入 pi-coding-agent / pi-agent-core 全家桶（重试、会话、压缩全换）——被否决：树形会话、L1-L4 压缩、hook、teammates 是自实现差异化资产，且 ADR-0004 已定自管会话格式；自研多 provider 抽象——被否决：重复造轮子，与生态对齐目标相悖。

**决策明细**:
- **对拍通道**：TS 侧测试/对拍走 chat-completions 线协议（自定义 openai-completions provider 指向 mock server），对拍零差异验收不变；pi-ai 内建 OpenAI provider 是 Responses API，不作为对拍通道
- **fallback 模型机制取消**：Python 的 FALLBACK_MODEL_ID + 连续 529 切换语义删除；异常应对 = pi retry settings 语义（agent 级重试）+ 手动 `/model` 切换（pi 本身无 fallback 机制，已核实）
- **error-recovery 收缩**：删 429/529 退避与切模型；保留 length→8K→64K 升级 + 续写、reactive compact（Python 对拍语义，pi 无对应物）
- **env 清理**：OPENAI_MODEL / OPENAI_BASE_URL / FALLBACK_MODEL_ID / OPENAI_TOOL_STRICT 移除（工具 strict 语义由 pi-ai constrainedSampling `prefer` 承接）
- **思考强度**：默认 high（模型不支持时按 pi 语义钳制），7 档循环，随 model_change entry 持久化，resume 恢复
- **UX（参考 pi 实现）**：/login /logout /model /settings、shift+tab 循环思考强度、Ctrl+P + /scoped-models、首启无凭据提示 /login；状态行显示 provider/model + 思考档位 + token/cost

**Consequences**: ADR-0005 的"openai SDK 直操 + env 变量名对齐"条款作废（见该 ADR 修订注记），"裸 OpenAI 消息结构 + 数据格式兼容 + 对拍"条款保留；与 pi 共享全局配置目录（登录一次两边通用，cpi 与 pi 互相可见凭据）；测试/对拍基建适配（程序化注册 provider 指向 mock）；.env.example 清理；pi-ai 与 pi-tui 同为 0.83.0 锁版本，升级联动评估。
