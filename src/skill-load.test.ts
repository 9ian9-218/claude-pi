import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setSkillsDir,
  rescanSkills,
  parseFrontmatter,
  listSkills,
  getSkillContent,
  getSkillCatalog,
} from "./skill-load.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-skills-"));
  setSkillsDir(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("skill-load（S7）", () => {
  it("parseFrontmatter 解析 SKILL.md 元数据", () => {
    const [meta, body] = parseFrontmatter(
      "---\nname: my-skill\ndescription: 做某事的技能\n---\n\n# Skill 正文\n内容",
    );
    expect(meta.name).toBe("my-skill");
    expect(meta.description).toBe("做某事的技能");
    expect(body).toContain("# Skill 正文");
  });

  it("扫描 .agent/skills/ 下子目录的 SKILL.md", () => {
    fs.mkdirSync(path.join(dir, "code-review"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "code-review", "SKILL.md"),
      "---\nname: code-review\ndescription: 审查代码\n---\n\n# Review\n...",
    );
    rescanSkills();
    expect(listSkills()).toContain("code-review");
    expect(listSkills()).toContain("审查代码");
  });

  it("无 frontmatter 时用目录名与首行", () => {
    fs.mkdirSync(path.join(dir, "no-meta"), { recursive: true });
    fs.writeFileSync(path.join(dir, "no-meta", "SKILL.md"), "# No Meta Skill\nbody");
    rescanSkills();
    expect(listSkills()).toContain("no-meta");
  });

  it("getSkillContent 返回完整内容，未知名返回 null", () => {
    fs.mkdirSync(path.join(dir, "pdf"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "pdf", "SKILL.md"),
      "---\nname: pdf\ndescription: pdf 处理\n---\n\n# PDF\nfull body",
    );
    rescanSkills();
    expect(getSkillContent("pdf")).toContain("full body");
    expect(getSkillContent("nope")).toBeNull();
  });

  it("SKILL_CATALOG 反映注册表（Skills available 段）", () => {
    fs.mkdirSync(path.join(dir, "agent-builder"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "agent-builder", "SKILL.md"),
      "---\nname: agent-builder\ndescription: 构建 agent\n---\n\nbody",
    );
    rescanSkills();
    const catalog = getSkillCatalog();
    expect(catalog).toContain("Skills available:");
    expect(catalog).toContain("agent-builder");
  });
});
