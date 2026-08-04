/**
 * mock-openai.ts — 本地 HTTP mock OpenAI 服务器（CI 可跑，无需真实 key）
 *
 * 实现 POST /v1/chat/completions，支持 SSE 流式与非流式 JSON 响应。
 * 每次请求消费一个 responder；用完后默认返回空 "stop" 回复。
 */
import http from "node:http";

export interface MockSseChunk {
  content?: string;
  toolCalls?: Array<{
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }>;
  finishReason?: string | null;
}

export type MockResponse =
  | { kind: "sse"; chunks: MockSseChunk[] }
  | { kind: "json"; content: string; finishReason?: string }
  | { kind: "error"; status: number; body: string };

export interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }>;
  stream?: boolean;
  max_tokens?: number;
  tools?: unknown;
  tool_choice?: unknown;
}

export type Responder = (req: ChatRequest) => MockResponse;

function sseEncode(chunks: MockSseChunk[]): string {
  const lines: string[] = [];
  for (const c of chunks) {
    const delta: Record<string, unknown> = {};
    if (c.content !== undefined) delta.content = c.content;
    if (c.toolCalls) {
      delta.tool_calls = c.toolCalls.map((tc) => {
        const fn: Record<string, string> = {};
        if (tc.name !== undefined) fn.name = tc.name;
        if (tc.arguments !== undefined) fn.arguments = tc.arguments;
        return {
          index: tc.index,
          ...(tc.id !== undefined ? { id: tc.id } : {}),
          ...(Object.keys(fn).length > 0 ? { function: fn } : {}),
        };
      });
    }
    lines.push(
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta,
            finish_reason: c.finishReason !== undefined ? c.finishReason : null,
          },
        ],
      })}\n\n`,
    );
  }
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

export class MockOpenAI {
  private server: http.Server;
  private responders: Responder[] = [];
  private _requests: ChatRequest[] = [];
  private _port = 0;

  get port(): number {
    return this._port;
  }
  private closed = false;

  private constructor() {
    this.server = http.createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw) as ChatRequest;
        this._requests.push(body);
        const responder = this.responders.shift();
        const resp: MockResponse = responder
          ? responder(body)
          : { kind: "sse", chunks: [] };
        if (resp.kind === "error") {
          res.writeHead(resp.status, { "content-type": "application/json" }).end(resp.body);
          return;
        }
        if (body.stream || resp.kind === "sse") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(sseEncode(resp.kind === "sse" ? resp.chunks : []));
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion",
              created: 0,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: resp.kind === "json" ? resp.content : null },
                  finish_reason: resp.kind === "json" ? resp.finishReason ?? "stop" : "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        }
      });
    });
    this.server.listen(0, "127.0.0.1");
    // 端口在 listening 后有效；create() 中等待
  }

  /** 异步工厂：等待监听就绪后返回实例 */
  static async create(): Promise<MockOpenAI> {
    const instance = new MockOpenAI();
    await new Promise<void>((resolve, reject) => {
      instance.server.once("listening", resolve);
      instance.server.once("error", reject);
    });
    const addr = instance.server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("mock server listen failed");
    }
    instance._port = addr.port;
    return instance;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  get requests(): ChatRequest[] {
    return [...this._requests];
  }

  /** 追加响应（按请求顺序消费）；未消费完的请求得到空回复 */
  push(responder: Responder): void {
    this.responders.push(responder);
  }

  /** 所有后续请求都返回同一响应 */
  always(responder: Responder): void {
    for (let i = 0; i < 16; i++) this.responders.push(responder);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
