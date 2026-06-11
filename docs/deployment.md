# Deployment

Cubeflare is deployed through the `cubeflare deploy` wizard. It uses Wrangler's
Cloudflare login, creates the single R2 bucket, writes Worker secrets through a
temporary secrets file, builds the Worker and Minecraft container image, deploys
with an immediate container rollout, and smoke-tests the deployed `/api/health`
endpoint.

Everything lives in one R2 bucket (named after the Worker by default): backups
under the `backups/` prefix and the Dynmap mirror under `dynmap/`.

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
cubeflare deploy --worker-name cubeflare --bucket cubeflare
```

## 3. R2 S3 Credentials

The wizard creates the R2 bucket automatically. The current Sandbox SDK
production backup and restore transport still needs direct R2 S3 credentials so
the container can transfer backup snapshots directly to R2.

On redeploys the wizard reuses the R2 credentials already stored as Worker
secrets, so credentials are only needed the first time (pass
`--r2-access-key-id` and `--r2-secret-access-key` to rotate them). Wrangler's
OAuth login cannot create API tokens, so a first deploy needs a one-time manual
step: the wizard prints the exact dashboard location
(`https://dash.cloudflare.com/?to=/:account/r2/api-tokens`) and asks for the R2
S3 Access Key ID and Secret Access Key. If you provide an API token with
token-creation permission (`--cloudflare-api-token` or
`CUBEFLARE_BOOTSTRAP_API_TOKEN`), the wizard mints a bucket-scoped token
automatically instead.

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

- The R2 bucket name if you changed it from the default.
- `PUBLIC_BASE_HOST` if you want generated server manifests to prefer a custom
  control-plane hostname instead of the current request host.
- `PREVIEW_HOSTNAME` and route/DNS entries only if you want live Sandbox preview
  URLs in addition to the mirrored `/map/<server>/` route.

`PREVIEW_DNS_READY` can stay `false` unless you configure the wildcard preview
DNS record.

For a custom domain, pass `--domain <hostname>`. The wizard also uses that host
as `PUBLIC_BASE_HOST` unless you pass a separate `--public-base-host`.

If your bucket is in an R2 jurisdiction, add the endpoint in
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

## 8. Undeploy

`cubeflare undeploy` permanently deletes the Worker (including its secrets and
all Durable Object data) and the R2 bucket with every object in it, backups
included. It prompts for the worker name as confirmation; pass `--yes` for
non-interactive teardowns:

```sh
cubeflare undeploy --account-id <account-id>
cubeflare undeploy --account-id <account-id> --yes --non-interactive
```
