import type { Readable } from 'node:stream';
import { z } from 'zod';

/** A file body a route streams back (NFR-5): never JSON, never cached. */
export interface FileDownload {
  stream: Readable;
  contentType: string;
  sizeBytes: number;
}

/**
 * Marks a response as a file stream. The server sends it as `application/octet-stream` in the
 * OpenAPI document and streams the body with no-store caching, instead of serialising JSON.
 */
export const FileDownloadSchema = z.custom<FileDownload>(
  (value) => typeof value === 'object' && value !== null && 'stream' in value,
);
