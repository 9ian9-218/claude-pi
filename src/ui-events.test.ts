import { describe, it, expect, vi } from "vitest";
import { UiEventSink, emitNoticeOrLog } from "./ui-events.ts";

describe("UiEventSink（架构 C）", () => {
  it("订阅/广播：emit 分发到订阅者", () => {
    const sink = new UiEventSink();
    const got: string[] = [];
    sink.on("stream", (e) => got.push(`s:${e.kind}`));
    sink.on("tool", (e) => got.push(`t:${e.phase}`));
    sink.emit("stream", { kind: "text", delta: "a" });
    sink.emit("tool", { phase: "start", name: "bash", id: "c1", args: {} });
    expect(got).toEqual(["s:text", "t:start"]);
  });

  it("无订阅者时 emit 为 no-op（ADR-0008：不传 sink 行为不变）", () => {
    const sink = new UiEventSink();
    expect(() => sink.emit("stream", { kind: "text", delta: "x" })).not.toThrow();
    expect(sink.listenerCount("stream")).toBe(0);
  });

  it("on 返回取消订阅函数", () => {
    const sink = new UiEventSink();
    let count = 0;
    const off = sink.on("turnEnd", () => {
      count += 1;
    });
    sink.emit("turnEnd", { stopReason: "stop" });
    expect(count).toBe(1);
    off();
    sink.emit("turnEnd", { stopReason: "stop" });
    expect(count).toBe(1);
  });

  it("多订阅者互不影响", () => {
    const sink = new UiEventSink();
    const a: string[] = [];
    const b: string[] = [];
    sink.on("stream", (e) => a.push(e.delta));
    sink.on("stream", (e) => b.push(e.delta));
    sink.emit("stream", { kind: "text", delta: "z" });
    expect(a).toEqual(["z"]);
    expect(b).toEqual(["z"]);
  });
});

describe("notice 事件（架构 C 扩展）", () => {
  it("有订阅者时 notice 走通道，不写 console", () => {
    const sink = new UiEventSink();
    const seen: string[] = [];
    sink.on("notice", (e) => seen.push(`${e.kind}: ${e.text}`));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      emitNoticeOrLog(sink, "  [31m[auto compact][0m");
      emitNoticeOrLog(sink, "  [32m[inject] task_notification[0m", "inject");
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([
      "status:   [31m[auto compact][0m",
      "inject:   [32m[inject] task_notification[0m",
    ]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("无订阅者时回退 console.log（REPL/对拍行为不变）", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      emitNoticeOrLog(undefined, "hello");
      expect(spy).toHaveBeenCalledWith("hello");
    } finally {
      spy.mockRestore();
    }
  });

  it("sink 有监听其他事件但无 notice 订阅者 → 回退 console", () => {
    const sink = new UiEventSink();
    sink.on("stream", () => {});
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      emitNoticeOrLog(sink, "fallback");
      expect(spy).toHaveBeenCalledWith("fallback");
    } finally {
      spy.mockRestore();
    }
  });
});
