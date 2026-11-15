import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TenantContext } from '@omnibridge/core';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
import {
  FileRepository,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDb,
} from '@omnibridge/db';
import { EncryptedLocalFileStore, FileKeyStore, signFileLink } from '@omnibridge/files';
import { createLogger } from '@omnibridge/logger';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const ws: TenantContext = { workspaceId: randomUUID(), companyIds: [] };
const PDF = Buffer.from('%PDF-1.7\n% synthetic test invoice\n%%EOF\n');

const USER = randomUUID();

/** Test-only stand-in for T-0203 sessions: the session id comes from a header. */
const fromHeaders = (request: { headers: Record<string, unknown> }) => {
  const session = request.headers['x-test-session'];
  return typeof session === 'string'
    ? { workspaceId: ws.workspaceId, userId: USER, sessionId: session }
    : undefined;
};

describe('GET /files/:id signed links (NFR-5)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  let store: EncryptedLocalFileStore;
  const linkKey = randomBytes(32);
  let cleanId = '';
  let scanningId = '';

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', [
      'ob_owner',
      'ob_app',
      'ob_platform',
    ]);
    await migrateMain(cluster.connection('ob_owner'));
    db = new Kysely<MainDb>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ ...cluster.connection('ob_app'), max: 3 }),
      }),
    });
    // The session user is an admin of the workspace (USR-8: only members get session routes).
    await new Tenancy(db).run({ ...ws, userId: USER }, async (ctx) => {
      await new WorkspaceRepository(db).create(ctx, { name: 'Files test' });
      await new UserRepository(db).create(ctx, {
        id: USER,
        email: `${USER}@example.test`,
        name: 'U',
      });
      await new MembershipRepository(db).add(ctx, { userId: USER, role: 'admin' });
    });
    const root = mkdtempSync(join(tmpdir(), 'ob-web-files-'));
    store = new EncryptedLocalFileStore({
      root,
      keys: new FileKeyStore(root, parseKeyring('secrets', generateKekLine(1))),
      metadata: new FileRepository(db),
      linkKey,
    });
    cleanId = await store.put(ws, {
      body: PDF,
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    await store.setState(ws, cleanId, 'clean'); // as the scan job would
    scanningId = await store.put(ws, {
      body: PDF,
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
    });
  });

  afterAll(async () => {
    await db.destroy();
    await cluster.container.stop();
  });

  const app = () =>
    buildWebApp({
      logger,
      version: '0',
      checks,
      files: { store, linkKey },
      tenancy: new Tenancy(db),
      resolveSession: fromHeaders,
    });

  it('[NFR-5] a link issued after the permission check downloads the file for that session', async () => {
    expect(
      await store.signedUrl(ws, cleanId, 'session-a', () => Promise.resolve(false)),
    ).toBeUndefined();
    const issued = await store.signedUrl(ws, cleanId, 'session-a', () => Promise.resolve(true));
    expect(issued?.url).toMatch(/^\/files\/[0-9a-f-]{36}\?exp=\d+&sig=[\w-]+$/);
    const server = app();
    const res = await server.inject({
      method: 'GET',
      url: issued?.url ?? '',
      headers: { 'x-test-session': 'session-a' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.rawPayload.equals(PDF)).toBe(true);
    await server.close();
  });

  it('[NFR-5] expired or tampered signed link returns 403', async () => {
    const server = app();
    const get = (url: string, session = 'session-a') =>
      server.inject({ method: 'GET', url, headers: { 'x-test-session': session } });

    const expired = signFileLink(
      { fileId: cleanId, sessionId: 'session-a', now: new Date(Date.now() - 10 * 60_000) },
      linkKey,
    );
    expect(
      (await get(`/files/${cleanId}?exp=${String(expired.exp)}&sig=${expired.sig}`)).statusCode,
    ).toBe(403);

    const good = signFileLink({ fileId: cleanId, sessionId: 'session-a' }, linkKey);
    // A middle character: always different bytes (the last one partly holds unused bits).
    const tamperedSig = `${good.sig.slice(0, 10)}${good.sig[10] === 'A' ? 'B' : 'A'}${good.sig.slice(11)}`;
    expect(
      (await get(`/files/${cleanId}?exp=${String(good.exp)}&sig=${tamperedSig}`)).statusCode,
    ).toBe(403);
    expect(
      (await get(`/files/${cleanId}?exp=${String(good.exp + 600)}&sig=${good.sig}`)).statusCode,
    ).toBe(403);
    // Bound to the session: another signed-in session cannot reuse it.
    const stolen = await get(
      `/files/${cleanId}?exp=${String(good.exp)}&sig=${good.sig}`,
      'session-b',
    );
    expect(stolen.statusCode).toBe(403);
    expect(stolen.json()).toMatchObject({ code: 'forbidden' });
    // Bound to the file: the same signature does not open another file.
    expect(
      (await get(`/files/${scanningId}?exp=${String(good.exp)}&sig=${good.sig}`)).statusCode,
    ).toBe(403);
    await server.close();
  });

  it('[NFR-5] a file still being scanned is never served, even with a valid link', async () => {
    const server = app();
    const link = signFileLink({ fileId: scanningId, sessionId: 'session-a' }, linkKey);
    const res = await server.inject({
      method: 'GET',
      url: `/files/${scanningId}?exp=${String(link.exp)}&sig=${link.sig}`,
      headers: { 'x-test-session': 'session-a' },
    });
    expect(res.statusCode).toBe(404);
    // No session at all: 401 before anything else.
    expect(
      (await server.inject({ method: 'GET', url: `/files/${cleanId}?exp=1&sig=x` })).statusCode,
    ).toBe(401);
    await server.close();
  });

  it('[NFR-5] files past delete_after are hard-deleted, bytes and metadata', async () => {
    const id = await store.put(ws, {
      body: PDF,
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
      deleteAfter: new Date(Date.now() - 1_000),
    });
    expect(await store.purgeExpired(ws)).toBe(1);
    await expect(store.openForScan(ws, id)).rejects.toThrow();
    expect(await new FileRepository(db).get(ws, id)).toBeUndefined();
    // Files without delete_after are kept.
    expect(await new FileRepository(db).get(ws, cleanId)).toBeDefined();
  });
});
