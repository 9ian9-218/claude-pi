import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPath, safePath } from "./path.ts";
import { runWithWorkdir } from "../workdir.ts";

describe("工作区路径校验", () => {
  it("工作区内的软链接指向外部时视为逃逸", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-path-ws-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-path-out-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "s");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "link.txt"));
      fs.symlinkSync(outside, path.join(ws, "linkdir"));

      runWithWorkdir(ws, () => {
        // 词法上都在工作区内，必须靠 realpath 才能发现真的指到外面
        expect(checkPath("link.txt")).toContain("escapes workspace");
        expect(checkPath("linkdir/secret.txt")).toContain("escapes workspace");
        expect(checkPath("normal.txt")).toBeNull();
        expect(() => safePath("link.txt")).toThrow();
      });
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
