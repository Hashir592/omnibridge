import type { Logger } from '@omnibridge/logger';
import {
  DeleteRequest,
  EbayUserMatchRequest,
  ExpiryRequest,
  IngestRequest,
  MaskRequest,
  MatchRequest,
  ReadFullRequest,
  SearchRequest,
  SignalsRequest,
  type Capability,
} from '@omnibridge/vault-client/schemas';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { CALLER_READ_PURPOSES, can, type ServiceTokens } from './auth.ts';
import type { DeletionService } from './deletion.ts';
import {
  BadExpiry,
  NotFound,
  PurposeRefused,
  WorkspaceClosed,
  type Caller,
  type Vault,
} from './vault.ts';

export interface VaultAppOptions {
  logger: Logger;
  version: string;
  /** db-pii answers as vault_app. */
  dbPii: () => Promise<boolean>;
  /** The API is served only when both are given (the healthcheck-only tests leave them out). */
  vault?: Vault;
  tokens?: ServiceTokens;
  deletion?: DeletionService;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/**
 * pii-vault: the only db-pii client (invariant 7). The API is capability-scoped (invariant 8):
 * each request carries its caller's service token and the workspace, and the body never reaches
 * a log (request logging is off; errors carry a code only).
 */
export function buildVaultApp({
  logger,
  version,
  dbPii,
  vault,
  tokens,
  deletion,
}: VaultAppOptions) {
  // disableRequestLogging: request lines would hold nothing personal, but errors would carry
  // bodies, so the vault logs only what it chooses to, with IDs and codes.
  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: true,
    bodyLimit: 256 * 1024,
  });

  app.get('/healthz', { logLevel: 'warn' }, async (_request, reply) => {
    let healthy = false;
    try {
      healthy = await dbPii();
    } catch {
      healthy = false;
    }
    return reply
      .code(healthy ? 200 : 503)
      .send({ status: healthy ? 'ok' : 'degraded', db_pii: healthy ? 'ok' : 'error', version });
  });

  if (vault === undefined || tokens === undefined || deletion === undefined) return app;

  const authorise = (request: FastifyRequest, capability: Capability): Caller => {
    const caller = tokens.callerOf(request.headers.authorization);
    if (caller === undefined) throw new HttpError(401, 'unauthorised');
    if (!can(caller, capability)) throw new HttpError(403, 'capability_missing');
    return caller;
  };
  const parse = <S extends z.ZodType>(schema: S, body: unknown): z.infer<S> => {
    const result = schema.safeParse(body);
    if (!result.success) throw new HttpError(422, 'validation_failed');
    return result.data;
  };

  app.setErrorHandler((err: Error, request, reply: FastifyReply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code });
    if (err instanceof NotFound) return reply.code(404).send({ error: 'not_found' });
    if (err instanceof PurposeRefused)
      return reply.code(403).send({ error: 'purpose_not_allowed' });
    if (err instanceof BadExpiry) return reply.code(400).send({ error: 'invalid_expiry' });
    if (err instanceof WorkspaceClosed) return reply.code(409).send({ error: 'workspace_closed' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'bad_request' });
    }
    // Only the error's class and the route: messages can quote SQL parameters.
    request.log.error(
      { event: 'vault.error', errorName: err.name, route: request.routeOptions.url },
      'vault error',
    );
    return reply.code(500).send({ error: 'internal' });
  });

  app.post('/v1/ingest', async (request, reply) => {
    authorise(request, 'ingest');
    const body = parse(IngestRequest, request.body);
    return reply.code(201).send(await vault.ingest(body));
  });

  app.post('/v1/expiry', async (request) => {
    authorise(request, 'ingest');
    return vault.setExpiry(parse(ExpiryRequest, request.body));
  });

  app.post('/v1/read', async (request) => {
    const caller = authorise(request, 'read_full');
    const body = parse(ReadFullRequest, request.body);
    if (!CALLER_READ_PURPOSES[caller].includes(body.purpose)) {
      throw new HttpError(403, 'purpose_not_allowed');
    }
    return vault.readFull(body.workspace_id, body.pii_ref, body.purpose, {
      caller,
      userId: body.actor_user_id,
    });
  });

  app.post('/v1/mask', async (request) => {
    const caller = authorise(request, 'mask');
    const body = parse(MaskRequest, request.body);
    return vault.mask(body.workspace_id, body.pii_refs, { caller });
  });

  app.post('/v1/search', async (request) => {
    const caller = authorise(request, 'search');
    const body = parse(SearchRequest, request.body);
    return vault.search(body.workspace_id, body.query, body.purpose, {
      caller,
      userId: body.actor_user_id,
    });
  });

  app.post('/v1/match', async (request) => {
    const caller = authorise(request, 'match');
    const body = parse(MatchRequest, request.body);
    return vault.match(body.workspace_id, body.pii_ref, { caller });
  });

  // AT-10: an eBay deletion notice, matched across workspaces; web's token only (FA-14).
  app.post('/v1/ebay-user-match', async (request) => {
    const caller = authorise(request, 'search');
    if (caller !== 'web') throw new HttpError(403, 'capability_missing');
    return vault.ebayUserMatch(parse(EbayUserMatchRequest, request.body), { caller });
  });

  // SEC-12: counts and IDs for the security alerts, for the worker's token only.
  app.post('/v1/signals', async (request) => {
    authorise(request, 'signals');
    return vault.signals(parse(SignalsRequest, request.body));
  });

  // DEL-1: the deletion service, for the deletion jobs' token only.
  app.post('/v1/delete', async (request) => {
    authorise(request, 'delete');
    return deletion.delete(parse(DeleteRequest, request.body));
  });

  return app;
}
