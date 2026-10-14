import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "./session-manager.ts";
import { summarizeBranchSwitch } from "./branch-summary.ts";
import { computeUsageTotals } from "./usage-stats.ts";

const complete = vi.hoisted(() => vi.fn());
vi.mock("./client.ts", () => ({ completeTextWithUsage: complete }));
beforeEach(() => complete.mockReset());

describe("optional branch summaries", () => {
  it("summarizes only the abandoned suffix with bounded input and records usage", async () => {
    const session = SessionManager.inMemory("/tmp");
    const root = session.appendMessage({ role: "user", content: "shared-prefix" });
    session.appendMessage({ role: "assistant", content: "old-branch " + "x".repeat(90000) });
    const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } };
    complete.mockResolvedValue({ text: "actual summary", usage });
    const result = await summarizeBranchSwitch(session, root);
    expect(complete).toHaveBeenCalledOnce();
    const [prompt, options] = complete.mock.calls[0];
    expect(prompt.length).toBeLessThan(25000); expect(prompt).toContain("omitted middle");
    expect(prompt).not.toContain("shared-prefix"); expect(options.maxTokens).toBe(1024);
    const from = session.getLeafId()!;
    session.branch(root); session.appendBranchSummary(from, result!.text, result!.usage);
    expect(computeUsageTotals(session.getBranch())).toMatchObject({ input: 10, output: 20, cost: 0.1 });
  });
  it("avoids calls for an empty suffix and preserves navigation on summary failure", async () => {
    const session = SessionManager.inMemory("/tmp");
    const root = session.appendMessage({ role: "user", content: "shared" });
    expect(await summarizeBranchSwitch(session, root)).toBeNull(); expect(complete).not.toHaveBeenCalled();
    const leaf = session.appendMessage({ role: "assistant", content: "old" });
    complete.mockRejectedValue(new Error("timeout"));
    await expect(summarizeBranchSwitch(session, root)).rejects.toThrow("timeout");
    expect(session.getLeafId()).toBe(leaf);
    complete.mockResolvedValue({ text: " " });
    await expect(summarizeBranchSwitch(session, root)).rejects.toThrow("empty");
    expect(session.getLeafId()).toBe(leaf);
  });
});
