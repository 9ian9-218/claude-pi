/**
 * session-commands.ts — TUI 会话命令（15b）
 *
 * /tree 树导航（分支 + branch_summary）/fork /clone /resume /name /session；
 * /export（双模式轨迹导出）/import（导入外部会话，替换当前会话）。
 */
import type { TuiApp } from "./app.ts";
import { SessionManager } from "../session-manager.ts";
import { forkSession } from "../session-fork.ts";
import { summarizeBranchSwitch } from "../branch-summary.ts";
import type { ChatMessage } from "../client.ts";
import { ui } from "./ui-provider.ts";
import {
  parseExportArgs,
  exportSessionToAnalysisTrace,
  exportSessionToPortable,
} from "../session-export.ts";
import { importSessionFromJsonl, SessionImportError } from "../session-import.ts";
import { getExportMode } from "../project-config.ts";

async function restoreSessionView(app: TuiApp, session: SessionManager): Promise<void> {
  const ctx = session.buildSessionContext();
  const { setCurrentModel } = await import("../ai-runtime.ts");
  let warning: string | undefined;
  if (!ctx.model) setCurrentModel(null);
  else if (!await app.restoreModel(ctx.model)) {
    setCurrentModel(null);
    warning = `无法恢复模型 ${ctx.model}，使用配置的默认模型。`;
  }
  await app.restoreThinkingLevel(ctx.thinkingLevel ?? "off");
  app.renderHistory(ctx.messages);
  if (warning) app.appendMessage("system", warning);
}

function navigationArgs(rest: string) {
  const args = rest.trim().split(/\s+/).filter(Boolean);
  const allowed = new Set(["--before", "--after", "--isolated", "--shared", "--summarize"]);
  for (const arg of args) if (arg.startsWith("--") && !allowed.has(arg)) throw new Error(`Unknown option: ${arg}`);
  if (args.includes("--before") && args.includes("--after")) throw new Error("Choose --before or --after");
  if (args.includes("--shared") && args.includes("--isolated")) throw new Error("Choose --shared or --isolated");
  const nodes = args.filter(a => !a.startsWith("--"));
  if (nodes.length > 1) throw new Error("Specify one entry ID");
  return {
    entryId: nodes[0],
    position: args.includes("--before") ? "before" as const : args.includes("--after") ? "after" as const : undefined,
    workspace: args.includes("--isolated") ? "isolated" as const : args.includes("--shared") ? "shared" as const : undefined,
    summarize: args.includes("--summarize"),
  };
}

/** 相对时间（对齐 pi formatSessionDate：now/m/h/d/w/mo/y） */
function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** 会话命令处理（15b）：/tree /fork /clone /resume /name /session */
export async function handleSessionCommand(
  app: TuiApp,
  sessionRef: { current: SessionManager | null },
  name: string,
  rest: string,
): Promise<void> {
  const cwd = sessionRef.current?.getHeader().projectCwd ?? sessionRef.current?.getHeader().cwd ?? process.cwd();
  const session = sessionRef.current;
  switch (name) {
    case "tree": {
      if (!session) {
        app.appendMessage("system", "会话已禁用（--no-session）。");
        return;
      }
      const tree = session.getTreeEntries();
      const args = navigationArgs(rest);
      if (args.workspace) throw new Error("工作区隔离请使用 /fork --isolated 或 /clone --isolated。");

      // 子 agent 会话：从父会话的 custom entry 还原血缘清单（/resume 可复查完整轨迹）
      const appendChildAgents = () => {
        const childAgents = new Map<
          string,
          { role: string; status: string; file: string | null }
        >();
        for (const entry of session.getEntries()) {
          if (entry.type !== "custom") continue;
          const custom = entry as { customType?: string; data?: Record<string, unknown> };
          const data = custom.data ?? {};
          if (custom.customType === "subagent") {
            const agentId = String(data["agentId"] ?? "");
            if (!agentId) continue;
            childAgents.set(agentId, {
              role: String(data["role"] ?? "subagent"),
              status: "running",
              file: data["sessionFile"] ? String(data["sessionFile"]) : null,
            });
          } else if (custom.customType === "subagent_end") {
            const agentId = String(data["agentId"] ?? "");
            const existing = childAgents.get(agentId);
            if (existing) existing.status = String(data["status"] ?? "done");
          }
        }
        if (childAgents.size === 0) return;
        const lines = ["子 agent 会话（/resume 可复查完整轨迹）："];
        for (const [agentId, info] of childAgents) {
          const file = info.file ? info.file.split("/").pop() : "(未落盘)";
          const icon = info.status === "done" ? "✓" : info.status === "failed" ? "✗" : "⣾";
          lines.push(`  ${icon} ${agentId} · ${info.role} · ${file}`);
        }
        app.appendMessage("system", lines.join("\n"));
      };
      appendChildAgents();
      if (tree.length === 0) {
        app.appendMessage("system", "会话为空。");
        return;
      }
      const items = tree.map(({ entry: e, depth, active }) => ({
        value: e.id,
        label: `${active ? "●" : "○"} ${"  ".repeat(Math.min(depth, 12))}` + (
          e.type === "message"
            ? `${(e as { message: ChatMessage }).message.role}: ${String((e as { message: ChatMessage }).message.content ?? "").slice(0, 60)}`
            : `${e.type} (${e.id})`),
        description: `${e.id} (${e.timestamp})`,
      }));
      const picked = args.entryId ? { value: args.entryId } : await app.showSelector(items, "完整会话树 — user 默认回到消息之前，其余节点之后");
      if (!picked) {
        app.appendMessage("system", "已取消。");
        return;
      }
      if (session.isConcurrent()) throw new Error("会话正在被另一实例使用，请 fork 到新文件后继续。");
      const entry = session.getEntry(picked.value);
      if (!entry) throw new Error(`Unknown entry: ${picked.value}`);
      const isUser = entry.type === "message" && entry.message.role === "user";
      const before = args.position === "before" || (args.position === undefined && isUser);
      const targetId = before ? entry.parentId : entry.id;
      const fromLeaf = session.getLeafId();
      // Generate before navigation so failed requests cannot leave a half-switched session.
      const summary = args.summarize ? await summarizeBranchSwitch(session, targetId) : null;
      if (targetId) session.branch(targetId); else session.resetLeaf();
      if (summary) session.appendBranchSummary(fromLeaf ?? "", summary.text, summary.usage);
      await restoreSessionView(app, session);
      app.editor.setText(before && isUser ? String(entry.message.content ?? "") : "");
      app.appendMessage("system", `已切换到 ${picked.value} ${before ? "之前" : "之后"}${summary ? "（已生成分支摘要）" : ""}`);
      appendChildAgents();
      return;
    }
    case "fork":
    case "clone": {
      if (!session) {
        app.appendMessage("system", "会话已禁用（--no-session）。");
        return;
      }
      const args = navigationArgs(rest);
      if (args.summarize) throw new Error("--summarize 仅用于 /tree。");
      let entryId = args.entryId;
      if (name === "fork" && !entryId) {
        const items = session.getTreeEntries().map(({ entry, depth, active }) => ({
          value: entry.id,
          label: `${active ? "●" : "○"} ${"  ".repeat(Math.min(depth, 12))}${entry.type === "message" ? `${entry.message.role}: ${String(entry.message.content ?? "").slice(0, 60)}` : entry.type}`,
          description: entry.id,
        }));
        if (!items.length) { app.appendMessage("system", "会话为空。"); return; }
        const picked = await app.showSelector(items, "Fork — 选择任意历史节点（含旧分支）");
        if (!picked) { app.appendMessage("system", "已取消。"); return; }
        entryId = picked.value;
      }
      const selected = entryId ? session.getEntry(entryId) : null;
      const isUser = selected?.type === "message" && selected.message.role === "user";
      const position = args.position ?? (name === "fork" && isUser ? "before" : "after");
      const target = await forkSession(session, { entryId, position, workspace: args.workspace });
      session?.close();
      sessionRef.current = target;
      await restoreSessionView(app, target);
      app.editor.setText(position === "before" && isUser ? String(selected.message.content ?? "") : "");
      app.appendMessage(
        "system",
        `已${name === "clone" ? "clone" : "fork"}到新会话 ${target.getSessionId().slice(0, 8)}（${target.getSessionFile()}）`,
      );
      return;
    }
    case "resume": {
      const list = SessionManager.list(cwd);
      if (list.length === 0) {
        app.appendMessage("system", "无历史会话。");
        return;
      }
      // 对齐 pi SessionSelector：label = 会话名 ?? 首条 user 消息预览，
      // description = 消息数 + 相对时间（按最后活动降序）
      const items = list.map((s) => ({
        value: s.path,
        label: ((s.name ?? s.firstMessage) || s.id.slice(0, 8)).slice(0, 40),
        description: `${s.messageCount} msgs · ${relativeTime(s.lastActivity)}`,
      }));
      const picked = await app.showSelector(items, "Resume — 选择会话");
      if (!picked) {
        app.appendMessage("system", "已取消。");
        return;
      }
      const restored = session?.getSessionFile() === picked.value ? session : SessionManager.open(picked.value);
      if (session !== restored) session?.close();
      sessionRef.current = restored;
      // 对齐 pi renderSessionItems：恢复后渲染完整历史（可滚动查看）
      await restoreSessionView(app, restored);
      app.appendMessage("system", `已恢复会话 ${picked.value}`);
      return;
    }
    case "name": {
      if (!session) {
        app.appendMessage("system", "会话已禁用（--no-session）。");
        return;
      }
      const name_ = rest || `session-${session.getSessionId().slice(0, 8)}`;
      session.appendSessionInfo(name_);
      app.appendMessage("system", `会话名已设为：${name_}`);
      return;
    }
    case "session": {
      if (!session) {
        app.appendMessage("system", "会话已禁用（--no-session）。");
        return;
      }
      const leaf = session.getLeafId();
      const entries = session.getEntries();
      app.appendMessage(
        "system",
        [
          `ID: ${session.getSessionId()}`,
          `文件: ${session.getSessionFile() ?? "(in-memory)"}`,
          `Leaf: ${leaf ?? "(空)"}`,
          `Entries: ${entries.length}`,
          `名称: ${session.getSessionName() ?? "(未命名)"}`,
          `父会话: ${session.getHeader().parentSession ?? "(无)"}`,
          `工作目录: ${session.getHeader().cwd}`,
          `工作区: ${session.getHeader().workspace?.id ?? "共享目录"}`,
          `快照: ${session.getHeader().workspace?.baseSha ?? "(无)"}`,
        ].join("\n"),
      );
      return;
    }
    case "memory-refresh": {
      const { isMemoryEnabled } = await import("../settings.ts");
      if (!isMemoryEnabled()) {
        app.appendMessage("system", "记忆功能已关闭（/settings → 记忆功能）。开启后再刷新快照。");
        return;
      }
      const { refreshMemorySnapshot } = await import("../memory-scope.ts");
      const messages = session ? session.buildSessionContext().messages : [];
      const snapshot = await refreshMemorySnapshot(messages, session?.sessionId ?? null);
      const indexLines = snapshot.index ? snapshot.index.split("\n").length : 0;
      const injectedNote = snapshot.injected
        ? `相关性记忆已注入（${snapshot.injected.length} 字符）`
        : "本次没有命中相关性记忆";
      app.appendMessage(
        "system",
        [
          "记忆快照已刷新（本会话立即生效）。",
          "⚠ 这会开启新的 prompt 前缀：本会话此前缓存的 system/消息前缀从下一次请求起不再复用，下一次请求会重新 cache write；之后按新前缀继续累积缓存。",
          `MEMORY.md 索引: ${indexLines} 行 · ${injectedNote}`,
        ].join("\n"),
      );
      return;
    }

    case "compact": {
      if (!session) {
        app.appendMessage("system", "会话已禁用（--no-session）。");
        return;
      }
      if (session.getBranch().length === 0) {
        app.appendMessage("system", "会话为空，无需压缩。");
        return;
      }
      // 手动 = 强制压（不看阈值）：与自动压缩共用 compactContext
      const { compactContext } = await import("../compact.ts");
      const instructions = rest.trim();
      try {
        const out = await compactContext(session.buildSessionContext().messages, {
          session,
          ...(instructions ? { instructions } : {}),
        });
        if (out.skipped) {
          app.appendSystem("暂无新增对话需要压缩。");
          return;
        }
        app.appendSystem(
          `已压缩：${out.tokensBefore} → ≈${out.tokensAfter} tokens` +
            `（检查点已写入会话树${out.checkpointId ? ` ${out.checkpointId}` : ""}` +
            `${out.reusedFrom ? "，复用已有摘要" : ""}）`,
          "success",
        );
      } catch (e) {
        app.appendSystem(
          `压缩失败：${e instanceof Error ? e.message : String(e)}。` +
            "可以回退几轮再试（/tree 切到更早节点后重发）。",
          "error",
        );
      }
      return;
    }
    case "export": {
      if (!session) {
        app.appendMessage("system", "会话已禁用（--no-session）。");
        return;
      }
      try {
        const args = parseExportArgs(rest);
        // 模式：参数临时覆盖 > 项目配置（/settings 中设置）；
        // 默认路径由导出函数内部决定（模式相关），args.path 显式指定时覆盖
        const mode = args.mode ?? getExportMode();
        const output =
          mode === "portable"
            ? exportSessionToPortable(session, args.path)
            : exportSessionToAnalysisTrace(session, args.path);
        app.appendMessage(
          "system",
          `已导出（${mode === "analysis" ? "分析模式：整树 + 耗时/token 明细" : "会话移植模式：活动分支"}）→ ${output}`,
        );
      } catch (e) {
        app.appendSystem(`导出失败：${(e as Error).message}`, "warning");
      }
      return;
    }
    case "import": {
      const inputPath = rest.trim();
      if (!inputPath) {
        app.appendSystem("用法：/import <路径.jsonl>", "warning");
        return;
      }
      const confirmed = await ui.confirm("导入会话", false);
      if (!confirmed) {
        app.appendMessage("system", "已取消。");
        return;
      }
      try {
        const imported = importSessionFromJsonl(inputPath, process.cwd());
        session?.close();
        sessionRef.current = imported;
        app.renderHistory(imported.buildSessionContext().messages);
        app.appendMessage(
          "system",
          `已导入会话（共 ${imported.getBranch().length} 条记录）→ ${imported.getSessionFile()}`,
        );
      } catch (e) {
        if (e instanceof SessionImportError) {
          app.appendSystem(`导入失败：${e.message}`, "warning");
        } else {
          app.appendSystem(`导入失败：${String((e as Error).message)}`, "warning");
        }
      }
      return;
    }
    default:
      app.appendMessage("system", `未知命令：/${name}（/help 查看）`);
  }
}
