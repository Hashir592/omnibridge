# OmniBridge

Multi-tenant back office for UK sellers on Amazon, eBay and their own website. Start with
[`CLAUDE.md`](CLAUDE.md) and [`docs/STATE.md`](docs/STATE.md).

## Run locally

Everything runs on local Docker with provider mocks (ADR-029). Synthetic data only.

### Prerequisites (Windows 10/11)

- **Git for Windows**: run every command below in **Git Bash**.
- **Docker Desktop** (WSL 2 backend), running. The full stack with the virus scanner needs about
  4.7 GB of container memory at its limits, plus room for image builds and the browser tests;
  give WSL 2 at least 8 GB in `%UserProfile%\.wslconfig`:

  ```ini
  [wsl2]
  memory=8GB
  ```

  then run `wsl --shutdown` and restart Docker Desktop.

- **Node.js 24.22.0** (`.nvmrc`). Older 24.x releases work with a warning.
- **pnpm via corepack**: the version comes from `package.json` (`packageManager`), so run
  `corepack pnpm …`. If corepack fails with `EXDEV: cross-device link not permitted`, point its
  cache at the same drive as the repo, for example `export COREPACK_HOME='D:\.corepack'`.

### First run

```bash
corepack pnpm install
```

`install` also installs the git hooks (lefthook): Prettier, ESLint and gitleaks before each commit,
and a commit-message check (Conventional Commits plus a `Refs:` line of PRD IDs).

### Start the stack

```bash
bash scripts/dev-secrets.sh
```

```bash
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml up -d --build --wait
```

Add `--profile scan` (before `up`) to include the clamd virus scanner (1.4 GB).

| URL                            | What                                             |
| ------------------------------ | ------------------------------------------------ |
| https://localhost:8443/healthz | App health: `{status, db_main, db_pii, version}` |
| https://localhost:8444         | Public site placeholder                          |
| http://localhost:8025          | Mailpit (captured outgoing mail)                 |

HTTPS uses Caddy's local CA. To call it with curl, export the root certificate once:

```bash
bash scripts/dev-ca.sh
```

```bash
curl -fsS --ssl-no-revoke --cacert infra/compose/.local/caddy-root.crt https://localhost:8443/healthz
```

(`--ssl-no-revoke` is needed only by Windows curl, which cannot check revocation for a local CA.)

Stop everything with:

```bash
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml --profile scan down
```

### Quality gate

```bash
bash scripts/verify.sh
```

The full gate must pass before any merge; CI runs the same script. `bash scripts/verify.sh --quick`
(lint, typecheck, unit tests) is for use while working, and `--help` lists every step.
