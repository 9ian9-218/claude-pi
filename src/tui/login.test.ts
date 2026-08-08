/**
 * login.test.ts — /login 登录流程（回归）
 *
 * 症状回归：/login 报"未知命令"，/help 与启动帮助无 login 选项。
 * 桩驱动：setModelRuntimeOverride 注入 fake runtime，验证完整登录链路
 * （provider 选择 → 认证方式 → prompt/notify → 成功提示）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TuiApp } from "./app.ts";
import type { Terminal } from "@earendil-works/pi-tui";
import { resetClient } from "../client.ts";
import { setModelRuntimeOverride, resetAiRuntime } from "../ai-runtime.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, AuthInteraction, Credential, Provider } from "@earendil-works/pi-ai";

class FakeTerminal implements Terminal {
  writes: string[] = [];
  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  get columns(): number {
    return 80;
  }
  get rows(): number {
    return 24;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  onInput?: (data: string) => void;
}

const nextTick = () => new Promise<void>((r) => setTimeout(r, 30));

function makeProvider(
  id: string,
  name: string,
  opts: { oauth?: boolean; apiKeyLogin?: boolean },
): Provider<Api> {
  const auth: Provider<Api>["auth"] = {};
  if (opts.oauth) {
    auth.oauth = {
      name: `${name} 账号`,
      login: async () => ({ type: "oauth", refresh: "r", access: "a", expires: 1 }),
      refresh: async (c) => c,
      toAuth: async () => ({ apiKey: "x" }),
    };
  }
  if (opts.apiKeyLogin) {
    auth.apiKey = {
      name: `${name} API key`,
      login: async () => ({ type: "api_key", key: "k" }),
      resolve: async () => undefined,
    };
  }
  return {
    id,
    name,
    auth,
    getModels: () => [],
    stream: () => {
      throw new Error("n/a");
    },
    streamSimple: () => {
      throw new Error("n/a");
    },
  } as unknown as Provider<Api>;
}

/** fake runtime：记录 login 调用；oauth 发 auth_url，api_key 走 secret prompt */
function makeRuntime(providers: Provider<Api>[]) {
  const calls: string[] = [];
  const runtime = {
    getProviders: () => providers,
    getAvailable: async () => [],
    login: async (providerId: string, type: string, interaction: AuthInteraction) => {
      calls.push(`${providerId}:${type}`);
      if (type === "oauth") {
        interaction.notify({
          type: "auth_url",
          url: "https://auth.example/login",
          instructions: "打开链接完成授权",
        });
        return { type: "oauth", refresh: "r", access: "a", expires: 1 } as Credential;
      }
      const key = await interaction.prompt({ type: "secret", message: "输入 API key" });
      return { type: "api_key", key } as Credential;
    },
  } as unknown as ModelRuntime;
  return { runtime, calls };
}

function makeApp(initialText?: string) {
  const term = new FakeTerminal();
  const app = new TuiApp({ terminal: term, onQuery: () => {}, ...(initialText ? { initialText } : {}) });
  app.tui.start();
  return { term, app };
}

describe("/login（回归：登录命令缺失）", () => {
  beforeEach(() => {
    resetClient();
  });
  afterEach(() => {
    resetAiRuntime();
    resetClient();
  });

  it("无参数：oauth provider 直接进入登录，notify auth_url 显示到聊天区", async () => {
    const { runtime, calls } = makeRuntime([makeProvider("demo", "DemoAI", { oauth: true })]);
    setModelRuntimeOverride(runtime);
    const { app } = makeApp();
    app.editor.onSubmit?.("/login");
    await nextTick();
    expect(calls).toEqual(["demo:oauth"]);
    expect(app.getChatText()).toContain("已登录 DemoAI");
    expect(app.getChatText()).toContain("https://auth.example/login");
    app.stop();
  });

  it("/login <id> 按 id 直接登录", async () => {
    const { runtime, calls } = makeRuntime([
      makeProvider("aaa", "Alpha", { apiKeyLogin: true }),
      makeProvider("bbb", "Beta", { oauth: true }),
    ]);
    setModelRuntimeOverride(runtime);
    const { app } = makeApp();
    app.editor.onSubmit?.("/login bbb");
    await nextTick();
    expect(calls).toEqual(["bbb:oauth"]);
    app.stop();
  });

  it("oauth 与 apiKey 均可选时进入认证方式选择", async () => {
    const { runtime, calls } = makeRuntime([
      makeProvider("dual", "DualAI", { oauth: true, apiKeyLogin: true }),
    ]);
    setModelRuntimeOverride(runtime);
    const { term, app } = makeApp();
    app.editor.onSubmit?.("/login dual");
    await nextTick();
    // 尚未直接登录：等待认证方式选择（overlay 渲染，不在聊天区）
    expect(calls).toEqual([]);
    expect(term.writes.join("")).toContain("DualAI — 选择认证方式");
    // 选第二项（API key）并回车
    term.onInput?.("\x1b[B");
    term.onInput?.("\r");
    await nextTick();
    expect(calls).toEqual(["dual:api_key"]);
    app.stop();
  });

  it("api_key 流：prompt secret 经编辑器输入后提交", async () => {
    const { runtime, calls } = makeRuntime([
      makeProvider("keyed", "KeyedAI", { apiKeyLogin: true }),
    ]);
    setModelRuntimeOverride(runtime);
    const { app } = makeApp();
    app.editor.onSubmit?.("/login keyed");
    await nextTick();
    // 等待 prompt：输入 key 并提交
    expect(app.getChatText()).toContain("输入 API key");
    app.editor.setText("sk-test-123");
    app.editor.onSubmit?.("sk-test-123");
    await nextTick();
    expect(calls).toEqual(["keyed:api_key"]);
    expect(app.getChatText()).toContain("已登录 KeyedAI");
    expect(app.getChatText()).not.toContain("sk-test-123");
    app.stop();
  });

  it("登录中 Esc 取消：prompt 取消、登录不完成，恢复正常输入", async () => {
    const { runtime, calls } = makeRuntime([
      makeProvider("esc", "EscAI", { apiKeyLogin: true }),
    ]);
    setModelRuntimeOverride(runtime);
    const term = new FakeTerminal();
    let queries = 0;
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {
        queries += 1;
      },
    });
    app.tui.start();
    app.editor.onSubmit?.("/login esc");
    await nextTick();
    term.onInput?.("\x1b"); // Esc 取消登录
    await nextTick();
    expect(app.getChatText()).toContain("已取消");
    // 登录已发起（挂起于 prompt）但未完成：无后续密钥获取
    expect(calls).toEqual(["esc:api_key"]);
    // 取消后编辑器恢复：可正常提交普通查询
    app.editor.setText("hello");
    app.editor.onSubmit?.("hello");
    await nextTick();
    expect(queries).toBe(1);
    app.stop();
  });

  it("无任何可登录 provider 时提示", async () => {
    const { runtime } = makeRuntime([]);
    setModelRuntimeOverride(runtime);
    const { app } = makeApp();
    app.editor.onSubmit?.("/login");
    await nextTick();
    expect(app.getChatText()).toContain("无可用登录");
    app.stop();
  });

  it("/help 与启动帮助包含 /login 选项", () => {
    const { app } = makeApp("claude-pi — 输入 /help 查看命令\n\n");
    app.editor.onSubmit?.("/help");
    // 启动帮助展开（/help 复用）；渲染输出含 /login
    const startup = app["startupMessage"];
    expect(startup).not.toBeNull();
    expect(app.chat.render(80).join("")).toContain("/login 登录模型服务商");
    app.stop();
  });
});
