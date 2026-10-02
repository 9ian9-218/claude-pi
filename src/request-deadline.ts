export class RequestTimeout extends Error { readonly status = "timeout"; partialText?: string; }

export function requestDeadline(signal?: AbortSignal) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const configured = (key: string, fallback: number) => {
    const raw = Number(process.env[key]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  const totalMs = configured("CLAUDE_PI_REQUEST_TIMEOUT_MS", 300_000);
  const firstMs = configured("CLAUDE_PI_FIRST_TOKEN_TIMEOUT_MS", 60_000);
  const idleMs = configured("CLAUDE_PI_STREAM_IDLE_TIMEOUT_MS", 60_000);
  const timeout = (phase: string) => controller.abort(new RequestTimeout(`Model ${phase} timeout`));
  const total = setTimeout(() => timeout("request"), totalMs);
  let idle = setTimeout(() => timeout("first token"), firstMs);
  return {
    signal: combined,
    activity() { clearTimeout(idle); idle = setTimeout(() => timeout("stream idle"), idleMs); },
    async wait<T>(promise: Promise<T>): Promise<T> {
      if (combined.aborted) throw combined.reason;
      let abort: () => void = () => {};
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          abort = () => reject(combined.reason ?? new Error("Request cancelled"));
          combined.addEventListener("abort", abort, { once: true });
        })]);
      } finally { combined.removeEventListener("abort", abort); }
    },
    dispose() { clearTimeout(total); clearTimeout(idle); },
  };
}
