/**
 * 非侵入式插桩（NODE_OPTIONS=--require 注入，不改被测代码）
 *
 * 1) fetch：记录每次 LLM 出站请求的 payload 结构哈希 → 缓存前缀分析
 * 2) child_process：记录每次 shell 命令的真实退出码 → 轨迹分析
 *    （harness 的 run_bash 只回传 stdout+stderr，丢弃了 r.status；
 *      这里独立记录真相，用于判定「模型看不见的失败」）
 *
 * 只记录，不改变任何行为；任何异常都被吞掉，绝不影响被测进程。
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const cp = require("node:child_process");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const j = (v) => JSON.stringify(v ?? null);

// ---------------------------------------------------------------- fetch 插桩
const FETCH_LOG = process.env.CPI_FETCH_LOG;
if (FETCH_LOG) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function patchedFetch(input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      const body = init?.body ?? (typeof input === "object" ? input?.body : undefined);
      if (body && typeof body === "string" && /\/chat\/completions|\/messages|\/responses/.test(url)) {
        const parsed = JSON.parse(body);
        const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
        const tools = parsed.tools;
        const rows = [];
        const prefixHashes = [];
        let acc = "", systemHash = null;
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          const h = sha(j(m));
          rows.push({ i, role: m.role, hash: h, len: j(m).length });
          acc += h;
          prefixHashes.push(sha(acc));
          if (i === 0 && (m.role === "system" || m.role === "developer")) systemHash = sha(j(m.content));
        }
        fs.appendFileSync(FETCH_LOG, JSON.stringify({
          ts: Date.now(),
          url: url.replace(/\?.*$/, "").replace(/^https?:\/\//, ""),
          bodyHash: sha(body),
          systemHash,
          toolsHash: tools ? sha(j(tools)) : null,
          toolCount: Array.isArray(tools) ? tools.length : 0,
          msgCount: msgs.length,
          msgs: rows,
          msgPrefixHashes: prefixHashes,
          totalChars: body.length,
          model: parsed.model ?? null,
          stream: parsed.stream ?? null,
          maxTokensField: Object.keys(parsed).filter((k) => k === "max_tokens" || k === "max_completion_tokens"),
        }) + "\n");
      }
    } catch (e) {
      if (process.env.CPI_FETCH_LOG_ERRORS) {
        try { fs.appendFileSync(FETCH_LOG + ".err", String((e && e.stack) || e) + "\n"); } catch {}
      }
    }
    return origFetch.apply(this, arguments);
  };
}

// --------------------------------------------------- child_process 插桩
const EXEC_LOG = process.env.CPI_EXEC_LOG;
if (EXEC_LOG) {
  const record = (kind, command, cwd, status, signal, stdout, stderr, startedAt, endedAt) => {
    try {
      const out = String(stdout ?? "");
      const err = String(stderr ?? "");
      fs.appendFileSync(EXEC_LOG, JSON.stringify({
        ts: endedAt,
        startTs: startedAt,
        kind,
        command: String(command ?? ""),
        cwd: String(cwd ?? ""),
        status,
        signal: signal ?? null,
        ms: endedAt - startedAt,
        stdoutLen: out.length,
        stderrLen: err.length,
        combinedLen: out.length + err.length,
        // 只留短摘要，便于人工核对，不存整份输出
        preview: (out + err).trim().slice(0, 300),
      }) + "\n");
    } catch {}
  };

  const origSpawnSync = cp.spawnSync;
  cp.spawnSync = function patchedSpawnSync(command, opts, ...rest) {
    const t0 = Date.now();
    const res = origSpawnSync.call(this, command, opts, ...rest);
    try {
      if (!opts || opts.shell) {
        record("spawnSync", command, opts && opts.cwd, res && res.status, res && res.signal,
          res && res.stdout, res && res.stderr, t0, Date.now());
      }
    } catch {}
    return res;
  };

  const origSpawn = cp.spawn;
  cp.spawn = function patchedSpawn(command, opts, ...rest) {
    const t0 = Date.now();
    const child = origSpawn.call(this, command, opts, ...rest);
    let out = "", err = "";
    try {
      if (!opts || opts.shell) {
        child.stdout && child.stdout.on("data", (d) => (out += d));
        child.stderr && child.stderr.on("data", (d) => (err += d));
        child.on("close", (status, signal) => record("spawn", command, opts && opts.cwd, status, signal, out, err, t0, Date.now()));
      }
    } catch {}
    return child;
  };
}
