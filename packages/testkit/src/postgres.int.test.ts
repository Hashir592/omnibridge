import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { startRoleCluster } from './postgres.ts';

/**
 * `pool.end()` resolves before its sockets have closed (pg-pool drops a client from its list, then
 * ends it), so a test that stops its cluster straight after could have PostgreSQL end a session
 * that was still closing: an uncaught 57P01 that fails a run with every test green.
 */
describe('role cluster teardown', () => {
  it('[NFR-2] stopping a cluster waits for a session that is still closing', async () => {
    const cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_app']);
    const closing = new pg.Client(cluster.connection('ob_app'));
    const errors: string[] = [];
    closing.on('error', (err) => errors.push(err.message));
    await closing.connect();
    // Stands in for a socket that closes a moment after `pool.end()` has resolved.
    const closed = new Promise<void>((resolve, reject) => {
      setTimeout(() => void closing.end().then(resolve, reject), 500);
    });
    await cluster.container.stop();
    await closed;
    expect(errors).toEqual([]);
  }, 120_000);

  it('[NFR-2] a session nobody closes is still ended and reported: the wait hides no leak', async () => {
    const cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_app']);
    const leaked = new pg.Client(cluster.connection('ob_app'));
    const errors: string[] = [];
    leaked.on('error', (err) => errors.push(err.message));
    await leaked.connect();
    await cluster.container.stop();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(errors.length).toBeGreaterThan(0);
    await leaked.end().catch(() => undefined);
  }, 120_000);
});
