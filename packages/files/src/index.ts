/**
 * Encrypted file storage, signed download links, upload checks and the clamd client (T-0105,
 * NFR-5, SEC-2, ADR-012). Labels are not stored here: they stay inside the PII boundary (M04).
 */
export const PACKAGE_NAME = '@omnibridge/files';

export { acceptUpload } from './accept.ts';
export { CHUNK_BYTES, decryptStream, encryptStream } from './chunked.ts';
export { scanWithClamd, type ClamdOptions, type ScanVerdict } from './clamd.ts';
export { FileKeyStore, workspaceDir } from './keys.ts';
export { LINK_TTL_SECONDS, signFileLink, verifyFileLink, type FileLink } from './links.ts';
export {
  EncryptedLocalFileStore,
  FileNotReadable,
  type FileMeta,
  type FileMetadataStore,
  type FileState,
  type FileStore,
  type StoredFile,
} from './store.ts';
export {
  checkUpload,
  DEFAULT_MAX_UPLOAD_BYTES,
  sniffType,
  UPLOAD_TYPES,
  UploadRejected,
  type UploadRejection,
  type UploadType,
} from './uploads.ts';
