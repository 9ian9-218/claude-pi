import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpi-production-pack-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with npm run test:pack');
const npm = (args, cwd = root) => exec(process.execPath, [npmCli, ...args], { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, npm_config_cache: path.join(temp, 'cache') } });
let server;
try {
  const packed = JSON.parse((await npm(['pack', '--json', '--pack-destination', temp])).stdout)[0];
  const unexpected = packed.files.filter(f => /(?:\.test\.ts$|(^|\/)\.agent\/|(^|\/)tests\/|auth\.json$)/.test(f.path));
  if (unexpected.length) throw new Error(`Unexpected package files: ${unexpected.map(f => f.path).join(', ')}`);
  const app = path.join(temp, 'app'); fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'production-smoke', private: true, type: 'module' }));
  await npm(['install', '--omit=dev', '--ignore-scripts', path.join(temp, packed.filename)], app);
  const bin = path.join(app, 'node_modules', 'claude-pi', 'bin', 'cpi.js');
  const version = (await exec(process.execPath, [bin, '--version'], { cwd: app })).stdout.trim();
  if (version !== JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version) throw new Error('Installed CLI version mismatch');
  server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'PRODUCTION_PACK_OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = path.join(temp, 'config'); fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, 'models.json'), JSON.stringify({ providers: { smoke: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-test-key', compat: { supportsDeveloperRole: false }, models: [{ id: 'smoke', name: 'smoke', contextWindow: 128000, maxTokens: 8000 }] } } }));
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ defaultModel: 'smoke/smoke', retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } }));
  const json = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, '--mode', 'json', '--no-session', 'Say production ok'], { cwd: app, env: { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; const timer = setTimeout(() => child.kill(), 30000); child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b); child.stdin.end();
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`Installed CLI exit ${code}: ${err.slice(0, 1000)}`)); else resolve(JSON.parse(out)); });
  });
  if (json.status !== 'success' || json.final !== 'PRODUCTION_PACK_OK') throw new Error('Installed CLI did not complete a real local mock request');
  process.stdout.write(JSON.stringify({ status: 'success', node: process.version, platform: process.platform, version, packageFileCount: packed.files.length, excludesTestsAndCredentials: true, productionOnlyInstall: true, jsonRoundTrip: json.status }) + '\n');
} finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } fs.rmSync(temp, { recursive: true, force: true }); }
