import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = process.cwd();
const dir = path.join(root, '.agent', 'evals', 'coding-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cpi-coding-smoke-'));
fs.mkdirSync(path.join(workspace, 'src')); fs.mkdirSync(path.join(workspace, 'tests'));
fs.writeFileSync(path.join(workspace, 'package.json'), '{"private":true,"type":"module","scripts":{"test":"node --test"}}');
fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Only modify src/port.js. Tests are the external contract and must remain unchanged. Do not delegate this small task. Use run_verification with command node --test and report its actual exit code.');
fs.writeFileSync(path.join(workspace, 'src', 'port.js'), 'export function normalizePort(value) { return parseInt(value, 10) || 3000; }\n');
const tests = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizePort} from '../src/port.js';
for (const [value, expected] of [[1,1],[65535,65535],[3000,3000],[' 8080 ',8080],['00080',80]]) test('accept '+String(value),()=>assert.equal(normalizePort(value),expected));
for (const value of [0,-1,65536,1.5,NaN,Infinity,null,undefined,true,false,{},[], '', '  ', '80x', '1.5', '-1','0x50']) test('reject '+String(value),()=>assert.throws(()=>normalizePort(value),RangeError));
`;
const testPath = path.join(workspace, 'tests', 'port.test.js'); fs.writeFileSync(testPath, tests);
const hash = value => createHash('sha256').update(value).digest('hex');
const runTests = () => spawnSync(process.execPath, ['--test'], { cwd: workspace, encoding: 'utf8', timeout: 15000 });
const baseline = runTests(); fs.writeFileSync(path.join(dir, 'baseline.log'), baseline.stdout + baseline.stderr);
if (baseline.status === 0) throw new Error('Fault fixture did not fail before the agent; invalid evaluation');
const start = Date.now();
let code, result;
try {
  const output = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(root, 'bin', 'cpi.js'), '--mode', 'json', '--no-session', 'Fix normalizePort in src/port.js to satisfy the unchanged tests: accept integer ports 1..65535 and trimmed digit-only strings; reject all other values with RangeError. Read repository guidance, use run_verification, fix only the implementation, verify again and report concise results.'], { cwd: workspace, timeout: 190000, maxBuffer: 4*1024*1024, env: { ...process.env, PI_OFFLINE: '1', NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? '1', CLAUDE_PI_MAX_REQUESTS: '10', CLAUDE_PI_MAX_TOOLS: '24', CLAUDE_PI_MAX_TOKENS: '300000', CLAUDE_PI_MAX_DURATION_MS: '180000', CLAUDE_PI_REQUEST_TIMEOUT_MS: '60000', CLAUDE_PI_FIRST_TOKEN_TIMEOUT_MS: '45000' } }, (error, stdout, stderr) => {
      fs.writeFileSync(path.join(dir, 'agent.json'), stdout); fs.writeFileSync(path.join(dir, 'agent.stderr.log'), stderr);
      code = error ? Number(error.code) || 1 : 0; resolve(stdout);
    }); child.stdin.end(); child.on('error', reject);
  });
  result = JSON.parse(output);
} catch (error) { code = 1; result = { status: 'error', error: String(error) }; }
const final = runTests(); fs.writeFileSync(path.join(dir, 'final.log'), final.stdout + final.stderr);
const testFileUnchanged = hash(fs.readFileSync(testPath)) === hash(tests);
const status = code === 0 && result.status === 'success' && final.status === 0 && testFileUnchanged ? 'success' : 'error';
const manifest = { kind: 'live-small-coding-smoke', status, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding:'utf8'}).trim(), workingDiffHash: hash(execFileSync('git', ['diff', '--binary'], {cwd: root})), task: 'normalize-port-23-original-tests', baselineExitCode: baseline.status, agentExitCode: code, runStatus: result.status, finalTestExitCode: final.status, testFileUnchanged, durationMs: Date.now()-start, budget: result.budget, workspace, artifacts: dir, note: 'Uses the configured live API and consumes request budget. One task is an integration check, not a coding benchmark ranking.' };
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
process.stdout.write(JSON.stringify(manifest, null, 2)+'\n'); process.exitCode = status === 'success' ? 0 : 1;
