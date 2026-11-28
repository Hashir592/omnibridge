import type { z } from 'zod';
import {
  SignalsResponse,
  type SignalsRequest,
  DeleteResponse,
  EbayUserMatchResponse,
  ExpiryResponse,
  IngestResponse,
  LabelIdsResponse,
  LabelStoreResponse,
  MaskResponse,
  MatchResponse,
  ReadFullResponse,
  ReplaceResponse,
  SearchResponse,
  SubjectsResponse,
  type DeleteRequest,
  type EbayUserMatchRequest,
  type ExpiryRequest,
  type IngestRequest,
  type MatchRequest,
  type ReadPurpose,
  type ReplaceRequest,
  type SearchPurpose,
  type SearchRequest,
  type SubjectsRequest,
} from './schemas.ts';

/** A vault answer other than success. `status` is the HTTP status; `code` the vault's error code. */
export class VaultError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`pii-vault answered ${String(status)} ${code}`);
    this.name = 'VaultError';
    this.status = status;
    this.code = code;
  }
}

export interface VaultClientOptions {
  /** PII_VAULT_URL, for example http://pii-vault:8080 (the ob_app network only). */
  baseUrl: string;
  /** This caller's service token (a Docker secret); never logged. */
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * The typed pii-vault client for web and worker (T-0402). It holds no db-pii credentials and no
 * key: what it can do is exactly what its token's capabilities allow (invariant 8). Errors carry
 * a status and code only, never a request body, so a thrown error cannot leak PII into a log.
 */
export class VaultClient {
  readonly #base: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: VaultClientOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#fetch = options.fetch ?? fetch;
  }

  ingest(request: IngestRequest): Promise<IngestResponse> {
    return this.#post('/v1/ingest', request, IngestResponse);
  }

  /** ORD-4: a buyer block the channel corrected before dispatch (worker token). */
  replace(request: ReplaceRequest): Promise<ReplaceResponse> {
    return this.#post('/v1/replace', request, ReplaceResponse);
  }

  setExpiry(request: ExpiryRequest): Promise<ExpiryResponse> {
    return this.#post('/v1/expiry', request, ExpiryResponse);
  }

  /** FA-10: order records older than a time, IDs only, for the orphan sweep (worker token). */
  subjects(request: SubjectsRequest): Promise<SubjectsResponse> {
    return this.#post('/v1/subjects', request, SubjectsResponse);
  }

  readFull(request: {
    workspaceId: string;
    piiRef: string;
    purpose: ReadPurpose;
    actorUserId?: string;
  }): Promise<ReadFullResponse> {
    return this.#post(
      '/v1/read',
      {
        workspace_id: request.workspaceId,
        pii_ref: request.piiRef,
        purpose: request.purpose,
        ...(request.actorUserId === undefined ? {} : { actor_user_id: request.actorUserId }),
      },
      ReadFullResponse,
    );
  }

  mask(workspaceId: string, piiRefs: readonly string[]): Promise<MaskResponse> {
    return this.#post('/v1/mask', { workspace_id: workspaceId, pii_refs: piiRefs }, MaskResponse);
  }

  search(request: {
    workspaceId: string;
    purpose: SearchPurpose;
    query: SearchRequest['query'];
    actorUserId?: string;
  }): Promise<SearchResponse> {
    return this.#post(
      '/v1/search',
      {
        workspace_id: request.workspaceId,
        purpose: request.purpose,
        query: request.query,
        ...(request.actorUserId === undefined ? {} : { actor_user_id: request.actorUserId }),
      },
      SearchResponse,
    );
  }

  /** DEL-1: the deletion jobs only (the deletion token). */
  delete(request: DeleteRequest): Promise<DeleteResponse> {
    return this.#post('/v1/delete', request, DeleteResponse);
  }

  /** AT-10: the refs of one eBay user in every workspace (web only). */
  ebayUserMatch(request: EbayUserMatchRequest): Promise<EbayUserMatchResponse> {
    return this.#post('/v1/ebay-user-match', request, EbayUserMatchResponse);
  }

  /** SEC-12: read counts and canary reads of one workspace (the worker's token only). */
  signals(request: SignalsRequest): Promise<SignalsResponse> {
    return this.#post('/v1/signals', request, SignalsResponse);
  }

  match(request: MatchRequest): Promise<MatchResponse> {
    return this.#post('/v1/match', request, MatchResponse);
  }

  /** Invariant 11: stores a label PDF for buyer records (the worker's token only). */
  storeLabel(request: {
    workspaceId: string;
    labelId: string;
    piiRefs: readonly string[];
    pdf: Uint8Array;
  }): Promise<LabelStoreResponse> {
    return this.#post(
      '/v1/labels/store',
      {
        workspace_id: request.workspaceId,
        label_id: request.labelId,
        pii_refs: request.piiRefs,
        pdf_base64: Buffer.from(request.pdf).toString('base64'),
      },
      LabelStoreResponse,
    );
  }

  /** The labels of these shipments that are stored (IDs only). */
  storedLabels(workspaceId: string, labelIds: readonly string[]): Promise<LabelIdsResponse> {
    return this.#post(
      '/v1/labels/stored',
      { workspace_id: workspaceId, label_ids: labelIds },
      LabelIdsResponse,
    );
  }

  /** SHP-5: a voided label's file goes at once (the worker's token only). */
  discardLabels(workspaceId: string, labelIds: readonly string[]): Promise<LabelIdsResponse> {
    return this.#post(
      '/v1/labels/discard',
      { workspace_id: workspaceId, label_ids: labelIds },
      LabelIdsResponse,
    );
  }

  /**
   * SHP-2, FA-15: one PDF of up to 200 labels, merged by the vault and never stored. Each label is
   * logged as a full read for printing. The bytes are the caller's to stream, never to keep.
   */
  async mergeLabels(request: {
    workspaceId: string;
    labelIds: readonly string[];
    actorUserId?: string;
  }): Promise<Uint8Array> {
    const response = await this.#fetch(`${this.#base}/v1/labels/merge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: request.workspaceId,
        label_ids: request.labelIds,
        ...(request.actorUserId === undefined ? {} : { actor_user_id: request.actorUserId }),
      }),
      // A 200-label merge takes longer than a field read.
      signal: AbortSignal.timeout(Math.max(this.#timeoutMs, 60_000)),
    });
    if (!response.ok) {
      const json: unknown = await response.json().catch(() => ({}));
      const code =
        typeof json === 'object' &&
        json !== null &&
        'error' in json &&
        typeof json.error === 'string'
          ? json.error
          : 'unknown';
      throw new VaultError(response.status, code);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async #post<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.infer<S>> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const json: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code =
        typeof json === 'object' &&
        json !== null &&
        'error' in json &&
        typeof json.error === 'string'
          ? json.error
          : 'unknown';
      throw new VaultError(response.status, code);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new VaultError(502, 'bad_vault_response');
    return parsed.data;
  }
}
