/**
 * skill.ts — load_skill 工具（从 tool.ts 拆出）
 */
import { getSkillContent } from "../skill-load.ts";
import { buildTool } from "./core.ts";

// ── load_skill ─────────────────────────────────────────────────────────────

function execLoadSkill(args: Record<string, unknown>): string {
  const name = String(args["name"]);
  const content = getSkillContent(name);
  if (content === null) {
    return `Skill not found: ${name}`;
  }
  return content;
}

const LOAD_SKILL_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "The name of the skill to load" },
  },
  required: ["name"],
  additionalProperties: false,
};

export const LOAD_SKILL_TOOL = buildTool({
  name: "load_skill",
  description: "Load the full content of a skill by name.",
  parameters: LOAD_SKILL_SCHEMA,
  execute: execLoadSkill,
  isReadOnly: true,
});

// ── 任务看板工具（08） ────────────────────────────────────────────────────
