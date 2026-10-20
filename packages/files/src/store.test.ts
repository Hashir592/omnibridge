import type { EventEmitter } from 'node:events';
import type * as FsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import type { TenantContext } from '@omnibridge/core';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileKeyStore, workspaceDir } from './keys.ts';
import {
  EncryptedLocalFileStore,
  FileNotReadable,
  type FileMeta,
  type FileMetadataStore,
} from './store.ts';

// Records every file handle the store opens, so a test can prove each one is closed again.
const opened = vi.hoisted(() => [] as { closed: boolean }[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const open = async (...args: Parameters<typeof actual.open>): Promise<FileHandle> => {
    const handle = await actual.open(...args);
    const entry = { closed: false };
    opened.push(entry);
    // FileHandle emits 'close' (Node docs), though its type does not declare the event.
    (handle as unknown as EventEmitter).on('close', () => {
      entry.closed = true;
    });
    return handle;
  };
  return { ...actual, open, default: { ...actual, open } };
});

const WS = '0a0a0a0a-0000-4000-8000-00000000000a';
const ctx: TenantContext = { workspaceId: WS, companyIds: [] };
const PDF = Buffer.from('%PDF-1.7\n%synthetic test document\n%%EOF\n');

function memoryMetadata(): FileMetadataStore {
  const rows = new Map<string, FileMeta>();
  return {
    insert: (_ctx, meta) => {
      rows.set(meta.id, { ...meta, state: 'scanning' });
      return Promise.resolve();
    },
    get: (_ctx, id) => Promise.resolve(rows.get(id)),
    setState: (_ctx, id, state) => {
      const row = rows.get(id);
      if (row) row.state = state;
      return Promise.resolve();
    },
    delete: (_ctx, id) => {
      rows.delete(id);
      return Promise.resolve();
    },
    listExpired: () => Promise.resolve([]),
  };
}

let root: string;
let metadata: FileMetadataStore;
const v1 = generateKekLine(1);
const v2 = generateKekLine(2);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ob-files-'));
  metadata = memoryMetadata();
  opened.length = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function storeWith(ring: string) {
  return new EncryptedLocalFileStore({
    root,
    keys: new FileKeyStore(root, parseKeyring('secrets', ring)),
    metadata,
  });
}

async function putClean(store: EncryptedLocalFileStore): Promise<string> {
  const id = await store.put(ctx, {
    body: PDF,
    contentType: 'application/pdf',
    sizeBytes: PDF.length,
  });
  await store.setState(ctx, id, 'clean');
  return id;
}

describe('file store reads (NFR-5)', () => {
  it('[NFR-5] bytes missing behind a metadata row are FileNotReadable, not a crash', async () => {
    const store = storeWith(v1);
    const id = await putClean(store);
    await rm(join(workspaceDir(root, WS), `${id}.bin`));
    await expect(store.get(ctx, id)).rejects.toBeInstanceOf(FileNotReadable);
    await expect(store.openForScan(ctx, id)).rejects.toBeInstanceOf(FileNotReadable);
  });

  it('[NFR-5] a read error on the file reaches the returned stream, and the handle is closed', async () => {
    const store = storeWith(v1);
    const id = await putClean(store);
    // A directory where the file should be: opening or reading it fails, depending on the OS.
    const path = join(workspaceDir(root, WS), `${id}.bin`);
    await rm(path);
    await (await import('node:fs/promises')).mkdir(path);
    const outcome = await store
      .get(ctx, id)
      .then((file) => buffer(file.stream))
      .catch((err: unknown) => err);
    expect(outcome).toBeInstanceOf(Error);
    await vi.waitFor(() => {
      expect(opened.every((h) => h.closed)).toBe(true);
    });
  });

  it('[SEC-2] [NFR-5] get() on a file that is still scanning opens nothing', async () => {
    const store = storeWith(v1);
    const id = await store.put(ctx, {
      body: PDF,
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    opened.length = 0;
    await expect(store.get(ctx, id)).rejects.toBeInstanceOf(FileNotReadable);
    expect(opened).toHaveLength(0);
  });

  it('[NFR-5] a stream the caller destroys early closes its file handle', async () => {
    const store = storeWith(v1);
    const id = await putClean(store);
    opened.length = 0;
    const file = await store.openForScan(ctx, id);
    file.stream.destroy();
    await vi.waitFor(() => {
      expect(opened).toHaveLength(1);
      expect(opened[0]?.closed).toBe(true);
    });
  });

  it('[NFR-5] a clean file reads back exactly', async () => {
    const store = storeWith(v1);
    const id = await putClean(store);
    const file = await store.get(ctx, id);
    expect(await buffer(file.stream)).toEqual(PDF);
  });
});

describe('file key rotation (SEC-6, NFR-5)', () => {
  it('[SEC-6] files written under KEK v1 still decrypt after rewrapAll and removing v1', async () => {
    const id = await putClean(storeWith(v1));

    const both = new FileKeyStore(root, parseKeyring('secrets', `${v1}\n${v2}`));
    expect(await both.countStale()).toBe(1);
    expect(await both.rewrapAll()).toBe(1);
    expect(await both.rewrapAll()).toBe(0);
    expect(await both.countStale()).toBe(0);

    const keyFile = JSON.parse(
      await readFile(join(workspaceDir(root, WS), 'keys', 'v1.json'), 'utf8'),
    ) as { kekVersion: number };
    expect(keyFile.kekVersion).toBe(2);

    const file = await storeWith(v2).get(ctx, id);
    expect(await buffer(file.stream)).toEqual(PDF);
  });

  it('[SEC-6] without rewrapAll, removing the old KEK makes the files unreadable', async () => {
    const id = await putClean(storeWith(v1));
    await expect(storeWith(v2).get(ctx, id)).rejects.toThrow(/no KEK version 1/);
  });

  it('[SEC-6] a crash between the temp write and the rename leaves the old key readable', async () => {
    const id = await putClean(storeWith(v1));
    const keys = join(workspaceDir(root, WS), 'keys');
    // What a crash mid-rewrap leaves behind: a partial temp file next to the untouched key.
    await writeFile(join(keys, 'v1.json.tmp'), '{"version":1,"kekV');

    const file = await storeWith(`${v1}\n${v2}`).get(ctx, id);
    expect(await buffer(file.stream)).toEqual(PDF);
    expect(await new FileKeyStore(root, parseKeyring('secrets', `${v1}\n${v2}`)).rewrapAll()).toBe(
      1,
    );
  });

  it('[SEC-6] an old keyring mid-rollout skips file keys under a newer KEK and counts them (R2-02)', async () => {
    await putClean(storeWith(v1));
    expect(
      await new FileKeyStore(
        root,
        parseKeyring(
          'secrets',
          `${v1}
${v2}`,
        ),
      ).rewrapAll(),
    ).toBe(1);
    // A process still on the one-line v1 keyring: no crash, nothing changed, the key is counted.
    const old = new FileKeyStore(root, parseKeyring('secrets', v1));
    expect(await old.rewrapAll()).toBe(0);
    expect(await old.countNewer()).toBe(1);
    expect(await old.countStale()).toBe(0);
    const keyFile = JSON.parse(
      await readFile(join(workspaceDir(root, WS), 'keys', 'v1.json'), 'utf8'),
    ) as { kekVersion: number };
    expect(keyFile.kekVersion).toBe(2);
  });

  it('[NFR-5] concurrent first use of a workspace key never reads a half-written file', async () => {
    for (let trial = 0; trial < 200; trial += 1) {
      const workspaceId = `0a0a0a0a-0000-4000-8000-${String(trial).padStart(12, '0')}`;
      const stores = [1, 2, 3, 4].map(() => new FileKeyStore(root, parseKeyring('secrets', v1)));
      const keys = await Promise.all(stores.map((s) => s.active(workspaceId)));
      const raw = keys.map((k) => k.version);
      expect(raw).toEqual([1, 1, 1, 1]);
      const names = await readdir(join(workspaceDir(root, workspaceId), 'keys'));
      expect(names).toEqual(['v1.json']);
    }
  }, 60_000); // 200 trials with an fsync each; slow on Windows under the full gate
});
