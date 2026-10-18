import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHttpHealthcheck } from './healthcheck.ts';

describe('runHttpHealthcheck', () => {
  let server: Server;
  let port: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.statusCode = req.url === '/down' ? 503 : 200;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = String((server.address() as AddressInfo).port);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    process.exitCode = 0;
  });

  it('[OPS-10] sets exit code 0 for an accepted status and 1 otherwise', async () => {
    await runHttpHealthcheck('/up', (s) => s === 200, port);
    expect(process.exitCode).toBe(0);
    await runHttpHealthcheck('/down', (s) => s === 200, port);
    expect(process.exitCode).toBe(1);
  });

  it('[OPS-10] fails when nothing is listening', async () => {
    await runHttpHealthcheck('/up', () => true, '1');
    expect(process.exitCode).toBe(1);
  });
});
