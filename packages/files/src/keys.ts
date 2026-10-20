import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  generateDataKey,
  rewrapDataKey,
  unwrapDataKey,
  type DataKey,
  type Keyring,
  type WrappedDataKey,
} from '@omnibridge/crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_FILE = /^v(\d+)\.json$/;

interface KeyFile {
  version: number;
  kekVersion: number;
  wrapped: string;
}

/** A workspace directory on the files volume. The id is checked, so it can never leave the root. */
export function workspaceDir(root: string, workspaceId: string): string {
  if (!UUID.test(workspaceId)) throw new Error('Workspace id must be a lower-case UUID');
  return join(root, workspaceId);
}

/**
 * Per-workspace file data keys (NFR-5), kept next to the files they protect but only in wrapped
 * form: the secrets master key that unwraps them lives in a Docker secret, never on this volume.
 * Each key is `<root>/<workspace>/keys/v<n>.json`.
 */
export class FileKeyStore {
  readonly #root: string;
  readonly #keyring: Keyring;

  constructor(root: string, keyring: Keyring) {
    this.#root = root;
    this.#keyring = keyring;
  }

  /** The newest file key of the workspace, created on first use. */
  async active(workspaceId: string): Promise<DataKey> {
    const versions = await this.#versions(workspaceId);
    const newest = versions.at(-1);
    if (newest !== undefined) return this.get(workspaceId, newest);
    const { dataKey, wrapped } = generateDataKey(this.#keyring, workspaceId, 1);
    const dir = this.#keysDir(workspaceId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      // `wx`: two writers racing for version 1 cannot both win; the loser reads the winner's key.
      await writeFile(join(dir, 'v1.json'), JSON.stringify(toFile(wrapped)), {
        flag: 'wx',
        mode: 0o600,
      });
      return dataKey;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return this.get(workspaceId, 1);
    }
  }

  async get(workspaceId: string, version: number): Promise<DataKey> {
    const text = await readFile(
      join(this.#keysDir(workspaceId), `v${String(version)}.json`),
      'utf8',
    );
    return unwrapDataKey(this.#keyring, fromFile(workspaceId, JSON.parse(text) as KeyFile));
  }

  /** KEK rotation for files: re-wraps every workspace's file keys; file bodies are untouched. */
  async rewrapAll(): Promise<number> {
    let count = 0;
    const workspaces = await readdir(this.#root).catch(() => []);
    for (const workspaceId of workspaces.filter((name) => UUID.test(name))) {
      for (const version of await this.#versions(workspaceId)) {
        const path = join(this.#keysDir(workspaceId), `v${String(version)}.json`);
        const stored = fromFile(workspaceId, JSON.parse(await readFile(path, 'utf8')) as KeyFile);
        const next = rewrapDataKey(this.#keyring, stored);
        if (next === stored) continue;
        await writeFile(`${path}.tmp`, JSON.stringify(toFile(next)), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
        count += 1;
      }
    }
    return count;
  }

  #keysDir(workspaceId: string): string {
    return join(workspaceDir(this.#root, workspaceId), 'keys');
  }

  async #versions(workspaceId: string): Promise<number[]> {
    const names = await readdir(this.#keysDir(workspaceId)).catch(() => []);
    return names
      .map((name) => KEY_FILE.exec(name)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }
}

function toFile(wrapped: WrappedDataKey): KeyFile {
  return {
    version: wrapped.version,
    kekVersion: wrapped.kekVersion,
    wrapped: wrapped.wrapped.toString('base64'),
  };
}

function fromFile(workspaceId: string, file: KeyFile): WrappedDataKey {
  return {
    workspaceId,
    version: file.version,
    kekVersion: file.kekVersion,
    wrapped: Buffer.from(file.wrapped, 'base64'),
  };
}
