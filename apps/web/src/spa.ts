import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { API_PREFIX } from '@omnibridge/contract';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The built SPA (apps/ui/dist), held in memory (ADR-060). Vite's output is a few MB, and serving
 * only exact keys read at boot means no request path ever reaches the filesystem.
 */
export interface SpaFiles {
  index: Buffer;
  /** `/assets/<name>` → bytes and content type. */
  assets: ReadonlyMap<string, { body: Buffer; type: string }>;
}

const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Reads index.html and every file under assets/; throws if the build is missing. */
export function loadSpa(dir: string): SpaFiles {
  const index = readFileSync(join(dir, 'index.html'));
  const assets = new Map<string, { body: Buffer; type: string }>();
  const assetDir = join(dir, 'assets');
  for (const entry of readdirSync(assetDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const key = `/assets/${file.slice(assetDir.length + 1).replaceAll('\\', '/')}`;
    assets.set(key, {
      body: readFileSync(file),
      type: TYPES[extname(entry.name)] ?? 'application/octet-stream',
    });
  }
  return { index, assets };
}

/** Paths that are never SPA pages: the API, the PRD-fixed outside paths and the assets. */
function underAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}
const NOT_PAGES = [API_PREFIX, '/webhooks', '/connect', '/healthz'] as const;

/**
 * Answers a GET for a page or an asset. Returns false when the path is not the SPA's, so the
 * caller sends the JSON 404. No header sniffing (ADR-060): the path alone decides.
 */
export function sendSpa(spa: SpaFiles, request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  // Decoded, so an encoded form such as /%61pi/x is still the API's JSON 404, never the page.
  let path: string;
  try {
    path = decodeURIComponent(request.url.split(/[?#]/, 1)[0] ?? '');
  } catch {
    return false;
  }
  if (underAny(path, NOT_PAGES)) return false;
  if (underAny(path, ['/assets'])) {
    const asset = spa.assets.get(path);
    if (asset === undefined) return false;
    // File names carry a content hash, so a cached copy never goes stale.
    void reply
      .code(200)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .type(asset.type)
      .send(asset.body);
    return true;
  }
  // Every page is index.html; the SPA router reads the path. Revalidated on every load, so a
  // release reaches the browser at once.
  void reply
    .code(200)
    .header('cache-control', 'no-cache')
    .type('text/html; charset=utf-8')
    .send(spa.index);
  return true;
}
