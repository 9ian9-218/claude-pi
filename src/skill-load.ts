/**
 * skill-load.ts — Skill 扫描与加载（对齐 src/skill_load.py）
 *
 * 扫描 .agent/skills/<name>/SKILL.md（frontmatter 定义 name/description），
 * 注册表供 load_skill 工具按名取全文、prompt 组装 Skills available 目录段。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, resolveAgentDirs } from "./config.ts";
import { buildSkillSection } from "./prompt.ts";

export interface SkillInfo {
  name: string;
  description: string;
  content: string;
}

// 测试可注入；默认 .agent/skills
let skillsDir: string = resolveAgentDirs(PROJECT_ROOT).skillsDir;

export function setSkillsDir(dir: string): void {
  skillsDir = dir;
  rescanSkills();
}

export function parseFrontmatter(text: string): [Record<string, string>, string] {
  if (!text.startsWith("---")) return [{}, text];
  const parts = text.split("---", 3);
  if (parts.length < 3) return [{}, text];
  const meta: Record<string, string> = {};
  for (const line of parts[1].trim().split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      meta[k] = v;
    }
  }
  return [meta, parts[2].trim()];
}

const SKILL_REGISTRY = new Map<string, SkillInfo>();

export function rescanSkills(): void {
  SKILL_REGISTRY.clear();
  if (!fs.existsSync(skillsDir)) return;
  for (const d of fs.readdirSync(skillsDir).sort()) {
    const dirPath = path.join(skillsDir, d);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const manifest = path.join(dirPath, "SKILL.md");
    if (!fs.existsSync(manifest)) continue;
    const raw = fs.readFileSync(manifest, "utf8");
    const [meta, body] = parseFrontmatter(raw);
    const name = meta.name ?? d;
    const desc = meta.description ?? raw.split("\n")[0].replace(/^#\s*/, "").trim();
    SKILL_REGISTRY.set(name, { name, description: desc, content: raw });
  }
}

export function listSkills(): string {
  return [...SKILL_REGISTRY.values()]
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join("\n");
}

export function getSkillContent(name: string): string | null {
  return SKILL_REGISTRY.get(name)?.content ?? null;
}

// 启动时扫描一次（对齐 Python _scan_skills）
rescanSkills();

/** 当前 Skill 目录段（每次构建，修正 Python const 的启动快照怪癖） */
export function getSkillCatalog(): string {
  return buildSkillSection(listSkills());
}
