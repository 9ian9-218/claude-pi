#!/usr/bin/env node
/**
 * 记录型代理：拦截 cpi 发往 opencode zen 的请求，落盘真实请求体并计算
 * 前缀哈希（系统提示 / 工具表 / 逐消息累计前缀），用于判定缓存前缀是否稳定。
 *
 * 用法：node .scratch/eval/proxy.mjs [port]
 * 产物：/tmp/cpi-proxy/index.jsonl + 逐个请求体 JSON
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";

const PORT = Number(process.argv[2] || 8899);
const UPSTREAM = "https://opencode.ai/zen/go/v1";
const DIR = "/tmp/cpi-proxy";
const MODELS = JSON.parse(readFileSync(`${os.homedir()}/.claude-pi-eval/models.json`, "utf8"));
const KEY = MODELS.providers["opencode-go"].apiKey;

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
let seq = 0;
// 启动后目录可能被外部清理；每次写盘前补建，避免诊断工具自身把请求打断
const ensureDir = () => mkdirSync(DIR, { recursive: true });
const sha = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);

const BODY_KEYS = new Set([
  "model", "messages", "tools", "stream", "max_tokens", "max_completion_tokens", "temperature",
  "tool_choice", "reasoning_effort", "prompt_cache_key", "prompt_cache_retention", "stream_options",
  "store", "metadata", "parallel_tool_calls", "response_format", "thinking",
]);

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const id = ++seq;
      const rec = { seq: id, path: req.url, bytes: body.length, t: new Date().toISOString() };
      try {
        const j = JSON.parse(body.toString("utf8"));
        const sys = (j.messages || []).find((m) => m.role === "system" || m.role === "developer");
        const sysText = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
        rec.model = j.model;
        rec.stream = j.stream ?? null;
        rec.nMessages = (j.messages || []).length;
        rec.roles = (j.messages || []).map((m) => m.role);
        rec.sysHash = sys ? sha(sysText) : null;
        rec.sysLen = sysText.length;
        rec.sysRole = sys?.role ?? null;
        rec.nTools = j.tools?.length ?? 0;
        rec.toolsHash = j.tools ? sha(JSON.stringify(j.tools)) : null;
        rec.toolNames = (j.tools || []).map((t) => t.function?.name);
        rec.msgHashes = (j.messages || []).map((m) => sha(JSON.stringify(m)));
        // 逐消息累计前缀哈希：同一位置哈希相同 ⇒ 该处前缀在两次请求间完全一致
        const prefix = [];
        let acc = "";
        for (const m of j.messages || []) {
          acc = sha(acc + sha(JSON.stringify(m)));
          prefix.push(acc);
        }
        rec.prefixHashes = prefix;
        rec.hasCacheKey = "prompt_cache_key" in j;
        rec.cacheKey = j.prompt_cache_key ?? null;
        rec.otherKeys = Object.keys(j).filter((k) => !BODY_KEYS.has(k));
        rec.sampling = { temperature: j.temperature, max_tokens: j.max_tokens, max_completion_tokens: j.max_completion_tokens, reasoning_effort: j.reasoning_effort, stream_options: j.stream_options };
        ensureDir();
        writeFileSync(`${DIR}/${String(id).padStart(3, "0")}.json`, JSON.stringify(j, null, 1));
      } catch (e) {
        rec.parseError = String(e);
      }
      try {
        ensureDir();
        appendFileSync(`${DIR}/index.jsonl`, JSON.stringify(rec) + "\n");
      } catch { /* 记录失败不得影响转发 */ }

      try {
        // 转发原始 content-* 头：漏掉 content-encoding 会让上游把压缩体当 JSON 解析，
        // 返回 "Failed to deserialize"（曾误判为网关抖动）
        const fwd = {
          authorization: "Bearer " + KEY,
          "x-session-id": "cpi-eval-proxy",
          "user-agent": "opencode/1.0",
        };
        for (const h of ["content-type", "content-encoding", "content-length", "accept"]) {
          if (req.headers[h]) fwd[h] = req.headers[h];
        }
        const upstream = await fetch(UPSTREAM + req.url.replace(/^\/v1/, ""), {
          method: "POST",
          headers: fwd,
          body,
        });
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") || "application/json",
          "cache-control": "no-cache",
        });
        if (upstream.body) {
          const reader = upstream.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        }
      } catch (e) {
        rec.proxyError = String(e);
        appendFileSync(`${DIR}/index.jsonl`, JSON.stringify({ seq: id, proxyError: String(e) }) + "\n");
        res.writeHead(502, { "content-type": "application/json" });
        res.write(JSON.stringify({ error: { message: String(e) } }));
      }
      res.end();
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`proxy on http://127.0.0.1:${PORT} -> ${UPSTREAM}  logs=${DIR}`));
