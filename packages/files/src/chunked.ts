import { Transform, type TransformCallback } from 'node:stream';
import type { DataKey, FieldAad } from '@omnibridge/crypto';

/**
 * Streaming AES-256-GCM for file bodies (NFR-5). The plaintext is cut into 64 KiB chunks; each is
 * sealed by the workspace's file data key with its own AAD: the file id, the chunk index and
 * whether it is the last chunk. So a chunk cannot be moved to another file or position, and a
 * truncated file is detected because its last chunk is missing.
 *
 * Stored format: one record per chunk, `[sealed length: uint32 BE][sealed chunk]`.
 */
export const CHUNK_BYTES = 64 * 1024;
const LENGTH_BYTES = 4;

function chunkAad(key: DataKey, fileId: string, index: number, last: boolean): FieldAad {
  return {
    workspaceId: key.workspaceId,
    table: 'files',
    column: last ? 'content.last' : 'content',
    rowId: `${fileId}:${String(index)}`,
  };
}

function record(sealed: Buffer): Buffer {
  const length = Buffer.alloc(LENGTH_BYTES);
  length.writeUInt32BE(sealed.length);
  return Buffer.concat([length, sealed]);
}

export function encryptStream(key: DataKey, fileId: string): Transform {
  let pending = Buffer.alloc(0);
  let index = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      pending = Buffer.concat([pending, chunk]);
      // Keep at least one byte back, so the last chunk is always sealed in flush().
      while (pending.length > CHUNK_BYTES) {
        const part = pending.subarray(0, CHUNK_BYTES);
        pending = pending.subarray(CHUNK_BYTES);
        this.push(record(key.encrypt(part, chunkAad(key, fileId, index, false))));
        index += 1;
      }
      done();
    },
    flush(done: TransformCallback) {
      // An empty file is one empty final chunk, so it too cannot be truncated unnoticed.
      this.push(record(key.encrypt(pending, chunkAad(key, fileId, index, true))));
      done();
    },
  });
}

export function decryptStream(key: DataKey, fileId: string): Transform {
  let pending = Buffer.alloc(0);
  let index = 0;
  let sawLast = false;

  // A chunk is either a middle chunk or the last one; only one of the two AADs opens it.
  const openChunk = (sealed: Buffer): Buffer => {
    try {
      return key.decrypt(sealed, chunkAad(key, fileId, index, false));
    } catch {
      const plain = key.decrypt(sealed, chunkAad(key, fileId, index, true));
      sawLast = true;
      return plain;
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      pending = Buffer.concat([pending, chunk]);
      try {
        while (pending.length >= LENGTH_BYTES) {
          const length = pending.readUInt32BE(0);
          if (pending.length < LENGTH_BYTES + length) break;
          if (sawLast) throw new Error('Data after the last chunk of the file');
          const sealed = pending.subarray(LENGTH_BYTES, LENGTH_BYTES + length);
          pending = pending.subarray(LENGTH_BYTES + length);
          this.push(openChunk(sealed));
          index += 1;
        }
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    flush(done: TransformCallback) {
      if (pending.length > 0 || !sawLast) {
        done(new Error('File is truncated or damaged'));
        return;
      }
      done();
    },
  });
}
