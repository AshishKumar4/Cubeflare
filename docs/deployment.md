# Deployment

Cubeflare is deployed through the `cubeflare deploy` wizard. It uses Wrangler's
Cloudflare login, creates the R2 buckets, writes Worker secrets through a
temporary secrets file, builds the Worker and Minecraft container image, deploys
with an immediate container rollout, and smoke-tests the deployed `/api/health`
endpoint.

A workers.dev hostname works by default. Custom domains and sandbox preview DNS
are optional.

## 1. Prerequisites

- Cloudflare Workers, Durable Objects, R2, and Containers enabled.
- Docker running locally.
- Node.js 20 or newer.
- Corepack enabled.
- Optional: a Cloudflare-routed domain for the control plane.

## 2. Install The CLI

```sh
curl -fsSL https://raw.githubusercontent.com/AshishKumar4/Cubeflare/main/public/install.sh | sh
cubeflare deploy
```

If you cloned the repository already, you can run the same wizard from the repo:

```sh
corepack enable
yarn install
node bin/cubeflare.mjs deploy
```

Useful options:

```sh
cubeflare deploy --account-id <account-id>
cubeflare deploy --domain minecraft.example.com --public-base-host minecraft.example.com
cubeflare deploy --worker-name cubeflare --bucket-prefix cubeflare
```

## 3. R2 S3 Credentials

The wizard creates the R2 buckets automatically. The current Sandbox SDK
production backup and restore transport still needs direct R2 S3 credentials so
the container can transfer backup snapshots directly to R2.

The wizard tries to create a scoped R2 API token automatically when the
Cloudflare credential has token-creation permission. If that is not available,
it opens the exact dashboard location and asks for the R2 S3 Access Key ID and
Secret Access Key.

For non-interactive deploys:

```sh
cubeflare deploy \
  --account-id <account-id> \
  --r2-access-key-id <access-key-id> \
  --r2-secret-access-key <secret-access-key> \
  --non-interactive
```

Or provide a bootstrap API token that can create account API tokens:

```sh
CUBEFLARE_BOOTSTRAP_API_TOKEN=<token> cubeflare deploy --account-id <account-id>
```

## 4. Account-Neutral Configuration

The checked-in `wrangler.jsonc` is intentionally account-neutral. It has no
custom routes and no account IDs, so one-click deploys can start on workers.dev.

Set these only when they apply to your deployment:

- R2 bucket names if you changed them from the defaults.
- `PUBLIC_BASE_HOST` if you want generated server manifests to prefer a custom
  control-plane hostname instead of the current request host.
- `PREVIEW_HOSTNAME` and route/DNS entries only if you want live Sandbox preview
  URLs in addition to the mirrored `/map/<server>/` route.

`PREVIEW_DNS_READY` can stay `false` unless you configure the wildcard preview
DNS record.

For a custom domain, pass `--domain <hostname>`. The wizard also uses that host
as `PUBLIC_BASE_HOST` unless you pass a separate `--public-base-host`.

If your backup bucket is in an R2 jurisdiction, add the endpoint in
`.dev.vars` for local development and pass it during deployment:

```sh
cubeflare deploy --backup-bucket-endpoint https://<account-id>.<jurisdiction>.r2.cloudflarestorage.com
```

## 5. Verify Locally

```sh
yarn release:check
```

## 6. Manual Deploy

```sh
corepack enable
yarn install
yarn release:check
node bin/cubeflare.mjs deploy --account-id <account-id>
```

Wrangler builds the Worker, uploads static assets, builds the Minecraft
container image from `Dockerfile`, pushes it to Cloudflare, and updates the
container application.

## 7. Smoke Test

```sh
curl -fsS https://your-worker.workers.dev/api/health
curl -fsSL https://your-worker.workers.dev/install.sh | sh
cubeflare help
cubeflare connect --help
```

Then use the browser UI to register, create a server, copy an invite command,
and connect with the CLI.

For a deeper smoke test:

```sh
BASE=https://your-worker.workers.dev yarn e2e:protocol
```

Run the E2E only against a deployment where test accounts and servers can be
deleted safely.
