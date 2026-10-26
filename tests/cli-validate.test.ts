import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const distIndex = path.join(repoRoot, 'dist', 'index.js');
const hasDist = fs.existsSync(distIndex);
const describeCli = hasDist ? describe : describe.skip;

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distIndex, ...args], { cwd: repoRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describeCli('validate command', () => {
  let tmpDir: string;
  let validDir: string;
  let invalidDir: string;
  let emptyDir: string;
  let includeDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarii-validate-'));
    validDir = path.join(tmpDir, 'valid');
    invalidDir = path.join(tmpDir, 'invalid');
    emptyDir = path.join(tmpDir, 'empty');
    includeDir = path.join(tmpDir, 'include');
    for (const dir of [validDir, invalidDir, emptyDir, includeDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(path.join(validDir, 'good.yml'), `name: Good
steps:
  - name: Check
    action: http.get
    url: /
    expect:
      status: 200
`);

    fs.writeFileSync(path.join(invalidDir, 'bad.yml'), `name: Bad
schedul: "* * * * *"
steps:
  - action: http.get
    url: /
`);

    fs.writeFileSync(path.join(includeDir, 'shared.yml'), `name: Shared
steps:
  - name: Shared step
    action: http.get
    url: /
`);
    fs.writeFileSync(path.join(includeDir, 'parent.yml'), `name: Parent
steps:
  - include: shared
`);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates every scenario and prints machine-readable JSON', async () => {
    const result = await runCli(['validate', '--all', '--scenarios-dir', validDir, '--json']);
    assert.strictEqual(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].valid, true);
    assert.strictEqual(parsed[0].name, 'Good');
  });

  it('exits 1 and reports the first error for an invalid scenario', async () => {
    const result = await runCli(['validate', '--all', '--scenarios-dir', invalidDir, '--json']);
    assert.strictEqual(result.code, 1, result.stderr);

    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed[0].valid, false);
    assert.match(parsed[0].error, /Unknown field "schedul".*did you mean "schedule"/);
  });

  it('exits 1 when the directory has no scenarios', async () => {
    const result = await runCli(['validate', '--all', '--scenarios-dir', emptyDir, '--json']);
    assert.strictEqual(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.match(parsed[0].error, /No \.yml or \.yaml files found/);
  });

  it('resolves include steps relative to the scenario directory', async () => {
    const result = await runCli(['validate', path.join(includeDir, 'parent.yml'), '--json']);
    assert.strictEqual(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed[0].valid, true);
    assert.strictEqual(parsed[0].steps, 1);
  });
});
