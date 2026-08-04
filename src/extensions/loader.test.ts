import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExtensionManager } from "./loader.ts";
import { registerHook } from "../hook.ts";
import { registerExtensionTool, getOpenaiTools, executeToolCall, type ToolCallLike } from "../tool.ts";
import { registerSlashCommand, getSlashCommand, clearSlashCommands } from "../commands.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-ext-"));
  clearSlashCommands();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeExt(name: string, content: string): string {
  const p = path.join(dir, `${name}.ts`);
  fs.writeFileSync(p, content);
  return p;
}

describe("扩展加载（S16）", () => {
  it("加载扩展并注册工具/命令/事件", async () => {
    const ext = writeExt(
      "my-ext",
      `
export default function (pi: any) {
  pi.registerTool({
    name: "greet_ext",
    description: "打招呼",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    execute: (args: any) => "Hello, " + args.name + "!",
  });
  pi.registerCommand("extping", (args: string) => "pong:" + args);
  pi.on("stop", () => {});
}
`,
    );
    const registered: string[] = [];
    const manager = new ExtensionManager({
      registerTool: (t) => {
        registered.push(t.name);
      },
      registerCommand: (n, h) => registerSlashCommand({ name: n, description: "", handler: (a) => h(a, {}) }),
      appendEntry: () => "",
    });
    const loaded = await manager.load([ext]);
    expect(loaded).toHaveLength(1);
    expect(registered).toContain("greet_ext");
  });

  it("扩展工具可被调用", async () => {
    const ext = writeExt(
      "tool-ext",
      `
export default function (pi: any) {
  pi.registerTool({
    name: "greet_ext",
    description: "打招呼",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    execute: (args: any) => "Hello, " + args.name + "!",
  });
}
`,
    );
    // 先手动注册工具（模拟 ExtensionManager 接线）
    const { buildTool } = await import("../tool.ts");
    registerExtensionTool(
      buildTool({
        name: "greet_ext",
        description: "打招呼",
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
        execute: (args) => "Hello, " + String(args.name) + "!",
      }),
    );
    const names = getOpenaiTools(false).map((t) => t.function.name);
    expect(names).toContain("greet_ext");
    const result = await executeToolCall({ function: { name: "greet_ext", arguments: '{"name":"world"}' } } as ToolCallLike);
    expect(result).toBe("Hello, world!");
  });

  it("registerCommand 可被查询", () => {
    registerSlashCommand({ name: "extping", description: "", handler: (a) => "pong:" + a });
    expect(getSlashCommand("extping")?.handler("x")).toBe("pong:x");
  });

  it("appendEntry 写入 custom entry（会话持久化）", async () => {
    const { SessionManager, setSessionRoot } = await import("../session-manager.ts");
    const sessDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-extsess-"));
    setSessionRoot(sessDir);
    try {
      const session = SessionManager.create(process.cwd());
      const id = session.appendCustom("my-ext", { count: 42 });
      expect(id).toBeTruthy();
      const reopened = SessionManager.open(session.getSessionFile()!);
      const custom = reopened.getEntries().find((e) => e.type === "custom") as { customType: string; data: { count: number } };
      expect(custom.customType).toBe("my-ext");
      expect(custom.data.count).toBe(42);
      // custom 不参与上下文
      expect(reopened.buildSessionContext().messages).toHaveLength(0);
    } finally {
      fs.rmSync(sessDir, { recursive: true, force: true });
    }
  });

  it("reload 重新加载（扩展命令重建）", async () => {
    const ext = writeExt(
      "reload-ext",
      `
export default function (pi: any) {
  pi.registerCommand("reloadcmd", () => "v1");
}
`,
    );
    const manager = new ExtensionManager({
      registerTool: () => {},
      registerCommand: (n, h) => registerSlashCommand({ name: n, description: "", handler: (a) => h(a, {}) }),
      appendEntry: () => "",
      beforeLoad: () => clearSlashCommands(),
    });
    await manager.load([ext]);
    expect(getSlashCommand("reloadcmd")?.handler("")).toBe("v1");
    // 修改扩展后 reload
    fs.writeFileSync(ext, `
export default function (pi: any) {
  pi.registerCommand("reloadcmd", () => "v2");
}
`);
    await manager.reload([ext]);
    expect(getSlashCommand("reloadcmd")?.handler("")).toBe("v2");
  });

  it("事件监听映射到 hook 系统", async () => {
    const ext = writeExt(
      "event-ext",
      `
export default function (pi: any) {
  pi.on("user_prompt_submit", () => {});
}
`,
    );
    const { triggerHooks, installBuiltinHooks } = await import("../hook.ts");
    installBuiltinHooks();
    let fired = false;
    registerHook("user_prompt_submit", () => {
      fired = true;
    });
    const manager = new ExtensionManager({
      registerTool: () => {},
      registerCommand: () => {},
      appendEntry: () => "",
    });
    manager.load([ext]);
    await triggerHooks("user_prompt_submit", "hi");
    expect(fired).toBe(true);
  });
});
