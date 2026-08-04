/**
 * 示例扩展：权限门（block rm -rf 类危险命令，路径保护）
 *
 * 放置：~/.claude-pi/extensions/ 或 .agent/extensions/ 或 claude-pi -e examples/extensions/permission-gate.ts
 */
export default function (pi: {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerTool(tool: unknown): void;
  registerCommand(name: string, handler: (args: string) => string): void;
  appendEntry(customType: string, data?: unknown): string;
}) {
  // 事件：PreToolUse 阻断危险命令（返回非 null 即拦截）
  pi.on("pre_tool_use", (block: { name: string; input: Record<string, unknown> }) => {
    if (block.name === "run_bash" && String(block.input.command ?? "").includes("git push --force")) {
      return "Blocked by permission-gate extension: 禁止 force push";
    }
    if (block.name === "write_file" && String(block.input.path ?? "").includes("node_modules")) {
      return "Blocked by permission-gate extension: 禁止写 node_modules";
    }
    return undefined;
  });

  // 命令：/gate-status 显示扩展状态
  pi.registerCommand("gate-status", () => "permission-gate 扩展已加载");

  // 状态持久化：记录加载次数
  pi.appendEntry("permission-gate", { loadedAt: new Date().toISOString() });
}
