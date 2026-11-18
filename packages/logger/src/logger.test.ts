import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLogger, MARKER_REDACTED, scrubString } from './logger.ts';

const SCAN = fileURLToPath(new URL('../../../scripts/lib/marker-scan.mjs', import.meta.url));

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test',
    version: '0.0.0',
    destination: { write: (line: string) => lines.push(line) },
  });
  return { logger, output: () => lines.join('') };
}

describe('logger', () => {
  it('[DP-8] logger redacts PII markers', () => {
    const { logger, output } = capture();

    logger.info(
      { buyerName: 'PIIMARK-name-1', workspaceId: 'ws-1 PIIMARK-ws-1', event: 'order.synced' },
      'shipping to PIIMARK-address-1',
    );
    logger.error({ err: new Error('label failed for PIIMARK-postcode-1') }, 'label error');
    logger.child({ route: '/orders/PIIMARK-route-1', buyer: 'PIIMARK-child-1' }).warn('child');
    logger.child({ component: 'a' }).child({ route: 'PIIMARK-grandchild-1' }).info('grandchild');
    logger.error(new Error('bare error PIIMARK-bare-1'));
    logger.error({ err: new Error('wrapped error PIIMARK-wrapped-1') });
    logger.info('format %s', 'PIIMARK-format-1');
    logger.info({ status: { note: 'PIIMARK-status-1', deeper: ['PIIMARK-array-1'] } });

    const text = output();
    for (const value of ['name-1', 'ws-1', 'address-1', 'postcode-1', 'route-1', 'child-1']) {
      expect(text).not.toContain(`PIIMARK-${value}`);
    }
    for (const value of [
      'grandchild-1',
      'bare-1',
      'wrapped-1',
      'format-1',
      'status-1',
      'array-1',
    ]) {
      expect(text).not.toContain(`PIIMARK-${value}`);
    }
    expect(text).toContain('"event":"order.synced"');
    expect(text).toContain(MARKER_REDACTED);
  });

  it('[AT-9] a marker logged through an allowed field is found by the scan (S5-20261118-03)', () => {
    const { logger, output } = capture();
    logger.error({ err: new Error('label failed for PIIMARK-Jane Doe'), status: 500 }, 'failed');
    const text = output();
    // The value is scrubbed, the marker that says it leaked is not.
    expect(text).not.toContain('PIIMARK-Jane');
    expect(text).toContain(MARKER_REDACTED);
    expect(scrubString(MARKER_REDACTED)).toBe(MARKER_REDACTED);
    const file = join(mkdtempSync(join(tmpdir(), 'ob-log-')), 'logs.txt');
    writeFileSync(file, text);
    const res = spawnSync(process.execPath, [SCAN, file], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('1 hits');
  });

  it('[DP-8] drops fields that are not on the allowlist', () => {
    const { logger, output } = capture();
    logger.info({ buyerName: 'Synthetic Buyer', shippingAddress: { line1: '1 Test St' } }, 'x');
    const text = output();
    expect(text).not.toContain('buyerName');
    expect(text).not.toContain('Synthetic Buyer');
    expect(text).not.toContain('1 Test St');
  });

  it('[DP-8] strips email addresses and query strings from text and request URLs', () => {
    const { logger, output } = capture();
    logger.info({ req: { method: 'GET', url: '/search?q=someone@example.test' } }, 'mail a@b.test');
    const text = output();
    expect(text).not.toContain('example.test');
    expect(text).not.toContain('a@b.test');
    expect(text).toContain('"url":"/search"');
  });

  it('[SEC-5][USR-7][USR-1] a reset or invite token in a request path is never logged', () => {
    const { logger, output } = capture();
    logger.info({ req: { method: 'GET', url: '/auth/password/reset/TOKENMARK-1' } }, 'in');
    logger.warn('failed for /auth/password/reset/TOKENMARK-2?x=1');
    logger.info({ req: { method: 'GET', url: '/auth/invites/TOKENMARK-3' } }, 'in');
    const text = output();
    expect(text).not.toContain('TOKENMARK');
    expect(text).toContain('"url":"/auth/password/reset/[REDACTED]"');
  });

  it('[SEC-5][USR-7][USR-1] the SPA invite and reset page tokens are never logged', () => {
    const { logger, output } = capture();
    logger.info({ req: { method: 'GET', url: '/invite/TOKENMARK-4' } }, 'in');
    logger.info({ req: { method: 'GET', url: '/reset-password?token=TOKENMARK-5&x=1' } }, 'in');
    logger.warn('failed for /reset-password?token=TOKENMARK-7&x=1');
    logger.info({ req: { method: 'GET', url: '/api/auth/invites/TOKENMARK-6' } }, 'in');
    const text = output();
    expect(text).not.toContain('TOKENMARK');
    expect(text).toContain('"url":"/invite/[REDACTED]"');
    expect(text).toContain('/reset-password?token=[REDACTED]&x=1');
  });

  it('[DP-8] scrubString leaves ordinary text alone', () => {
    expect(scrubString('heartbeat ok')).toBe('heartbeat ok');
  });
});
