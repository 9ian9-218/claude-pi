import { expect, it } from "vitest";
import { TaskBudget } from "../src/task-budget.ts";
it("queues concurrent requests without cancelling the shared task", async () => {
  const budget = new TaskBudget({ concurrency: 1 });
  try {
    const first = await budget.reserveRequestAsync(1, 0);
    const next = budget.reserveRequestAsync(1, 0);
    await Promise.resolve();
    expect(budget.usage.activeRequests).toBe(1); expect(budget.controller.signal.aborted).toBe(false);
    first({ totalTokens: 1 });
    const second = await next; expect(budget.usage.requests).toBe(2);
    second({ totalTokens: 1 }); expect(budget.usage.activeRequests).toBe(0);
  } finally { budget.dispose(); }
});
it("cancels a queued child without cancelling another running child", async () => {
  const budget = new TaskBudget({ concurrency: 1 }), controller = new AbortController();
  try {
    const first = await budget.reserveRequestAsync(1, 0);
    const next = budget.reserveRequestAsync(1, 0, controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(budget.controller.signal.aborted).toBe(false); expect(budget.usage.requests).toBe(1);
    first({ totalTokens: 1 });
  } finally { budget.dispose(); }
});
