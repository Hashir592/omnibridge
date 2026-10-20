import { connect } from 'node:net';
import type { Readable } from 'node:stream';

export interface ClamdOptions {
  host: string;
  port: number;
  /** The whole scan, from connect to verdict. */
  timeoutMs?: number;
}

export type ScanVerdict = 'clean' | 'infected' | 'scan_failed';

/** clamd takes INSTREAM chunks up to StreamMaxLength; 64 KiB keeps memory flat. */
const MAX_CHUNK = 64 * 1024;

function verdictOf(reply: string): ScanVerdict {
  const text = reply.replace(/\0/g, '').trim();
  if (/\bFOUND$/.test(text)) return 'infected';
  if (/:\s*OK$/.test(text)) return 'clean';
  return 'scan_failed';
}

/**
 * Streams content to clamd with the INSTREAM command (SEC-2, ADR-021) and maps its verdict. A
 * connection failure or timeout rejects: the caller leaves the file in `scanning` and retries; it
 * is never treated as clean.
 */
export function scanWithClamd(options: ClamdOptions, content: Readable): Promise<ScanVerdict> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: options.host, port: options.port });
    let reply = '';
    let settled = false;
    const finish = (err: Error | undefined, verdict?: ScanVerdict) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      content.destroy();
      if (err !== undefined) reject(err);
      else if (verdict !== undefined) resolve(verdict);
    };
    socket.setTimeout(options.timeoutMs ?? 120_000, () => {
      finish(new Error('clamd timed out'));
    });
    socket.on('error', (err) => {
      // clamd may close early (a size limit, say) after it has sent its verdict.
      if (reply.length > 0) finish(undefined, verdictOf(reply));
      else finish(err);
    });
    socket.on('data', (data: Buffer) => {
      reply += data.toString('utf8');
    });
    socket.on('end', () => {
      if (reply.length === 0) finish(new Error('clamd closed without a verdict'));
      else finish(undefined, verdictOf(reply));
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      content.on('data', (chunk: Buffer) => {
        for (let at = 0; at < chunk.length; at += MAX_CHUNK) {
          const part = chunk.subarray(at, at + MAX_CHUNK);
          const length = Buffer.alloc(4);
          length.writeUInt32BE(part.length);
          socket.write(length);
          // Respect backpressure: pause the file stream until clamd has taken what is buffered.
          if (!socket.write(part)) {
            content.pause();
            socket.once('drain', () => content.resume());
          }
        }
      });
      content.on('end', () => {
        socket.write(Buffer.alloc(4)); // a zero-length chunk ends the stream
      });
      content.on('error', (err) => {
        finish(err);
      });
    });
  });
}
