/** Resource limits are enforced before JSON parsing as well as after validation. */
export interface McpLimits {
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  failureThreshold: number;
  cooldownMs: number;
  maxRestarts: number;
  maxConcurrentRequests: number;
  maxFrameBytes: number;
  maxJsonDepth: number;
  maxJsonTokens: number;
  maxMessagesPerSecond: number;
  maxStdoutBytesPerSecond: number;
  maxStderrBytesPerSecond: number;
  maxProtocolErrors: number;
  stderrTailBytes: number;
  maxToolOutputBytes: number;
  maxTools: number;
  maxToolMetadataBytes: number;
}

export const DEFAULT_MCP_LIMITS: Readonly<McpLimits> = Object.freeze({
  startupTimeoutMs: 30_000, requestTimeoutMs: 60_000, shutdownGraceMs: 500,
  failureThreshold: 3, cooldownMs: 30_000, maxRestarts: 2, maxConcurrentRequests: 4,
  maxFrameBytes: 1024 * 1024, maxJsonDepth: 64, maxJsonTokens: 50_000,
  maxMessagesPerSecond: 200, maxStdoutBytesPerSecond: 4 * 1024 * 1024,
  maxStderrBytesPerSecond: 4 * 1024 * 1024, maxProtocolErrors: 3,
  stderrTailBytes: 16 * 1024, maxToolOutputBytes: 64 * 1024,
  maxTools: 128, maxToolMetadataBytes: 256 * 1024,
});

export function resolveMcpLimits(raw: unknown = {}): McpLimits {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MCP limits must be an object");
  const result = { ...DEFAULT_MCP_LIMITS };
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULT_MCP_LIMITS, key)) throw new Error(`Unknown MCP limit '${key}'`);
    const zeroAllowed = key === "maxRestarts";
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zeroAllowed ? 0 : 1) || value > 1_073_741_824) throw new Error(`Invalid MCP limit '${key}'`);
    (result as unknown as Record<string, number>)[key] = value;
  }
  // Keep parser work bounded even if a project requests excessive limits.
  if (result.maxToolOutputBytes < 128) throw new Error("MCP output byte limit must be at least 128");
  if (result.startupTimeoutMs > 120_000 || result.requestTimeoutMs > 300_000 || result.shutdownGraceMs > 2000 || result.failureThreshold > 10 || result.cooldownMs > 3_600_000 || result.maxProtocolErrors > 100 || result.maxJsonDepth > 128 || result.maxFrameBytes > 10 * 1024 * 1024 || result.maxJsonTokens > 100_000 || result.maxMessagesPerSecond > 10_000 || result.maxRestarts > 10 || result.maxConcurrentRequests > 32 || result.maxTools > 512 || result.maxToolOutputBytes > 1024 * 1024 || result.stderrTailBytes > 256 * 1024 || result.maxToolMetadataBytes > 512 * 1024 || result.maxStdoutBytesPerSecond > 64 * 1024 * 1024 || result.maxStderrBytesPerSecond > 64 * 1024 * 1024) throw new Error("MCP limits exceed supported safety ceilings");
  return result;
}

/** Lexical bounds run before JSON.parse; quoted delimiters do not count. */
export function checkJsonComplexity(text: string, limits: McpLimits): void {
  let depth = 0, tokens = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; tokens++; }
    else if (char === "{" || char === "[") { depth++; tokens++; }
    else if (char === "}" || char === "]") depth--;
    else if (char === "," || char === ":") tokens++;
    if (depth > limits.maxJsonDepth || tokens > limits.maxJsonTokens) throw new Error("MCP JSON complexity limit exceeded");
  }
}

/** Removes terminal escape sequences and non-printing controls; does not certify text as trusted. */
export function cleanMcpText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[^\n]?/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

export function limitUtf8(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = Math.max(0, bytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}
