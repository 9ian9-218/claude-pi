/**
 * team-helpers.ts — 团队配置 CRUD（对齐 teammates/team_helpers.py）
 *
 * .agent/teams/{team}/config.json；成员含 agentId/name/agentType/color/isActive。
 */
import fs from "node:fs";
import path from "node:path";
import { AGENT_COLORS, TEAM_LEAD_NAME, getTeamsDir } from "./constants.ts";
import { sanitizePathComponent } from "./mailbox.ts";

export interface TeamMember {
  agentId: string;
  name: string;
  agentType: string;
  color: string;
  isActive: boolean;
  joinedAt: string;
  model?: string | null;
}

export interface TeamConfig {
  name: string;
  leadAgentId: string;
  members: TeamMember[];
}

export function getTeamDir(teamName: string): string {
  return path.join(getTeamsDir(), sanitizePathComponent(teamName));
}

export function getTeamConfigPath(teamName: string): string {
  return path.join(getTeamDir(teamName), "config.json");
}

export function readTeamConfig(teamName: string): TeamConfig | null {
  const p = getTeamConfigPath(teamName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as TeamConfig;
  } catch {
    return null;
  }
}

export function writeTeamConfig(config: TeamConfig): void {
  const teamDir = getTeamDir(config.name);
  fs.mkdirSync(path.join(teamDir, "inboxes"), { recursive: true });
  fs.writeFileSync(getTeamConfigPath(config.name), JSON.stringify(config, null, 2));
}

export function createTeam(teamName: string, leadName: string = TEAM_LEAD_NAME): TeamConfig {
  const config: TeamConfig = {
    name: teamName,
    leadAgentId: leadName,
    members: [
      {
        agentId: leadName,
        name: leadName,
        agentType: "general-purpose",
        color: "blue",
        isActive: true,
        joinedAt: new Date().toISOString(),
      },
    ],
  };
  writeTeamConfig(config);
  return config;
}

export function getLeaderName(teamName: string): string {
  const config = readTeamConfig(teamName);
  return config?.leadAgentId ?? TEAM_LEAD_NAME;
}

export function listActiveTeammates(teamName: string): TeamMember[] {
  const config = readTeamConfig(teamName);
  if (!config) return [];
  return config.members.filter((m) => m.name !== config.leadAgentId && m.isActive);
}

export function ensureTeammateForSpawn(
  teamName: string,
  name: string,
  agentType = "general-purpose",
): TeamMember {
  const config = readTeamConfig(teamName);
  if (!config) throw new Error(`team '${teamName}' not found`);
  const existing = config.members.find((m) => m.name === name);
  if (existing) {
    if (existing.isActive) throw new Error(`teammate '${name}' already active on team '${teamName}'`);
    existing.isActive = true;
    existing.agentType = agentType;
    writeTeamConfig(config);
    return existing;
  }
  const usedColors = new Set(config.members.map((m) => m.color));
  const color = AGENT_COLORS.find((c) => !usedColors.has(c)) ?? "gray";
  const member: TeamMember = {
    agentId: `${name}@${teamName}`,
    name,
    agentType,
    color,
    isActive: true,
    joinedAt: new Date().toISOString(),
  };
  config.members.push(member);
  writeTeamConfig(config);
  return member;
}

export function deactivateTeammate(teamName: string, name: string): void {
  const config = readTeamConfig(teamName);
  if (!config) return;
  const member = config.members.find((m) => m.name === name);
  if (member) {
    member.isActive = false;
    writeTeamConfig(config);
  }
}
