import { describe, it, expect } from "vitest";
import { AgentProfile, profileToContext } from "./agent-profile.ts";
import { LoopOptions } from "./loop-options.ts";
import {
  getAgentContext,
  runWithAgentContext,
  setAgentContext,
  createAgentContext,
  isSubagent,
  isTeammate,
  isLead,
} from "./teammates/context.ts";
import { TEAM_LEAD_NAME } from "./teammates/constants.ts";

describe("AgentProfile", () => {
  it("lead / subagent / teammate derive distinct loop strategies", () => {
    const lead = AgentProfile.lead();
    const sub = AgentProfile.subagent();
    const mate = AgentProfile.teammate();

    expect(lead.role).toBe("lead");
    expect(lead.enableMemory).toBe(true);
    expect(lead.injectLeadNotifications).toBe(true);
    expect(lead.useSubagentToolFace).toBe(false);

    expect(sub.role).toBe("subagent");
    expect(sub.enableMemory).toBe(false);
    expect(sub.injectLeadNotifications).toBe(false);
    expect(sub.enableBackground).toBe(false);
    expect(sub.exitOnFinalContent).toBe(true);
    expect(sub.skipMemoryStopHook).toBe(true);
    expect(sub.useSubagentToolFace).toBe(true);
    expect(sub.useSubagentPrompt).toBe(true);

    expect(mate.role).toBe("teammate");
    expect(mate.preserveSystem).toBe(true);
    expect(mate.injectLeadNotifications).toBe(false);
    expect(mate.injectBackgroundNotifications).toBe(true);
    expect(mate.enableBackground).toBe(true);
    expect(mate.useSubagentToolFace).toBe(false);
  });

  it("LoopOptions.fromProfile carries role and strategy", () => {
    const opts = LoopOptions.fromProfile(AgentProfile.subagent());
    expect(opts.role).toBe("subagent");
    expect(opts.isSubagentRole).toBe(true);
    expect(opts.useSubagentToolFace).toBe(true);
    expect(opts.useSubagentPrompt).toBe(true);
    expect(opts.enableMemory).toBe(false);
  });

  it("LoopOptions.subagent/teammate/lead factories match profiles", () => {
    expect(LoopOptions.subagent().role).toBe("subagent");
    expect(LoopOptions.teammate().role).toBe("teammate");
    expect(LoopOptions.lead().role).toBe("lead");
    expect(LoopOptions.fromLegacyIsSubagent(true).role).toBe("subagent");
    expect(LoopOptions.fromLegacyIsSubagent(false).role).toBe("lead");
  });

  it("profileToContext writes role for permission bubble", () => {
    const ctx = profileToContext(
      AgentProfile.subagent({ agentName: "sub-1", agentId: "sub-1", teamName: "default" }),
    );
    expect(isSubagent(ctx)).toBe(true);
    expect(ctx.teamName).toBe("default");
    expect(ctx.agentName).toBe("sub-1");
  });

  it("runWithAgentContext makes subagent role visible to getAgentContext", async () => {
    const profile = AgentProfile.subagent({ agentName: "s", agentId: "s" });
    await runWithAgentContext(profileToContext(profile), async () => {
      const ctx = getAgentContext();
      expect(isSubagent(ctx)).toBe(true);
      expect(ctx.agentName).toBe("s");
    });
  });

  it("setAgentContext persists lead teamName (Lead ALS fix)", () => {
    setAgentContext(
      createAgentContext({
        role: "lead",
        agentName: TEAM_LEAD_NAME,
        teamName: "default",
      }),
    );
    const ctx = getAgentContext();
    expect(isLead(ctx)).toBe(true);
    expect(ctx.teamName).toBe("default");
    expect(ctx.agentName).toBe(TEAM_LEAD_NAME);
  });

  it("fromContext maps ALS role back to profile strategy", () => {
    const mateCtx = createAgentContext({
      role: "teammate",
      agentName: "w1",
      teamName: "t1",
      agentId: "w1@t1",
    });
    const p = AgentProfile.fromContext(mateCtx);
    expect(p.role).toBe("teammate");
    expect(p.preserveSystem).toBe(true);
    expect(p.agentName).toBe("w1");
    expect(isTeammate(mateCtx)).toBe(true);
  });
});
