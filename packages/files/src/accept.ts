import type { TenantContext } from '@omnibridge/core';
import { filesScanJob, type JobQueue } from '@omnibridge/queue';
import type { FileStore } from './store.ts';
import { checkUpload } from './uploads.ts';

/**
 * The upload pipeline (SEC-2): type and size checks, encrypted storage as `scanning`, then a
 * `files.scan` job. The file becomes readable only when the scan marks it clean.
 */
export async function acceptUpload(
  deps: { store: FileStore; queue: JobQueue },
  ctx: TenantContext,
  input: {
    bytes: Uint8Array;
    filename: string;
    declaredType: string;
    maxBytes?: number;
    deleteAfter?: Date;
  },
): Promise<string> {
  const contentType = checkUpload(input);
  const id = await deps.store.put(ctx, {
    body: input.bytes,
    contentType,
    sizeBytes: input.bytes.length,
    ...(input.deleteAfter === undefined ? {} : { deleteAfter: input.deleteAfter }),
  });
  try {
    await deps.queue.send(filesScanJob, {
      ctx,
      idempotencyKey: `files.scan:${id}`,
      payload: { file_id: id },
    });
  } catch (err) {
    // Without a scan job the file could never become readable: remove it, then report the error.
    await deps.store.delete(ctx, id).catch(() => undefined);
    throw err;
  }
  return id;
}
