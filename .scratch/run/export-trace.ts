import { SessionManager } from "/home/z9ian9/myproject/claude-pi/src/session-manager.ts";
import { exportSessionToAnalysisTrace } from "/home/z9ian9/myproject/claude-pi/src/session-export.ts";
import fs from "node:fs";

const base = "/tmp/cpi-run-task/.agent/sessions";
const proj = fs.readdirSync(base).find((d) => d.includes("cpi-run-task"));
const dir = `${base}/${proj}`;
if (!proj || !fs.existsSync(dir)) { console.error("no session dir:", base); process.exit(1); }
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
console.log("session files:", files);
const f = files[files.length - 1];
const session = SessionManager.open(`${dir}/${f}`);
console.log("sessionId:", session.getSessionId(), "| entries:", session.getEntries().length, "| branch:", session.getBranch().length);
const out = exportSessionToAnalysisTrace(session, "/tmp/cpi-run-task/trace.jsonl");
console.log("trace →", out);
