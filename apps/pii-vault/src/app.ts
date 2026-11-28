import type { Logger } from '@omnibridge/logger';
import {
  DeleteRequest,
  EbayUserMatchRequest,
  ExpiryRequest,
  IngestRequest,
  LabelIdsRequest,
  LabelMergeRequest,
  LabelStoreRequest,
  MaskRequest,
  MatchRequest,
  ReadFullRequest,
  ReplaceRequest,
  SearchRequest,
  SignalsRequest,
  SubjectsRequest,
  type Capability,
} from '@omnibridge/vault-client/schemas';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { CALLER_READ_PURPOSES, can, type ServiceTokens } from './auth.ts';
import type { DeletionService } from './deletion.ts';
import { NotPdf, type LabelStore } from './labels.ts';
import {
  BadExpiry,
  NotFound,
  PurposeRefused,
  WorkspaceClosed,
  BuyerDeleted,
  VaultBusy,
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
  /** Label files (invariant 11); without it the label routes answer 404. */
  labels?: LabelStore;
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
  labels,
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
    if (err instanceof VaultBusy) return reply.code(503).send({ error: 'busy' });
    if (err instanceof BuyerDeleted) return reply.code(409).send({ error: 'buyer_deleted' });
    if (err instanceof NotPdf) return reply.code(422).send({ error: 'not_a_pdf' });
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

  // ORD-4: an address corrected before dispatch; the worker's order sync only.
  app.post('/v1/replace', async (request) => {
    const caller = authorise(request, 'ingest');
    if (caller !== 'worker') throw new HttpError(403, 'capability_missing');
    return vault.replace(parse(ReplaceRequest, request.body));
  });

  // DEL-1: the worker's expiry jobs only; web never moves a date.
  app.post('/v1/expiry', async (request) => {
    const caller = authorise(request, 'ingest');
    if (caller !== 'worker') throw new HttpError(403, 'capability_missing');
    return vault.setExpiry(parse(ExpiryRequest, request.body));
  });

  // FA-10: the nightly orphan sweep lists order records, IDs only (the worker's token).
  app.post('/v1/subjects', async (request) => {
    const caller = authorise(request, 'ingest');
    if (caller !== 'worker') throw new HttpError(403, 'capability_missing');
    return vault.subjects(parse(SubjectsRequest, request.body));
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
    return vault.match(body, { caller });
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

  // ---- Label files (T-1201, invariant 11) ----------------------------------------------------
  if (labels !== undefined) {
    // The worker stores the carrier's PDF, base64 in JSON (a label is at most 2 MB).
    app.post('/v1/labels/store', { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
      const caller = authorise(request, 'ingest');
      if (caller !== 'worker') throw new HttpError(403, 'capability_missing');
      const body = parse(LabelStoreRequest, request.body);
      const result = await labels.store({
        workspaceId: body.workspace_id,
        labelId: body.label_id,
        piiRefs: body.pii_refs,
        pdf: Buffer.from(body.pdf_base64, 'base64'),
      });
      return reply.code(result.stored ? 201 : 200).send(result);
    });

    // SHP-2, FA-15: one PDF, built in memory, streamed back and never written.
    app.post('/v1/labels/merge', async (request, reply) => {
      // Printing labels (web, SHP-2) and the worker; never a field read: web still may not read
      // a record in full for a label (DP-7), it only gets the carrier's file back, merged.
      const caller = authorise(request, 'read_full');
      if (caller !== 'web' && caller !== 'worker') throw new HttpError(403, 'purpose_not_allowed');
      const body = parse(LabelMergeRequest, request.body);
      const pdf = await labels.merge(body.workspace_id, body.label_ids, {
        caller,
        userId: body.actor_user_id,
      });
      return reply
        .header('cache-control', 'no-store')
        .type('application/pdf')
        .send(Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength));
    });

    // IDs only: which of these labels are stored (a reprint fetches the rest by barcode).
    app.post('/v1/labels/stored', async (request) => {
      authorise(request, 'read_full');
      const body = parse(LabelIdsRequest, request.body);
      return { label_ids: await labels.stored(body.workspace_id, body.label_ids) };
    });

    // SHP-5: a voided label's file goes at once; the worker's token only.
    app.post('/v1/labels/discard', async (request) => {
      const caller = authorise(request, 'ingest');
      if (caller !== 'worker') throw new HttpError(403, 'capability_missing');
      const body = parse(LabelIdsRequest, request.body);
      const gone: string[] = [];
      for (const id of body.label_ids) {
        if ((await labels.discard(body.workspace_id, id)) > 0) gone.push(id);
      }
      return { label_ids: gone };
    });
  }

  return app;
}
