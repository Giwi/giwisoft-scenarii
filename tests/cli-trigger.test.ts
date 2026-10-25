import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const repoRoot = path.resolve(__dirname, '../..');
const distIndex = path.join(repoRoot, 'dist', 'index.js');
const hasDist = fs.existsSync(distIndex);

// The CLI is built by `npm test` (build:backend); skip when it has not been built.
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

describeCli('trigger command exit codes', () => {
  let server: http.Server;
  let tmpDir: string;
  let failFile: string;
  let passFile: string;

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/fail') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('nope');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarii-cli-'));
    failFile = path.join(tmpDir, 'fail.yml');
    passFile = path.join(tmpDir, 'pass.yml');
    fs.writeFileSync(failFile, `name: cli-fail
base_url: http://127.0.0.1:${port}
steps:
  - name: Fail
    action: http.get
    url: /fail
    expect:
      status: 200
`);
    fs.writeFileSync(passFile, `name: cli-pass
base_url: http://127.0.0.1:${port}
steps:
  - name: Pass
    action: http.get
    url: /ok
    expect:
      status: 200
`);
  });

  after(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 1 when the run fails', async () => {
    const result = await runCli(['trigger', failFile, '--json']);
    assert.strictEqual(result.code, 1, result.stderr);
  });

  it('exits 0 when the run fails and --fail-on none', async () => {
    const result = await runCli(['trigger', failFile, '--json', '--fail-on', 'none']);
    assert.strictEqual(result.code, 0, result.stderr);
  });

  it('exits 0 when the run passes', async () => {
    const result = await runCli(['trigger', passFile, '--json']);
    assert.strictEqual(result.code, 0, result.stderr);
  });

  it('rejects an unknown --fail-on value', async () => {
    const result = await runCli(['trigger', passFile, '--fail-on', 'maybe']);
    assert.strictEqual(result.code, 1);
  });
});
