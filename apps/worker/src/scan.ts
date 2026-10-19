import { scanWithClamd, type ClamdOptions, type FileStore } from '@omnibridge/files';
import type { Logger } from '@omnibridge/logger';
import type { JobHandler } from '@omnibridge/queue';

/**
 * The `files.scan` handler (SEC-2): decrypts the file as a stream straight into clamd INSTREAM and
 * records the verdict. If clamd cannot be reached the handler throws, so the job retries and the
 * file stays `scanning`; it is never treated as clean (ADR-021).
 */
export function scanFileHandler(deps: {
  files: FileStore;
  clamd: ClamdOptions;
  logger: Logger;
}): JobHandler<{ file_id: string }> {
  return async (job) => {
    const file = await deps.files.openForScan(job.ctx, job.payload.file_id);
    if (file.meta.state !== 'scanning') {
      file.stream.destroy();
      return { state: file.meta.state }; // already decided: the job is idempotent
    }
    const verdict = await scanWithClamd(deps.clamd, file.stream);
    await deps.files.setState(job.ctx, job.payload.file_id, verdict);
    deps.logger.info(
      { event: 'file.scanned', workspaceId: job.ctx.workspaceId, status: verdict },
      'file scanned',
    );
    return { state: verdict };
  };
}
