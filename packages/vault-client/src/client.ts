import type { z } from 'zod';
import {
  DeleteResponse,
  EbayUserMatchResponse,
  ExpiryResponse,
  IngestResponse,
  MaskResponse,
  MatchResponse,
  ReadFullResponse,
  SearchResponse,
  type DeleteRequest,
  type EbayUserMatchRequest,
  type ExpiryRequest,
  type IngestRequest,
  type ReadPurpose,
  type SearchPurpose,
  type SearchRequest,
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

  setExpiry(request: ExpiryRequest): Promise<ExpiryResponse> {
    return this.#post('/v1/expiry', request, ExpiryResponse);
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

  match(workspaceId: string, piiRef: string): Promise<MatchResponse> {
    return this.#post('/v1/match', { workspace_id: workspaceId, pii_ref: piiRef }, MatchResponse);
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
