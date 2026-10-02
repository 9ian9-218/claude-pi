import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = process.cwd();
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(root, '.agent', 'evals', timestamp);
fs.mkdirSync(dir, { recursive: true });
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const diff = execFileSync('git', ['diff', '--binary']);
const source = createHash('sha256').update(diff);
for (const file of execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort()) if (fs.statSync(file).isFile()) source.update(file).update(fs.readFileSync(file));
const repetitions = Number(process.env.CLAUDE_PI_EVAL_REPETITIONS ?? 3);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error('Repetitions must be 1..20');
const runs = [];
const expectedTests = 35;
for (let i = 0; i < repetitions; i++) {
  const output = path.join(dir, `run-${i + 1}.json`);
  const start = Date.now();
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/reliability.test.ts', '--maxWorkers=1', '--reporter=json', `--outputFile=${output}`], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  fs.writeFileSync(path.join(dir, `run-${i + 1}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : {};
  runs.push({ attempt: i + 1, exitCode: result.status, durationMs: Date.now() - start, passed: report.numPassedTests ?? 0, failed: report.numFailedTests ?? 0, total: report.numTotalTests ?? 0, skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0), environmentError: result.error?.message ?? null });
}
const manifest = { schemaVersion: 1, kind: 'offline-runtime-fault-regression', timestamp, sourceSha: sha, workingDiffHash: source.digest('hex'), lockfileHash: createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex'), node: process.version, platform: process.platform, model: 'local HTTP mock; no paid API', repetitions, expectedTests, runs, note: 'All attempts including failures are retained. This measures runtime reliability; it is not a SWE-bench or coding-success ranking.', artifacts: dir };
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(root, '.agent', 'evals', 'latest.json'), JSON.stringify(manifest, null, 2));
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
process.exitCode = runs.every(r => r.exitCode === 0 && r.total === expectedTests && r.passed === r.total && r.failed === 0 && r.skipped === 0) ? 0 : 1;
