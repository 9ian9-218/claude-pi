import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { setTeamsDir } from "../src/teammates/constants.ts";
import { writeToMailbox, readMailbox, acknowledgeMessages, getInboxPath } from "../src/teammates/mailbox.ts";
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-ack-")); setTeamsDir(dir); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
it("preserves arrivals and protocol responses after a consumer snapshot", async () => {
  await writeToMailbox("worker", { from: "lead", text: "first" }, "team");
  const snapshot = readMailbox("worker", "team");
  await writeToMailbox("worker", { from: "lead", text: "second" }, "team");
  await writeToMailbox("worker", { from: "lead", text: '{"type":"permission_response","request_id":"r"}' }, "team");
  await acknowledgeMessages("worker", "team", snapshot.map(m => m.id!));
  expect(readMailbox("worker", "team").map(m => m.read)).toEqual([true, false, false]);
});
it("retains a corrupt mailbox and refuses to overwrite it", async () => {
  await writeToMailbox("worker", { from: "lead", text: "first" }, "team");
  const file = getInboxPath("worker", "team"); fs.writeFileSync(file, "{bad");
  await expect(writeToMailbox("worker", { from: "lead", text: "new" }, "team")).rejects.toThrow("Corrupt mailbox");
  expect(fs.readFileSync(file, "utf8")).toBe("{bad");
});

it("replays an unacknowledged persisted delivery without a second injection", async () => {
  const { SessionManager } = await import("../src/session-manager.ts");
  const { pollOnce, deliverPendingMessages, clearPollerQueues } = await import("../src/teammates/poller.ts");
  const { createTeam } = await import("../src/teammates/team-helpers.ts");
  createTeam("durable");
  await writeToMailbox("team-lead", { from: "worker", text: "result" }, "durable");
  const ids = readMailbox("team-lead", "durable").map(m => m.id!);
  const marker = "\n[Mailbox delivery: durable:" + ids.join(",") + "]";
  const session = SessionManager.create(dir, path.join(dir, "sessions"));
  session.appendMessage({ role: "user", content: "already persisted" + marker });
  clearPollerQueues(); await pollOnce("durable");
  const messages: import("../src/client.ts").ChatMessage[] = [];
  await deliverPendingMessages(session, messages);
  expect(messages).toHaveLength(0); expect(readMailbox("team-lead", "durable")[0].read).toBe(true);
  session.close(); clearPollerQueues();
});
