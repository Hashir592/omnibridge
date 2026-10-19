/** Upload types OmniBridge accepts (SEC-2): invoices, labels and images. */
export const UPLOAD_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type UploadRejection = 'empty' | 'too_large' | 'unsupported_type' | 'type_mismatch';

export class UploadRejected extends Error {
  readonly code: UploadRejection;
  constructor(code: UploadRejection, message: string) {
    super(message);
    this.name = 'UploadRejected';
    this.code = code;
  }
}

const EXTENSIONS: Readonly<Record<string, UploadType>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

/** The type the bytes really are, from their magic number, or undefined. */
export function sniffType(bytes: Uint8Array): UploadType | undefined {
  const starts = (sig: readonly number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  return undefined;
}

/**
 * Accepts an upload only when its size is within the limit and its bytes, its declared type and
 * its file extension all agree (SEC-2). Returns the type; throws UploadRejected otherwise. The
 * virus scan happens afterwards, in a worker job.
 */
export function checkUpload(input: {
  bytes: Uint8Array;
  filename: string;
  declaredType: string;
  maxBytes?: number;
}): UploadType {
  const max = input.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (input.bytes.length === 0) throw new UploadRejected('empty', 'The file is empty');
  if (input.bytes.length > max) {
    throw new UploadRejected('too_large', `The file is too large (limit ${String(max)} bytes)`);
  }
  const sniffed = sniffType(input.bytes);
  if (sniffed === undefined) {
    throw new UploadRejected('unsupported_type', 'Only PDF, PNG and JPEG files are accepted');
  }
  const extension = input.filename.toLowerCase().split('.').pop() ?? '';
  if (EXTENSIONS[extension] !== sniffed || input.declaredType !== sniffed) {
    throw new UploadRejected('type_mismatch', 'The file contents do not match its name or type');
  }
  return sniffed;
}
