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
