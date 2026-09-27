import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

describe("原子落盘", () => {
  it("写入后内容完整且无临时文件残留", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-aw-"));
    try {
      const p = path.join(dir, "state.json");
      writeFileAtomic(p, '{"a":1}');
      expect(fs.readFileSync(p, "utf8")).toBe('{"a":1}');
      expect(fs.readdirSync(dir)).toEqual(["state.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("失败时抛出且不留半截临时文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-aw-"));
    try {
      expect(() => writeFileAtomic(path.join(dir, "missing", "state.json"), "x")).toThrow();
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
