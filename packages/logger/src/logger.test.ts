import { describe, expect, it } from 'vitest';
import { createLogger, scrubString } from './logger.ts';

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
    expect(text).not.toContain('PIIMARK-');
    expect(text).toContain('"event":"order.synced"');
    expect(text).toContain('[REDACTED]');
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
