import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline as pipe, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TenantContext } from '@omnibridge/core';
import { decryptStream, encryptStream } from './chunked.ts';
import { workspaceDir, type FileKeyStore } from './keys.ts';
import { signFileLink, type FileLink } from './links.ts';
import type { UploadType } from './uploads.ts';

export type FileState = 'scanning' | 'clean' | 'infected' | 'scan_failed';

export interface FileMeta {
  id: string;
  contentType: UploadType;
  sizeBytes: number;
  keyVersion: number;
  state: FileState;
  deleteAfter: Date | null;
}

/** File metadata in db-main (packages/db FileRepository), always inside a tenant transaction. */
export interface FileMetadataStore {
  insert(ctx: TenantContext, meta: Omit<FileMeta, 'state'>): Promise<void>;
  get(ctx: TenantContext, id: string): Promise<FileMeta | undefined>;
  setState(ctx: TenantContext, id: string, state: FileState): Promise<void>;
  delete(ctx: TenantContext, id: string): Promise<void>;
  /** Ids of files whose delete_after has passed. */
  listExpired(ctx: TenantContext, now: Date): Promise<string[]>;
}

export interface StoredFile {
  meta: FileMeta;
  stream: Readable;
}

/** Thrown when a file is missing, belongs to another workspace, or is not clean yet. */
export class FileNotReadable extends Error {
  constructor() {
    super('File not found or not readable');
    this.name = 'FileNotReadable';
  }
}

/**
 * Where files live (ADR-012, NFR-5). Callers see only this interface, so an S3/B2 implementation
 * can replace the local one without caller changes.
 */
export interface FileStore {
  /** Stores a file as `scanning`; it becomes readable only when a scan marks it clean. */
  put(
    ctx: TenantContext,
    input: {
      body: Readable | Uint8Array;
      contentType: UploadType;
      sizeBytes: number;
      deleteAfter?: Date;
    },
  ): Promise<string>;
  /** A clean file's content. Anything else is FileNotReadable. */
  get(ctx: TenantContext, id: string): Promise<StoredFile>;
  /** Any state: for the virus scan only. */
  openForScan(ctx: TenantContext, id: string): Promise<StoredFile>;
  setState(ctx: TenantContext, id: string, state: FileState): Promise<void>;
  /** Hard delete of the bytes and the metadata. */
  delete(ctx: TenantContext, id: string): Promise<void>;
  /** Hard-deletes every file of the workspace whose delete_after has passed. Returns how many. */
  purgeExpired(ctx: TenantContext, now?: Date): Promise<number>;
  /**
   * A 5-minute link bound to the file and the session, issued only when `allowed` says yes
   * (NFR-5). Returns undefined when it does not.
   */
  signedUrl(
    ctx: TenantContext,
    id: string,
    sessionId: string,
    allowed: () => Promise<boolean>,
  ): Promise<{ url: string; link: FileLink } | undefined>;
}

/** FileStore on a local volume: encrypted bodies under random ids (ADR-012). */
export class EncryptedLocalFileStore implements FileStore {
  readonly #root: string;
  readonly #keys: FileKeyStore;
  readonly #meta: FileMetadataStore;
  readonly #linkKey: Buffer | undefined;

  constructor(options: {
    root: string;
    keys: FileKeyStore;
    metadata: FileMetadataStore;
    /** The file-link HMAC key; only the web app, which issues and checks links, has it. */
    linkKey?: Buffer;
  }) {
    this.#root = options.root;
    this.#keys = options.keys;
    this.#meta = options.metadata;
    this.#linkKey = options.linkKey;
  }

  async put(
    ctx: TenantContext,
    input: {
      body: Readable | Uint8Array;
      contentType: UploadType;
      sizeBytes: number;
      deleteAfter?: Date;
    },
  ): Promise<string> {
    const id = randomUUID();
    const key = await this.#keys.active(ctx.workspaceId);
    const dir = workspaceDir(this.#root, ctx.workspaceId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = this.#path(ctx, id);
    let written = 0;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length;
        done(null, chunk);
      },
    });
    const body =
      input.body instanceof Readable ? input.body : Readable.from([Buffer.from(input.body)]);
    try {
      await pipeline(
        body,
        count,
        encryptStream(key, id),
        createWriteStream(`${path}.tmp`, { mode: 0o600 }),
      );
    } catch (err) {
      await rm(`${path}.tmp`, { force: true });
      throw err;
    }
    if (written !== input.sizeBytes) {
      await rm(`${path}.tmp`, { force: true });
      throw new Error('File size does not match the declared size');
    }
    await rename(`${path}.tmp`, path);
    try {
      await this.#meta.insert(ctx, {
        id,
        contentType: input.contentType,
        sizeBytes: written,
        keyVersion: key.version,
        deleteAfter: input.deleteAfter ?? null,
      });
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
    return id;
  }

  async get(ctx: TenantContext, id: string): Promise<StoredFile> {
    const meta = await this.#meta.get(ctx, id);
    // Checked before anything is opened, so a refused read holds no file handle (F-M01-end-02).
    if (meta?.state !== 'clean') throw new FileNotReadable();
    return { meta, stream: await this.#open(ctx, meta) };
  }

  async openForScan(ctx: TenantContext, id: string): Promise<StoredFile> {
    const meta = await this.#meta.get(ctx, id);
    if (meta === undefined) throw new FileNotReadable();
    return { meta, stream: await this.#open(ctx, meta) };
  }

  /**
   * The decrypted content. A missing file is FileNotReadable. `pipeline` sends a later read error
   * to the returned stream (never an uncaught exception) and closes the file when the caller
   * destroys the stream early.
   */
  async #open(ctx: TenantContext, meta: FileMeta): Promise<Readable> {
    const key = await this.#keys.get(ctx.workspaceId, meta.keyVersion);
    let handle: FileHandle;
    try {
      handle = await open(this.#path(ctx, meta.id), 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new FileNotReadable();
      throw err;
    }
    const content = decryptStream(key, meta.id);
    pipe(handle.createReadStream(), content, () => undefined);
    return content;
  }

  setState(ctx: TenantContext, id: string, state: FileState): Promise<void> {
    return this.#meta.setState(ctx, id, state);
  }

  async delete(ctx: TenantContext, id: string): Promise<void> {
    await this.#meta.delete(ctx, id);
    await rm(this.#path(ctx, id), { force: true });
  }

  async purgeExpired(ctx: TenantContext, now = new Date()): Promise<number> {
    const ids = await this.#meta.listExpired(ctx, now);
    for (const id of ids) await this.delete(ctx, id);
    return ids.length;
  }

  async signedUrl(
    ctx: TenantContext,
    id: string,
    sessionId: string,
    allowed: () => Promise<boolean>,
  ): Promise<{ url: string; link: FileLink } | undefined> {
    if (this.#linkKey === undefined) throw new Error('This process has no file-link key');
    const meta = await this.#meta.get(ctx, id);
    if (meta?.state !== 'clean' || !(await allowed())) return undefined;
    const link = signFileLink({ fileId: id, sessionId }, this.#linkKey);
    return { url: `/files/${id}?exp=${String(link.exp)}&sig=${link.sig}`, link };
  }

  #path(ctx: TenantContext, id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new FileNotReadable();
    return join(workspaceDir(this.#root, ctx.workspaceId), `${id}.bin`);
  }
}
