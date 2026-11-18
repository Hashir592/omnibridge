import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// T-0405 (AT-9, DP-8): the restore drill's marker scan over dumps, logs, job tables, mail and
// exports. It names the source and line of a hit, never the line itself.

const SCAN = 'scripts/lib/marker-scan.mjs';
const run = (args: string[], input = '') =>
  spawnSync(process.execPath, [SCAN, ...args], { input, encoding: 'utf8' });

describe('marker scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-scan-'));
  const clean = join(dir, 'db-main.sql');
  writeFileSync(clean, 'COPY app.job_records (id, result) FROM stdin;\n1\t{"count":2}\n\\.\n');

  it('[AT-9] passes on clean sources, files and stdin', () => {
    const res = run([clean, '-'], '{"level":30,"msg":"order synced","count":3}\n');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('marker scan: 2 sources, 0 hits');
  });

  it('[AT-9] fails on a planted marker and names where, not what', () => {
    const planted = join(dir, 'mail.json');
    writeFileSync(planted, 'line one\n{"to":"PIIMARK-planted@example.test"}\n');
    const res = run([clean, planted]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain(`${planted}:2`);
    expect(res.stdout).not.toContain('planted@example.test');
  });

  it('[AT-9] the drill scans every Mailpit message in full: a marker past the snippet is found (S5-20261118-03)', async () => {
    const deep = `Subject: Invite\r\n\r\n${'filler text '.repeat(400)}\r\nPIIMARK-deep-in-body\r\n`;
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/api/v1/messages')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            total: 1,
            messages_count: 1,
            messages: [{ ID: 'm1', Snippet: 'filler text filler text' }],
          }),
        );
      } else if (url === '/api/v1/message/m1/raw') {
        res.end(deep);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const dump = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, [
          'infra/backup/mailpit-raw.mjs',
          `http://127.0.0.1:${String(port)}`,
        ]);
        let stdout = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
        child.on('close', (status) => {
          resolve({ status, stdout });
        });
      });
      expect(dump.status).toBe(0);
      const mail = join(dir, 'mail.eml');
      writeFileSync(mail, dump.stdout);
      const res = run([mail]);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('1 hits');
    } finally {
      server.close();
    }
  });

  it('[AT-9] a source that cannot be read fails the scan', () => {
    const res = run([join(dir, 'missing.sql')]);
    expect(res.status).toBe(2);
  });
});
