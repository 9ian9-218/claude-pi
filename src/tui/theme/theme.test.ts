import { describe, it, expect } from "vitest";
import { Theme, setTheme, getTheme, getMarkdownTheme, getAvailableThemes } from "./theme.ts";

describe("主题系统（02）", () => {
  it("默认 dark，可用主题为 dark/light", () => {
    expect(getTheme().name).toBe("dark");
    expect(getAvailableThemes()).toEqual(["dark", "light"]);
  });

  it("fg/bg 生成 ANSI 序列并复位", () => {
    const t = new Theme("dark");
    expect(t.fg("accent", "hi")).toMatch(/^\x1b\[38;2;\d+;\d+;\d+mhi\x1b\[39m$/);
    expect(t.bg("userMessageBg", "hi")).toMatch(/^\x1b\[48;2;\d+;\d+;\d+mhi\x1b\[49m$/);
    expect(t.fg("text", "x")).toContain("x");
    expect(() => t.fg("ghost", "x")).toThrow("Unknown theme color");
  });

  it("setTheme 切换 light 后取色不同", () => {
    setTheme("light");
    const lightBg = getTheme().getBgAnsi("userMessageBg");
    setTheme("dark");
    const darkBg = getTheme().getBgAnsi("userMessageBg");
    expect(lightBg).not.toBe(darkBg);
  });

  it("getMarkdownTheme 全部渲染器为函数且带色", () => {
    const md = getMarkdownTheme();
    expect(md.heading("标题")).toContain("\x1b[");
    expect(md.bold("b")).toContain("\x1b[1m");
    expect(md.italic("i")).toContain("\x1b[3m");
    expect(md.code("c")).toContain("\x1b[38;2;");
    expect(md.listBullet("-")).toContain("\x1b[38;2;");
  });
});
