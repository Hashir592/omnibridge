import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PDFDocument,
  PDFName,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  concatTransformationMatrix,
} from '@cantoo/pdf-lib';
import { createLogger } from '@omnibridge/logger';
import { PII_MARKER, startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { VaultClient, VaultError } from '@omnibridge/vault-client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestVault, type TestVault } from './testing.ts';

const DAY = 86_400_000;

/**
 * A label-sized PDF: one 4 x 6 inch page with an uncompressible image (a thermal label's barcode
 * is tens of kilobytes) and the buyer's name as text, marked so a leak can be found.
 */
async function labelPdf(name: string, imageBytes = 60_000): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([288, 432]);
  const width = 200;
  const height = Math.ceil(imageBytes / (width * 3));
  const image = doc.context.register(
    doc.context.stream(randomBytes(width * height * 3), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: width,
      Height: height,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
    }),
  );
  page.node.setXObject(PDFName.of('Im0'), image);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(width, 0, 0, height, 40, 200),
    drawObject('Im0'),
    popGraphicsState(),
  );
  page.drawText(name, { x: 36, y: 120, size: 12 });
  return doc.save({ useObjectStreams: false });
}

/**
 * Label files in the vault (T-1201: invariant 11, FA-15, DEL-1, SHP-2, DP-8). Stored encrypted in
 * the vault's own volume, merged on download, deleted with their buyer records or at 30 days.
 */
describe('label files in the vault (invariant 11)', () => {
  let cluster: RoleCluster;
  let vault: TestVault;
  let owner: pg.Pool;
  let clock = new Date('2026-11-28T12:00:00.000Z');
  const journalDir = mkdtempSync(join(tmpdir(), 'ob-journal-'));
  const labelsDir = mkdtempSync(join(tmpdir(), 'ob-labels-'));
  const clients = {} as Record<'web' | 'worker' | 'deletion', VaultClient>;
  const ws = randomUUID();
  const account = randomUUID();

  const ingest = async (subject: string, deleteAfter?: Date) =>
    (
      await clients.worker.ingest({
        workspace_id: ws,
        kind: 'buyer_contact',
        channel_account_id: account,
        subject_type: 'order',
        subject_id: subject,
        ...(deleteAfter === undefined ? {} : { delete_after: deleteAfter.toISOString() }),
        fields: {
          name: `${PII_MARKER}Label ${subject}`,
          postcode: 'LA1 1BL',
          address_line1: `${PII_MARKER}1 Label Road`,
        },
      })
    ).pii_ref;
  const store = async (labelId: string, refs: string[], name = `${PII_MARKER}Jo Label`) =>
    clients.worker.storeLabel({
      workspaceId: ws,
      labelId,
      piiRefs: refs,
      pdf: await labelPdf(name),
    });
  const files = () => (existsSync(join(labelsDir, ws)) ? readdirSync(join(labelsDir, ws)) : []);
  const rows = async () => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [ws]);
      const res = await c.query<{ label_id: string; delete_after: Date }>(
        'SELECT label_id, delete_after FROM vault.label_files ORDER BY label_id',
      );
      await c.query('COMMIT');
      return res.rows;
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']);
    vault = await startTestVault({
      owner: cluster.connection('vault_owner'),
      app: cluster.connection('vault_app'),
      logger: createLogger({
        service: 'pii-vault',
        version: 'test',
        destination: { write: () => true },
      }),
      journalDir,
      labelsDir,
      now: () => clock,
    });
    owner = new pg.Pool({ ...cluster.connection('vault_owner'), max: 2 });
    for (const caller of ['web', 'worker', 'deletion'] as const) {
      clients[caller] = new VaultClient({
        baseUrl: vault.baseUrl,
        token: vault.tokens[caller],
        timeoutMs: 60_000,
      });
    }
  }, 300_000);

  afterAll(async () => {
    await owner.end();
    await vault.close();
    await cluster.container.stop();
  });

  it('[SHIP-2][DP-8] the worker stores a label once, encrypted: the file on disk holds no readable buyer detail', async () => {
    const ref = await ingest('o-store');
    const id = randomUUID();
    expect(await store(id, [ref])).toEqual({ stored: true });
    expect(await store(id, [ref])).toEqual({ stored: false });
    const [file] = files().filter((f) => f.startsWith(id));
    expect(file).toBeDefined();
    const raw = readFileSync(join(labelsDir, ws, file ?? '')).toString('latin1');
    expect(raw).not.toContain(PII_MARKER);
    expect(raw.startsWith('%PDF')).toBe(false);
    // Web never stores; nobody stores for a record that does not exist; a non-PDF is refused.
    const asWeb = await clients.web
      .storeLabel({
        workspaceId: ws,
        labelId: randomUUID(),
        piiRefs: [ref],
        pdf: await labelPdf('x'),
      })
      .catch((e: unknown) => e);
    expect((asWeb as VaultError).status).toBe(403);
    const unknown = await store(randomUUID(), [randomUUID()]).catch((e: unknown) => e);
    expect((unknown as VaultError).status).toBe(404);
    const notPdf = await clients.worker
      .storeLabel({
        workspaceId: ws,
        labelId: randomUUID(),
        piiRefs: [ref],
        pdf: Buffer.from('hello world'),
      })
      .catch((e: unknown) => e);
    expect((notPdf as VaultError).status).toBe(422);
  });

  it('[SHIP-2][DP-7] labels merge into one PDF in the order asked, each read logged for printing', async () => {
    const [a, b] = [await ingest('o-m1'), await ingest('o-m2')];
    const [la, lb] = [randomUUID(), randomUUID()];
    await store(la, [a], `${PII_MARKER}First`);
    await store(lb, [b], `${PII_MARKER}Second`);
    const pdf = await clients.web.mergeLabels({ workspaceId: ws, labelIds: [lb, la] });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(2);
    expect((await clients.web.storedLabels(ws, [la, lb, randomUUID()])).label_ids.sort()).toEqual(
      [la, lb].sort(),
    );
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [ws]);
      const log = await c.query<{ pii_ref: string; purpose: string; caller: string }>(
        `SELECT pii_ref, purpose, caller FROM vault.access_log
          WHERE pii_ref = ANY($1::uuid[]) AND capability = 'read_full'`,
        [[a, b]],
      );
      await c.query('COMMIT');
      expect(log.rows.map((r) => [r.purpose, r.caller])).toEqual([
        ['label', 'web'],
        ['label', 'web'],
      ]);
    } finally {
      c.release();
    }
    // A label not stored refuses the whole merge.
    const missing = await clients.web
      .mergeLabels({ workspaceId: ws, labelIds: [la, randomUUID()] })
      .catch((e: unknown) => e);
    expect((missing as VaultError).status).toBe(404);
  });

  it('[SHIP-2] 200 labels merge in one call (FA-15)', async () => {
    const ref = await ingest('o-200');
    const ids = Array.from({ length: 200 }, () => randomUUID());
    for (const id of ids) await store(id, [ref]);
    const pdf = await clients.web.mergeLabels({ workspaceId: ws, labelIds: ids });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(200);
  }, 120_000);

  it('[DEL-1][AT-8] a label goes with its buyer record, whatever deleted it', async () => {
    const ref = await ingest('o-erase');
    const id = randomUUID();
    await store(id, [ref]);
    expect(files().some((f) => f.startsWith(id))).toBe(true);
    await clients.deletion.delete({
      workspace_id: ws,
      run_id: randomUUID(),
      trigger: 'erasure',
      scope: { type: 'refs', pii_refs: [ref] },
    });
    expect(files().some((f) => f.startsWith(id))).toBe(false);
    expect((await rows()).some((r) => r.label_id === id)).toBe(false);
  });

  it('[DEL-1] a label goes at the earlier of 30 days or its record expiry', async () => {
    clock = new Date('2026-11-28T12:00:00.000Z');
    // A record that expires in 10 days: its label goes with it then.
    const soon = await ingest('o-soon', new Date(clock.getTime() + 10 * DAY));
    // A record kept longer: its label goes at 30 days.
    const late = await ingest('o-late', new Date(clock.getTime() + 60 * DAY));
    const [ls, ll] = [randomUUID(), randomUUID()];
    await store(ls, [soon]);
    await store(ll, [late]);
    const dates = Object.fromEntries(
      (await rows()).map((r) => [r.label_id, r.delete_after.getTime()]),
    );
    expect(dates[ls]).toBe(clock.getTime() + 10 * DAY);
    expect(dates[ll]).toBe(clock.getTime() + 30 * DAY);
    const expire = () =>
      clients.deletion.delete({
        workspace_id: ws,
        run_id: randomUUID(),
        trigger: 'expiry',
        scope: { type: 'expiry' },
      });
    clock = new Date(clock.getTime() + 11 * DAY);
    await expire();
    expect(files().some((f) => f.startsWith(ls))).toBe(false);
    expect(files().some((f) => f.startsWith(ll))).toBe(true);
    clock = new Date(clock.getTime() + 20 * DAY);
    await expire();
    expect(files().some((f) => f.startsWith(ll))).toBe(false);
    expect((await rows()).some((r) => r.label_id === ll)).toBe(false);
    clock = new Date('2026-11-28T12:00:00.000Z');
  });

  it('[SHP-5] a voided label is discarded at once, by the worker only', async () => {
    const ref = await ingest('o-void');
    const id = randomUUID();
    await store(id, [ref]);
    const asWeb = await clients.web.discardLabels(ws, [id]).catch((e: unknown) => e);
    expect((asWeb as VaultError).status).toBe(403);
    expect(await clients.worker.discardLabels(ws, [id])).toEqual({ label_ids: [id] });
    expect(files().some((f) => f.startsWith(id))).toBe(false);
  });
});

/**
 * FA-15: the merge runs inside the vault's memory. A child process at the vault's heap limit
 * (--max-old-space-size=192, compose) merges 200 label-sized PDFs; its peak resident memory must
 * stay under the container's 256 MB.
 */
describe('200-label merge inside the vault memory limit (FA-15)', () => {
  it('[SHIP-2][DP-8] 200 labels of 100 kB merge under 256 MB at the vault heap limit (FA-15)', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const script = `
      import { randomBytes } from 'node:crypto';
      import { PDFDocument, PDFName, drawObject, popGraphicsState, pushGraphicsState, concatTransformationMatrix } from '@cantoo/pdf-lib';
      import { mergeLabelPdfs } from './src/label-merge.ts';
      const make = async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([288, 432]);
        const w = 200, h = 167;
        const image = doc.context.register(doc.context.stream(randomBytes(w * h * 3), {
          Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
        page.node.setXObject(PDFName.of('Im0'), image);
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, 40, 200), drawObject('Im0'), popGraphicsState());
        page.drawText('PIIMARK-Label', { x: 36, y: 120, size: 12 });
        return doc.save({ useObjectStreams: false });
      };
      // As the vault reads them: one file at a time, from storage (here, made on demand).
      const out = await mergeLabelPdfs(200, () => make());
      const doc = await PDFDocument.load(out);
      process.stdout.write(JSON.stringify({ pages: doc.getPageCount(), bytes: out.length,
        maxRssKb: process.resourceUsage().maxRSS }));
    `;
    const res = spawnSync(
      process.execPath,
      ['--max-old-space-size=192', '--input-type=module', '--eval', script],
      { cwd: join(here, '..'), encoding: 'utf8', timeout: 120_000 },
    );
    expect(res.stderr).not.toMatch(/heap out of memory|FATAL/);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { pages: number; bytes: number; maxRssKb: number };
    expect(out.pages).toBe(200);
    expect(out.bytes).toBeGreaterThan(200 * 100_000);
    expect(out.maxRssKb).toBeLessThan(256 * 1024);
  }, 180_000);
});
