/**
 * ai-runtime.ts — pi 风格模型/凭据运行时（ModelRuntime，共享 ~/.pi/agent/）
 *
 * ADR-0007：配置面与 pi 一致 —— auth.json / models.json / settings.json 走
 * pi 全局目录（PI_CODING_AGENT_DIR 可覆盖，测试/对拍用临时目录）。
 * 自实现 loop 只从这里取 Model 与 Models，不引入 pi 的会话/压缩机制。
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { readPiSettings } from "./settings.ts";

let _runtime: ModelRuntime | null = null;
let _currentModel: Model<Api> | null = null;

/** 获取 ModelRuntime 单例（懒创建；默认路径由 PI_CODING_AGENT_DIR 决定） */
export async function getModelRuntime(): Promise<ModelRuntime> {
  if (_runtime === null) {
    // 动态导入：pi-coding-agent 模块图很大，仅在首次 LLM 调用时加载
    const { ModelRuntime: Runtime } = await import("@earendil-works/pi-coding-agent");
    _runtime = await Runtime.create();
  }
  return _runtime;
}

/** 测试隔离：注入/清除 ModelRuntime 覆盖 */
export function setModelRuntimeOverride(runtime: ModelRuntime | null): void {
  _runtime = runtime;
  if (runtime === null) _currentModel = null;
}

/** 当前模型（P4：/model 与会话恢复设置） */
export function getCurrentModel(): Model<Api> | null {
  return _currentModel;
}

export function setCurrentModel(model: Model<Api> | null): void {
  _currentModel = model;
}

/** 状态行/UI 用：`provider/id`，未解析时为 "?" */
export function currentModelLabel(): string {
  return _currentModel ? `${_currentModel.provider}/${_currentModel.id}` : "?";
}

/** 解析 "provider/id" 规格字符串；无斜杠时视为裸 id（跨 provider 搜索） */
export function parseModelSpec(spec: string): { provider?: string; id: string } {
  const slash = spec.indexOf("/");
  if (slash < 0) return { id: spec };
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

/**
 * 解析当前模型（结果缓存）：
 * 1. 显式设置（/model、会话恢复）
 * 2. settings.json defaultModel（pi 同款键）
 * 3. 第一个已认证可用的模型
 */
export async function resolveCurrentModel(): Promise<Model<Api>> {
  if (_currentModel !== null) return _currentModel;
  const runtime = await getModelRuntime();
  const settings = readPiSettings();
  if (settings.defaultModel) {
    const { provider, id } = parseModelSpec(settings.defaultModel);
    const found = provider
      ? runtime.getModel(provider, id)
      : runtime
          .getProviders()
          .map((p) => runtime.getModel(p.id, id))
          .find((m) => m !== undefined);
    if (found) {
      _currentModel = found;
      return found;
    }
  }
  const available = await runtime.getAvailable();
  if (available.length > 0) {
    _currentModel = available[0];
    return _currentModel;
  }
  throw new Error(
    "No model configured. Run /login or add models to ~/.pi/agent/models.json",
  );
}

/** 重置全部缓存（测试隔离 / resetClient） */
export function resetAiRuntime(): void {
  _runtime = null;
  _currentModel = null;
}
