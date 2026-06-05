# Deployment

This guide deploys Cubeflare to a Cloudflare account and custom domain.

## 1. Prerequisites

- Cloudflare Workers, Durable Objects, R2, and Containers enabled.
- Docker running locally.
- Node.js 20 or newer.
- Corepack enabled.
- A Cloudflare-routed domain for the control plane, for example
  `minecraft.example.com`.

## 2. Install Dependencies

```sh
corepack enable
yarn install
```

## 3. Create R2 Buckets

```sh
yarn wrangler r2 bucket create cubeflare-backups
yarn wrangler r2 bucket create cubeflare-dynmap
yarn wrangler r2 bucket create cubeflare-plugins
```

Use different bucket names if you prefer, then update `wrangler.jsonc`.

## 4. Configure `wrangler.jsonc`

Set these values for your deployment:

- `PUBLIC_BASE_HOST`: the public control-plane hostname.
- `PREVIEW_HOSTNAME`: the wildcard preview hostname for Sandbox previews.
- Route patterns under `routes`.
- R2 bucket names.
- `CLOUDFLARE_ACCOUNT_ID`.
- `BACKUP_BUCKET_NAME`.

`PREVIEW_DNS_READY` can stay `false` unless you configure the wildcard preview
DNS record.

## 5. Configure Secrets

Cubeflare has one app root secret:

```sh
openssl rand -base64 48 | yarn wrangler secret put CUBEFLARE_SECRET
```

The current Cloudflare Sandbox SDK backup and restore APIs still need direct R2
S3 credentials for presigned container-to-R2 transfer:

```sh
yarn wrangler secret put R2_ACCESS_KEY_ID
yarn wrangler secret put R2_SECRET_ACCESS_KEY
```

If your backup bucket is in an R2 jurisdiction, add the endpoint in
`.dev.vars` for local development and as a Worker variable for production:

```text
BACKUP_BUCKET_ENDPOINT=https://<account-id>.<jurisdiction>.r2.cloudflarestorage.com
```

## 6. Verify Locally

```sh
yarn release:check
```

## 7. Deploy

```sh
yarn deploy
```

Wrangler builds the Worker, uploads static assets, builds the Minecraft
container image from `Dockerfile`, pushes it to Cloudflare, and updates the
container application.

## 8. Smoke Test

```sh
curl -fsS https://your-cubeflare-domain.example/api/health
curl -fsSL https://your-cubeflare-domain.example/install.sh | sh
cubeflare help
cubeflare connect --help
```

Then use the browser UI to register, create a server, copy an invite command,
and connect with the CLI.

For a deeper smoke test:

```sh
BASE=https://your-cubeflare-domain.example yarn e2e:protocol
```

Run the E2E only against a deployment where test accounts and servers can be
deleted safely.
