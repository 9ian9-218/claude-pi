import { AsyncLocalStorage } from "node:async_hooks";

export interface BudgetLimits { requests?: number; tools?: number; tokens?: number; cost?: number; durationMs?: number; concurrency?: number }
export class BudgetExceeded extends Error { readonly status = "budget_exceeded"; }
export interface BudgetUsage { requests: number; tools: number; tokens: number; cost: number; priceUnknown: boolean; activeRequests: number }

export class TaskBudget {
  readonly controller = new AbortController();
  readonly startedAt = Date.now();
  readonly seenInstructions = new Set<string>();
  readonly usage: BudgetUsage = { requests: 0, tools: 0, tokens: 0, cost: 0, priceUnknown: false, activeRequests: 0 };
  readonly limits: Required<Omit<BudgetLimits, "cost">> & Pick<BudgetLimits, "cost">;
  private reservedTokens = 0;
  private reservedCost = 0;
  private timer: ReturnType<typeof setTimeout>;
  constructor(limits: BudgetLimits = {}) {
    this.limits = { requests: 100, tools: 500, tokens: 1_000_000, durationMs: 1_800_000, concurrency: 6, ...limits };
    for (const [name, value] of Object.entries(this.limits)) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`Invalid ${name} budget`);
    this.timer = setTimeout(() => this.exhaust("Task duration budget exceeded"), this.limits.durationMs);
    this.timer.unref();
  }
  private exhaust(message: string): BudgetExceeded {
    const error = new BudgetExceeded(message);
    this.controller.abort(error);
    return error;
  }
  check(): void {
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
    if (Date.now() - this.startedAt >= this.limits.durationMs) throw this.exhaust("Task duration budget exceeded");
  }
  useTool(): void {
    this.check();
    if (this.usage.tools >= this.limits.tools) throw this.exhaust("Tool budget exceeded");
    this.usage.tools++;
  }
  reserveRequest(tokens: number, estimatedCost: number | null): (usage?: { totalTokens: number; cost?: { total: number } }) => void {
    this.check();
    if (this.usage.requests >= this.limits.requests) throw this.exhaust("Model request budget exceeded");
    if (this.usage.activeRequests >= this.limits.concurrency) throw this.exhaust("Concurrent model request budget exceeded");
    if (this.usage.tokens + this.reservedTokens + tokens > this.limits.tokens) throw this.exhaust("Token budget exceeded before request");
    if (estimatedCost === null) {
      this.usage.priceUnknown = true;
      if (this.limits.cost !== undefined) throw this.exhaust("Cost budget cannot be enforced: model price is unknown");
    }
    if (this.limits.cost !== undefined && this.usage.cost + this.reservedCost + (estimatedCost ?? 0) > this.limits.cost) throw this.exhaust("Cost budget exceeded before request");
    this.usage.requests++; this.usage.activeRequests++; this.reservedTokens += tokens; this.reservedCost += estimatedCost ?? 0;
    let settled = false;
    return usage => {
      if (settled) return;
      settled = true;
      this.usage.activeRequests--; this.reservedTokens -= tokens; this.reservedCost -= estimatedCost ?? 0;
      // Failed requests without usage stay conservatively charged at their reservation.
      this.usage.tokens += usage?.totalTokens ?? tokens;
      this.usage.cost += usage?.cost?.total ?? estimatedCost ?? 0;
      if (this.usage.tokens > this.limits.tokens || (this.limits.cost !== undefined && this.usage.cost > this.limits.cost)) this.exhaust("Provider usage exceeded the reserved budget");
    };
  }
  dispose(): void { clearTimeout(this.timer); }
}
const scope = new AsyncLocalStorage<TaskBudget>();
export function currentBudget(): TaskBudget | undefined { return scope.getStore(); }
export function runWithBudget<T>(budget: TaskBudget, fn: () => T): T { return scope.run(budget, fn); }
export function budgetLimitsFromEnv(): BudgetLimits {
  const limits: BudgetLimits = {};
  for (const [name, env] of Object.entries({ requests: "REQUESTS", tools: "TOOLS", tokens: "TOKENS", cost: "COST", durationMs: "DURATION_MS", concurrency: "CONCURRENCY" })) {
    const raw = process.env[`CLAUDE_PI_MAX_${env}`];
    if (raw !== undefined) (limits as Record<string, number>)[name] = Number(raw);
  }
  return limits;
}
