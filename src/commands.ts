/**
 * commands.ts — 斜杠命令注册表（CommandRouter）
 *
 * 单一目录：内置命令（TUI 宿主）/ 会话命令（Session Tree）/ 扩展命令。
 * 定义携带：name/aliases/description/参数补全/分发表述式（handler 收 ctx）。
 * 旧扩展接口（registerSlashCommand/getSlashCommand/listSlashCommands/
 * clearSlashCommands）保留为兼容层（kind=extension）。
 */

/** 命令分发表述式：接收参数与宿主上下文（TUI app 等） */
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type CommandHandler<C> = (
  rest: string,
  ctx: C,
) => Promise<string | void> | string | void;

export interface SlashCommandDef<C = unknown> {
  name: string;
  aliases?: string[];
  description: string;
  kind: "builtin" | "session" | "extension";
  /** 动态参数补全（/model 的 provider/id 列表等）；签名对齐 pi-tui AutocompleteItem */
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;

  handler: CommandHandler<C>;
}

const entries = new Map<string, SlashCommandDef>();
const aliasIndex = new Map<string, string>();

/** 注册命令（内置/会话/扩展统一入口） */
export function registerCommand<C = unknown>(def: SlashCommandDef<C>): () => void {
  const previous = entries.get(def.name);
  entries.set(def.name, def as SlashCommandDef<unknown>);
  for (const a of def.aliases ?? []) aliasIndex.set(a, def.name);
  return () => {
    if (entries.get(def.name) !== def) return;
    if (previous) entries.set(def.name, previous); else entries.delete(def.name);
    for (const a of def.aliases ?? []) if (aliasIndex.get(a) === def.name) aliasIndex.delete(a);
    for (const a of previous?.aliases ?? []) aliasIndex.set(a, previous!.name);
  };
}

/** 按名字或别名查命令 */
export function getCommandEntry<C = unknown>(name: string): SlashCommandDef<C> | null {
  const direct = entries.get(name);
  if (direct) return direct as SlashCommandDef<C>;
  const viaAlias = aliasIndex.get(name);
  if (viaAlias) return (entries.get(viaAlias) ?? null) as SlashCommandDef<C> | null;
  return null;
}

/** 全部命令（自动补全/帮助用） */
export function listCommandEntries<C = unknown>(): Array<SlashCommandDef<C>> {
  return [...entries.values()] as Array<SlashCommandDef<C>>;
}

// ── 兼容层（扩展系统 / 既有测试） ────────────────────────────────────────

export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string) => Promise<string> | string;
}

export function registerSlashCommand(cmd: SlashCommand): () => void {
  return registerCommand({
    name: cmd.name,
    description: cmd.description,
    kind: "extension",
    handler: (rest) => cmd.handler(rest),
  });
}

export function getSlashCommand(name: string): SlashCommand | null {
  const e = getCommandEntry(name);
  if (!e) return null;
  return {
    name: e.name,
    description: e.description,
    handler: (a) => e.handler(a, undefined as never) as Promise<string> | string,
  };
}

export function listSlashCommands(): SlashCommand[] {
  return listCommandEntries()
    .filter((e) => e.kind === "extension")
    .map((e) => ({
      name: e.name,
      description: e.description,
      handler: (a) => e.handler(a, undefined as never) as Promise<string> | string,
    }));
}

/** 清空扩展命令（/reload beforeLoad；内置与会话命令保留） */
export function clearSlashCommands(): void {
  for (const [k, v] of entries) {
    if (v.kind === "extension") entries.delete(k);
  }
  for (const [k, v] of aliasIndex) {
    const target = entries.get(v);
    if (!target || target.kind === "extension") aliasIndex.delete(k);
  }
}

/** 拆分 "/cmd rest" → { name, rest } */
export function splitCommandLine(cmd: string): { name: string; rest: string } {
  const trimmed = cmd.trim().replace(/^\/+/, "");
  const idx = trimmed.search(/\s/);
  if (idx < 0) return { name: trimmed, rest: "" };
  return { name: trimmed.slice(0, idx), rest: trimmed.slice(idx + 1).trim() };
}
