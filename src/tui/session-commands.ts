/**
 * session-commands.ts — TUI 会话命令（15b）
 *
 * /tree 树导航（分支 + branch_summary）/fork /clone /resume /name /session。
 */
import type { TuiApp } from "./app.ts";
import { SessionManager } from "../session-manager.ts";
import type { ChatMessage } from "../client.ts";

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
  const cwd = process.cwd();
  const session = sessionRef.current;
  switch (name) {
    case "tree": {
      if (!session) {
        app.appendMessage("system", "会话已禁用（--no-session）。");
        return;
      }
      const branch = session.getBranch();
      if (branch.length === 0) {
        app.appendMessage("system", "会话为空。");
        return;
      }
      const items = branch.map((e) => ({
        value: e.id,
        label:
          e.type === "message"
            ? `${(e as { message: ChatMessage }).message.role}: ${String((e as { message: ChatMessage }).message.content ?? "").slice(0, 60)}`
            : `${e.type} (${e.id})`,
        description: `${e.id} (${e.timestamp})`,
      }));
      const picked = await app.showSelector(items, "会话树 — 选择节点继续（分支）");
      if (!picked) {
        app.appendMessage("system", "已取消。");
        return;
      }
      const fromLeaf = session.getLeafId();
      session.branchWithSummary(picked.value, `[branch switch] 从 ${fromLeaf ?? "根"} 切换到 ${picked.value}`);
      const ctx = session.buildSessionContext();
      app.refreshChat(
        ctx.messages
          .slice(-8)
          .map((m) => `${m.role}: ${String(m.content ?? "").slice(0, 100)}`)
          .join("\n"),
      );
      app.appendMessage("system", `已切换到 ${picked.value}（branch_summary 已记录）`);
      return;
    }
    case "fork":
    case "clone": {
      if (!session) {
        app.appendMessage("system", "会话已禁用（--no-session）。");
        return;
      }
      let target: SessionManager;
      if (name === "clone") {
        target = session.createBranchedSession();
      } else {
        // fork：选择历史 user 消息节点
        const branch = session.getBranch();
        const userEntries = branch.filter(
          (e) => e.type === "message" && (e as { message: ChatMessage }).message.role === "user",
        );
        const items = userEntries.map((e) => ({
          value: e.id,
          label: String((e as { message: ChatMessage }).message.content ?? "").slice(0, 60),
          description: e.id,
        }));
        const picked = await app.showSelector(items, "Fork — 选择起始 user 消息");
        if (!picked) {
          app.appendMessage("system", "已取消。");
          return;
        }
        target = session.createBranchedSession(picked.value);
      }
      sessionRef.current = target;
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
      const restored = SessionManager.open(picked.value);
      sessionRef.current = restored;
      // 对齐 pi renderSessionItems：恢复后渲染完整历史（可滚动查看）
      app.renderHistory(restored.buildSessionContext().messages);
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
        ].join("\n"),
      );
      return;
    }
    default:
      app.appendMessage("system", `未知命令：/${name}（/help 查看）`);
  }
}

