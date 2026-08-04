import { describe, it, expect } from "vitest";
import { registerHook, triggerHooks, HOOKS } from "./hook.ts";

describe("hook 注册表（S3）", () => {
  it("registerHook 追加回调，triggerHooks 依次执行", () => {
    const calls: string[] = [];
    registerHook("test_event", (x: string) => {
      calls.push(`a:${x}`);
    });
    registerHook("test_event", (x: string) => {
      calls.push(`b:${x}`);
    });
    triggerHooks("test_event", "arg");
    expect(calls).toEqual(["a:arg", "b:arg"]);
  });

  it("任一回调返回非 null/undefined 则短路返回该值", () => {
    registerHook("short_event", () => "first");
    registerHook("short_event", () => "second");
    const result = triggerHooks("short_event");
    expect(result).toBe("first");
  });

  it("全部返回 undefined 时 trigger 返回 undefined", () => {
    registerHook("void_event", () => undefined);
    expect(triggerHooks("void_event")).toBeUndefined();
  });

  it("未注册事件触发返回 undefined 不抛错", () => {
    expect(triggerHooks("no_such_event", 1, 2)).toBeUndefined();
  });

  it("内置 UserPromptSubmit 含工作目录提示 hook", () => {
    const hooks = HOOKS["UserPromptSubmit"];
    expect(Array.isArray(hooks)).toBe(true);
    expect(hooks.length).toBeGreaterThan(0);
  });

  it("内置 Stop 含会话统计 hook", () => {
    const hooks = HOOKS["Stop"];
    expect(Array.isArray(hooks)).toBe(true);
    expect(hooks.length).toBeGreaterThan(0);
  });
});
