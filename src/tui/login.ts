/**
 * login.ts — /login 登录流程（对齐 pi interactive-mode.handleLoginCommand）
 *
 * 流程：刷新凭据 → 选择服务商（/login <id> 直选）→ 选择认证方式（oauth /
 * api_key，仅列出支持交互登录的方式）→ ModelRuntime.login（interaction：
 * prompt 经选择器/编辑器输入，notify 事件渲染为 system 消息）→ 刷新当前模型。
 * 整个登录过程处于"登录模式"：Esc 取消（app.beginLoginMode/endLoginMode）。
 */
import type { TuiApp } from "./app.ts";
import type { Api, Provider } from "@earendil-works/pi-ai";

type AuthType = "oauth" | "api_key";

/** 支持交互登录的认证方式（oauth.login / apiKey.login 存在时） */
function loginOptions(p: Provider<Api>): AuthType[] {
  const opts: AuthType[] = [];
  if (p.auth.oauth?.login) opts.push("oauth");
  if (p.auth.apiKey?.login) opts.push("api_key");
  return opts;
}

export async function handleLoginCommand(app: TuiApp, providerRef: string): Promise<void> {
  const { getModelRuntime, setCurrentModel, resolveCurrentModel } = await import("../ai-runtime.ts");

  let runtime;
  try {
    runtime = await getModelRuntime();
  } catch (e) {
    app.appendSystem(`模型运行时加载失败：${String((e as Error).message)}`, "error");
    return;
  }
  // 对齐 pi：先刷新凭据状态再列服务商
  try {
    await runtime.getAvailable();
  } catch {
    // 未配置凭据的 provider 也会抛；继续列出可登录项
  }
  const providers = runtime.getProviders().filter((p) => loginOptions(p).length > 0);

  // 1) 服务商选择
  let provider: Provider<Api> | undefined;
  if (providerRef) {
    const ref = providerRef.toLowerCase();
    provider = providers.find(
      (p) => p.id.toLowerCase() === ref || p.name.toLowerCase() === ref,
    );
    if (!provider) {
      app.appendSystem(`未知服务商：${providerRef}（/login 查看可登录列表）`, "warning");
      return;
    }
  } else if (providers.length === 1) {
    provider = providers[0];
  } else if (providers.length === 0) {
    app.appendSystem("无可用登录：当前没有支持交互登录的服务商（可手动配置 ~/.pi/agent/auth.json 或 models.json）。", "warning");
    return;
  } else {
    const items = providers.map((p) => ({
      value: p.id,
      label: p.name,
      description: `可登录：${loginOptions(p).join(" / ")}`,
    }));
    const picked = await app.showSelector(items, "登录 — 选择服务商");
    if (!picked) {
      app.appendSystem("已取消。");
      return;
    }
    provider = providers.find((p) => p.id === picked.value);
  }
  if (!provider) return;

  // 2) 认证方式选择
  const options = loginOptions(provider);
  let type: AuthType;
  if (options.length === 1) {
    type = options[0];
  } else {
    const items = [
      { value: "oauth", label: "Sign in with an account", description: "OAuth 授权" },
      { value: "api_key", label: "Sign in with an API key", description: "粘贴 API key" },
    ];
    const picked = await app.showSelector(items, `${provider.name} — 选择认证方式`);
    if (!picked) {
      app.appendSystem("已取消。");
      return;
    }
    type = picked.value as AuthType;
  }

  // 3) 登录（登录模式：Esc 取消整段流程）
  const controller = new AbortController();
  app.beginLoginMode(() => controller.abort());
  try {
    await runtime.login(provider.id, type, {
      signal: controller.signal,
      prompt: async (p) => {
        if (p.type === "select") {
          const items = p.options.map((o) => ({
            value: o.id,
            label: o.label,
            description: o.description ?? "",
          }));
          const picked = await app.showSelector(items, p.message);
          if (!picked) throw new Error("Login cancelled");
          return picked.value;
        }
        // text / secret / manual_code：编辑器模态输入（明文，对齐 pi Input）
        const value = await app.promptForInput(p.message, p.placeholder);
        if (value === null) throw new Error("Login cancelled");
        return value;
      },
      notify: (e) => {
        if (e.type === "auth_url") {
          app.appendSystem(`打开 ${e.url} 完成登录${e.instructions ? ` — ${e.instructions}` : ""}`, "accent");
        } else if (e.type === "device_code") {
          app.appendSystem(`在 ${e.verificationUri} 输入代码：${e.userCode}`, "accent");
        } else if (e.type === "info") {
          app.appendSystem(e.message, "accent");
        }
        // progress：静默
      },
    });
  } catch (e) {
    const msg = String((e as Error).message);
    if (msg !== "Login cancelled") {
      app.appendSystem(`登录失败：${msg}`, "error");
    } else {
      app.appendSystem("已取消。");
    }
    app.endLoginMode();
    return;
  }
  app.endLoginMode();

  // 4) 成功后刷新当前模型（登录可能新增了可用模型）
  setCurrentModel(null);
  try {
    await resolveCurrentModel();
    app.appendSystem(`已登录 ${provider.name}。Ctrl+L 可切换模型。`, "success");
  } catch {
    app.appendSystem(`已登录 ${provider.name}（当前无可用模型，Ctrl+L 查看）。`, "success");
  }
}
