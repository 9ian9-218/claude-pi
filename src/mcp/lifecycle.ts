import { MCPHub, getMCPHub } from "./hub.ts";

/** Shared by CLI modes; connects before work and joins process cleanup on every exit path. */
export async function withMcpLifecycle<T>(work: (signal: AbortSignal) => Promise<T>, hub: MCPHub = getMCPHub()): Promise<T | undefined> {
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort(new DOMException("Interrupted by user", "AbortError"));
    process.exitCode = 130;
    void hub.shutdown().catch(() => {});
  };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    await hub.connectFromConfig(controller.signal);
    if (controller.signal.aborted) return;
    return await work(controller.signal);
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    await hub.shutdown();
  }
}
