/**
 * commands.ts — 斜杠命令注册表（内置 + 扩展）
 *
 * 扩展经 registerSlashCommand 注册；TUI 分发先内置、再扩展、再会话命令。
 */
export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string) => Promise<string> | string;
}

const commands = new Map<string, SlashCommand>();

export function registerSlashCommand(cmd: SlashCommand): void {
  commands.set(cmd.name, cmd);
}

export function getSlashCommand(name: string): SlashCommand | null {
  return commands.get(name) ?? null;
}

export function listSlashCommands(): SlashCommand[] {
  return [...commands.values()];
}

export function clearSlashCommands(): void {
  commands.clear();
}
