import { describe, it, expect } from "vitest";
import { Keymap } from "./keymap.ts";
import { TurnController } from "./turn-controller.ts";
import { ToolBlockRegistry } from "./tool-registry.ts";
import { theme } from "./theme/theme.ts";

describe("Keymap（架构 B）", () => {
  it("bind + handle：命中执行并返回消费，未命中不消费", () => {
    const km = new Keymap();
    let fired = 0;
    km.bind("x", () => {
      fired += 1;
    });
    expect(km.handle("x")).toBe(true);
    expect(km.handle("y")).toBe(false);
    expect(fired).toBe(1);
  });

  it("未绑定键不执行任何动作", () => {
    const km = new Keymap();
    expect(km.handle("\x1b")).toBe(false);
  });
});

describe("TurnController（架构 B）", () => {
  it("beginTurn 返回 signal；getSignal 生命周期正确", () => {
    const tc = new TurnController();
    expect(tc.getSignal()).toBeNull();
    const sig = tc.beginTurn();
    expect(tc.getSignal()).toBe(sig);
    expect(sig.aborted).toBe(false);
    tc.endTurn();
    expect(tc.getSignal()).toBeNull();
  });

  it("interrupt 仅 busy 时 abort", () => {
    const tc = new TurnController();
    const sig = tc.beginTurn();
    expect(tc.interrupt()).toBe(false); // 未 busy
    expect(sig.aborted).toBe(false);
    tc.setBusy(true);
    expect(tc.interrupt()).toBe(true);
    expect(sig.aborted).toBe(true);
    tc.setBusy(false);
    tc.endTurn();
  });
});

describe("ToolBlockRegistry（架构 B）", () => {
  it("start→result 流转；新块跟随折叠偏好", () => {
    const added: string[] = [];
    const reg = new ToolBlockRegistry((c) => {
      added.push((c as { toolName?: string }).toolName ?? "?");
    });
    reg.handleEvent({ phase: "start", name: "bash", id: "c1", args: {} });
    reg.handleEvent({
      phase: "result",
      name: "bash",
      id: "c1",
      args: {},
      result: "ok",
      isError: false,
    });
    expect(added).toEqual(["bash"]);
    expect(reg.size()).toBe(1);
  });

  it("toggleExpansion 切换全部块（含后续新建块）", () => {
    const reg = new ToolBlockRegistry(() => {});
    reg.handleEvent({ phase: "start", name: "bash", id: "c1", args: {} });
    reg.handleEvent({
      phase: "result",
      name: "bash",
      id: "c1",
      args: {},
      result: Array.from({ length: 40 }, (_, i) => `r${i}`).join("\n"),
      isError: false,
    });
    expect(reg.isExpanded()).toBe(false);
    reg.toggleExpansion();
    expect(reg.isExpanded()).toBe(true);
    // 新块（c2）跟随偏好：展开态 → 渲染含 r0
    reg.handleEvent({ phase: "start", name: "read", id: "c2", args: {} });
    reg.handleEvent({
      phase: "result",
      name: "read",
      id: "c2",
      args: {},
      result: "x",
      isError: false,
    });
    // c1 展开后内容完整（r0 可见，无折叠提示）
    const c1 = (reg as unknown as { map: Map<string, unknown> }).map.get("c1");
    const lines = (c1 as { render(w: number): string[] }).render(80).join("");
    expect(lines).toContain("r0");
    expect(lines).not.toContain("已折叠");
    expect(lines).toContain(theme.getBgAnsi("toolSuccessBg"));
  });
});
