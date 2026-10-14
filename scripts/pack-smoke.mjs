import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'cpi-pack-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with npm run test:pack');
const npm = (args, cwd = root, maxBuffer = 4 * 1024 * 1024) => {
  const task = exec(process.execPath, [npmCli, ...args], { cwd, timeout: 300_000, maxBuffer, env: { ...process.env } });
  task.child.stdin?.end(); return task;
};
let server;
try {
  const packResult = JSON.parse((await npm(['pack', '--json', '--pack-destination', temp], root, 32 * 1024 * 1024)).stdout);
  const packed = Array.isArray(packResult) ? packResult[0] : packResult.files ? packResult : Object.values(packResult)[0];
  if (!packed?.files?.length) throw new Error('npm pack returned no file manifest');
  if (!packed.files.some(f => f.path.startsWith('node_modules/'))) throw new Error('Production package must bundle its tested dependencies');
  const locked = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const unexpected = packed.files.filter(f => !f.path.startsWith('node_modules/') && /(?:\.test\.ts$|(^|\/)\.agent\/|(^|\/)tests\/|auth\.json$)/.test(f.path));
  if (unexpected.length) throw new Error(`Unexpected package files: ${unexpected.map(f => f.path).join(', ')}`);
  const app = path.join(temp, 'app'); fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'production-smoke', private: true, type: 'module' }));
  process.stdout.write('Installing production-only package dependencies\n');
  const installLogs = path.join(temp, 'npm-logs');
  // Supplying the name avoids Arborist extracting a local tarball just to discover it.
  const packageSpec = 'claude-pi@file:' + path.join(temp, packed.filename);
  try {
    await npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--timing', '--loglevel=verbose', '--logs-dir=' + installLogs, packageSpec], app);
  } catch (error) {
    if (fs.existsSync(installLogs)) for (const filename of fs.readdirSync(installLogs)) {
      if (filename.endsWith('.log') || filename.endsWith('-timing.json')) {
        const lines = fs.readFileSync(path.join(installLogs, filename), 'utf8').split('\n');
        process.stderr.write('npm diagnostic ' + filename + '\n' + lines.slice(-100).join('\n') + '\n');
      }
    }
    throw error;
  }
  process.stdout.write('Verifying installed dependency versions\n');
  const installedRoot = path.join(app, 'node_modules', 'claude-pi');
  const requireFromPackage = createRequire(path.join(installedRoot, 'package.json'));
  for (const name of Object.keys(locked.packages[''].dependencies)) {
    const manifest = (requireFromPackage.resolve.paths(name) ?? []).map(directory => path.join(directory, name, 'package.json')).find(file => fs.existsSync(file));
    if (!manifest) throw new Error('Cannot verify installed dependency: ' + name);
    const dependency = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (dependency.version !== locked.packages['node_modules/' + name].version) throw new Error('Installed dependency version drift: ' + name);
  }
  const bin = path.join(installedRoot, 'bin', 'cpi.js');
  process.stdout.write('Running installed CLI version probe\n');
  const versionTask = exec(process.execPath, [bin, '--version'], { cwd: app, timeout: 30000 });
  versionTask.child.stdin?.end();
  const version = (await versionTask).stdout.trim();
  if (version !== JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version) throw new Error('Installed CLI version mismatch');
  server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'PRODUCTION_PACK_OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = path.join(temp, 'config'); fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, 'models.json'), JSON.stringify({ providers: { smoke: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-test-key', compat: { supportsDeveloperRole: false }, models: [{ id: 'smoke', name: 'smoke', contextWindow: 128000, maxTokens: 8000 }] } } }));
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ defaultModel: 'smoke/smoke', retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } }));
  process.stdout.write('Running installed CLI request probe\n');
  const json = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, '--mode', 'json', '--no-session', 'Say production ok'], { cwd: app, env: { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; const timer = setTimeout(() => child.kill(), 30000); child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b); child.stdin.end();
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`Installed CLI exit ${code}: ${err.slice(0, 1000)}`)); else resolve(JSON.parse(out)); });
  });
  if (json.status !== 'success' || json.final !== 'PRODUCTION_PACK_OK') throw new Error('Installed CLI did not complete a real local mock request');
  process.stdout.write(JSON.stringify({ status: 'success', node: process.version, platform: process.platform, version, packageFileCount: packed.files.length, excludesTestsAndCredentials: true, productionOnlyInstall: true, dependencyVersionsLocked: true, platformSpecificBundle: true, jsonRoundTrip: json.status }) + '\n');
} finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } fs.rmSync(temp, { recursive: true, force: true }); }
