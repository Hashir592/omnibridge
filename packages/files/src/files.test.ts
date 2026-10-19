import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { generateDataKey, generateKekLine, parseKeyring } from '@omnibridge/crypto';
import { describe, expect, it } from 'vitest';
import type { JobQueue } from '@omnibridge/queue';
import { acceptUpload } from './accept.ts';
import { CHUNK_BYTES, decryptStream, encryptStream } from './chunked.ts';
import { scanWithClamd } from './clamd.ts';
import { signFileLink, verifyFileLink } from './links.ts';
import type { FileStore } from './store.ts';
import { checkUpload, UploadRejected } from './uploads.ts';

const WS = '0a0a0a0a-0000-4000-8000-00000000000a';
const FILE = '0f0f0f0f-0000-4000-8000-00000000000f';
const { dataKey } = generateDataKey(parseKeyring('secrets', generateKekLine(1)), WS, 1);

const PDF = Buffer.from('%PDF-1.7\n%synthetic test document\n%%EOF\n');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(64),
]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);

describe('chunked file encryption (NFR-5)', () => {
  it('[NFR-5] stored bytes are ciphertext and decrypt back exactly, across chunk boundaries', async () => {
    const marker = Buffer.from('SECRETMARK-file-body ');
    const plain = Buffer.concat([marker, randomBytes(CHUNK_BYTES * 2 + 123), marker]);
    const sealed = await buffer(Readable.from([plain]).pipe(encryptStream(dataKey, FILE)));
    expect(sealed.includes(marker)).toBe(false);
    const opened = await buffer(Readable.from([sealed]).pipe(decryptStream(dataKey, FILE)));
    expect(opened.equals(plain)).toBe(true);
  });

  it('[NFR-5] a truncated, reordered or moved file fails to decrypt', async () => {
    const plain = randomBytes(CHUNK_BYTES * 2 + 10);
    const sealed = await buffer(Readable.from([plain]).pipe(encryptStream(dataKey, FILE)));
    const read = (bytes: Buffer, id = FILE) =>
      buffer(Readable.from([bytes]).pipe(decryptStream(dataKey, id)));
    // Dropping the last chunk: every remaining chunk is valid, but the final flag is missing.
    const firstTwo = sealed.subarray(0, sealed.length - (4 + 33 + 10));
    await expect(read(firstTwo)).rejects.toThrow();
    // Same bytes under another file id.
    await expect(read(sealed, '0e0e0e0e-0000-4000-8000-00000000000e')).rejects.toThrow();
    // One flipped bit.
    const flipped = Buffer.from(sealed);
    flipped[100] = (flipped[100] ?? 0) ^ 1;
    await expect(read(flipped)).rejects.toThrow();
  });
});

describe('signed download links (NFR-5)', () => {
  const key = randomBytes(32);
  const now = new Date('2026-10-20T10:00:00Z');
  const link = signFileLink({ fileId: FILE, sessionId: 'session-a', now }, key);

  it('[NFR-5] a link is valid for 5 minutes, for one file and one session', () => {
    const at = (seconds: number) => new Date(now.getTime() + seconds * 1_000);
    const check = (over: Partial<Parameters<typeof verifyFileLink>[0]> = {}) =>
      verifyFileLink({ fileId: FILE, sessionId: 'session-a', ...link, now: at(60), ...over }, key);
    expect(check()).toBe('ok');
    expect(check({ now: at(299) })).toBe('ok');
    expect(check({ now: at(301) })).toBe('expired');
    expect(check({ sessionId: 'session-b' })).toBe('invalid');
    expect(check({ fileId: '0e0e0e0e-0000-4000-8000-00000000000e' })).toBe('invalid');
    expect(check({ sig: `${link.sig.slice(0, -2)}AA` })).toBe('invalid');
    expect(check({ exp: link.exp + 3_600 })).toBe('invalid');
    expect(
      verifyFileLink(
        { fileId: FILE, sessionId: 'session-a', ...link, now: at(60) },
        randomBytes(32),
      ),
    ).toBe('invalid');
  });
});

describe('upload checks (SEC-2)', () => {
  it('[SEC-2] file renamed .pdf with PNG bytes is rejected', () => {
    expect(() =>
      checkUpload({ bytes: PNG, filename: 'invoice.pdf', declaredType: 'application/pdf' }),
    ).toThrow(UploadRejected);
    expect(() =>
      checkUpload({ bytes: PNG, filename: 'invoice.png', declaredType: 'application/pdf' }),
    ).toThrow(/do not match/);
  });

  it('[SEC-2] only PDF, PNG and JPEG under the size limit are accepted', () => {
    expect(checkUpload({ bytes: PDF, filename: 'a.pdf', declaredType: 'application/pdf' })).toBe(
      'application/pdf',
    );
    expect(checkUpload({ bytes: PNG, filename: 'a.PNG', declaredType: 'image/png' })).toBe(
      'image/png',
    );
    expect(checkUpload({ bytes: JPG, filename: 'a.jpeg', declaredType: 'image/jpeg' })).toBe(
      'image/jpeg',
    );
    const gif = Buffer.from('GIF89a........');
    expect(() => checkUpload({ bytes: gif, filename: 'a.gif', declaredType: 'image/gif' })).toThrow(
      UploadRejected,
    );
    expect(() =>
      checkUpload({ bytes: Buffer.alloc(0), filename: 'a.pdf', declaredType: 'application/pdf' }),
    ).toThrow(UploadRejected);
    const big = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]);
    expect(() =>
      checkUpload({ bytes: big, filename: 'a.pdf', declaredType: 'application/pdf' }),
    ).toThrow(/too large/);
    expect(
      checkUpload({
        bytes: big,
        filename: 'a.pdf',
        declaredType: 'application/pdf',
        maxBytes: 20 * 1024 * 1024,
      }),
    ).toBe('application/pdf');
  });
});

describe('clamd INSTREAM client (SEC-2)', () => {
  /** A fake clamd that answers with `reply` after reading the whole INSTREAM. */
  const fakeClamd = (reply: string) =>
    new Promise<{ port: number; close: () => void; received: () => Buffer }>((resolve) => {
      let got = Buffer.alloc(0);
      const server = createServer((socket) => {
        socket.on('data', (chunk: Buffer) => {
          got = Buffer.concat([got, chunk]);
          if (got.subarray(-4).equals(Buffer.alloc(4))) socket.end(reply);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve({
          port: typeof address === 'object' && address !== null ? address.port : 0,
          close: () => server.close(),
          received: () => got,
        });
      });
    });

  it('[SEC-2] speaks zINSTREAM and maps OK, FOUND and ERROR', async () => {
    const ok = await fakeClamd('stream: OK\0');
    expect(await scanWithClamd({ host: '127.0.0.1', port: ok.port }, Readable.from([PDF]))).toBe(
      'clean',
    );
    expect(ok.received().subarray(0, 10).toString()).toBe('zINSTREAM\0');
    ok.close();

    const found = await fakeClamd('stream: Eicar-Test-Signature FOUND\0');
    expect(await scanWithClamd({ host: '127.0.0.1', port: found.port }, Readable.from([PDF]))).toBe(
      'infected',
    );
    found.close();

    const error = await fakeClamd('INSTREAM size limit exceeded. ERROR\0');
    expect(await scanWithClamd({ host: '127.0.0.1', port: error.port }, Readable.from([PDF]))).toBe(
      'scan_failed',
    );
    error.close();
  });

  it('[SEC-2] an unreachable clamd is an error, never a clean result', async () => {
    await expect(
      scanWithClamd({ host: '127.0.0.1', port: 1, timeoutMs: 2_000 }, Readable.from([PDF])),
    ).rejects.toThrow();
  });
});

describe('upload pipeline (SEC-2)', () => {
  it('[SEC-2] a file whose scan job cannot be queued is removed, never left unscanned', async () => {
    const deleted: string[] = [];
    const store = {
      put: () => Promise.resolve(FILE),
      delete: (_ctx: unknown, id: string) => {
        deleted.push(id);
        return Promise.resolve();
      },
    } as unknown as FileStore;
    const queue = { send: () => Promise.reject(new Error('queue down')) } as unknown as JobQueue;
    await expect(
      acceptUpload(
        { store, queue },
        { workspaceId: WS },
        {
          bytes: PDF,
          filename: 'a.pdf',
          declaredType: 'application/pdf',
        },
      ),
    ).rejects.toThrow('queue down');
    expect(deleted).toEqual([FILE]);
  });
});
