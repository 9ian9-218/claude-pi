/**
 * test-client.ts — 测试用模型通道（pi-ai 自定义 provider，chat-completions 线协议）
 *
 * 单元测试：installMockModels(baseUrl) 程序化注册 provider 指向 MockOpenAI，
 * 无文件 I/O。子进程测试（CLI/对拍）：createTestAgentDir(baseUrl) 写临时
 * ~/.pi/agent 目录（models.json + settings.json），经 PI_CODING_AGENT_DIR
 * 注入 —— 与 pi 的配置机制完全一致。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { setClientModels } from "../../src/client.ts";
import { setRetryPolicyForTest } from "../../src/error-recovery.ts";

/** 构造 chat-completions 模型（max_tokens 字段，与 Python 版线协议一致） */
export function makeCompletionsModel(id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "openai",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_000,
    compat: {
      maxTokensField: "max_tokens",
      supportsStore: false,
      supportsDeveloperRole: false,
      requiresToolResultName: false,
    },
  };
}

/**
 * 单元测试：注册指向 MockOpenAI 的 provider。
 * 默认关闭重试（maxRetries=0）保证测试快速稳定；重试专项测试自行覆盖。
 */
export function installMockModels(baseUrl: string, modelId = "gpt-test"): Models {
  process.env.OPENAI_API_KEY = "test-key";
  setRetryPolicyForTest({ enabled: true, maxRetries: 0, baseDelayMs: 1 });
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "openai",
      name: "OpenAI (test)",
      baseUrl,
      auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
      models: [makeCompletionsModel(modelId, baseUrl)],
      api: openAICompletionsApi(),
    }),
  );
  setClientModels(models);
  return models;
}

/** 子进程测试/对拍：写临时 pi 配置目录（models.json + settings.json） */
export function createTestAgentDir(baseUrl: string, modelId = "gpt-test"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-agent-"));
  fs.writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify(
      {
        providers: {
          local: {
            baseUrl,
            api: "openai-completions",
            apiKey: "test-key",
            compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false },
            models: [
              { id: modelId, name: modelId, reasoning: true, contextWindow: 128000, maxTokens: 8000 },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify(
      {
        retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 },
        defaultModel: `local/${modelId}`,
      },
      null,
      2,
    ),
  );
  return dir;
}
