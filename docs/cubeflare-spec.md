# Cubeflare Release Spec

Cubeflare is a Cloudflare-native Minecraft Java hosting control plane. It uses
Workers, Durable Objects, Containers, the Sandbox SDK, R2, and a single local
CLI named `cubeflare`.

## Current Architecture

- The public app is served from `minecraft.ashishkumarsingh.com`.
- Account, session, and CLI auth state live in SQLite-backed Durable Objects.
- Each Minecraft server maps one-to-one to a `MinecraftSandbox` Durable Object
  and one Sandbox SDK container runtime.
- Server state, world data, plugins, and config are restored from Sandbox SDK
  backups on fresh container start.
- Backups are retained in R2, with the last configured successful backups kept
  per server.
- Players connect through `cubeflare connect`, which opens a local Minecraft
  TCP listener and bridges it to the server's container over an authenticated
  WebSocket path.
- The browser UI is an owner console for create/start/stop/delete, logs,
  terminal, files, plugins, backups, settings, and invite commands.

## Lifecycle Contract

`MinecraftSandbox.onStart()` is the only container-provisioning startup hook. It
restores the latest backup first, then starts the bridge, optional dynmap sync,
and Minecraft process.

Passive dashboard reads must not wake a sleeping sandbox. Active operations such
as `start`, `restore`, `backup`, terminal, file changes, and connector sessions
may touch the sandbox.

The lifecycle alarm follows one rule:

- If there is connector activity, create a backup and touch bridge health so the
  container lifetime is renewed.
- If there is no connector activity, do nothing and let the container sleep
  naturally.

Delete is destructive and intentionally does not create a final backup. It marks
the server as deleting, clears connector activity and alarms, destroys the
sandbox runtime, removes retained backup objects, removes the server from the
owner record, and clears local state.

## CLI Contract

The only supported installed binary is:

```sh
cubeflare
```

The connection command is:

```sh
cubeflare connect <server name>
cubeflare connect <invite-code>
```

There is no separate connector binary or download artifact.

## Deployment Secrets

Cubeflare uses one app root secret:

- `CUBEFLARE_SECRET` derives the password pepper, CLI token key, invite-code
  key, bridge token key, activity token key, and Dynmap sync key.

The current Sandbox SDK backup and restore APIs still require direct R2 S3
credentials for presigned container-to-R2 transfer:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

`CLOUDFLARE_ACCOUNT_ID` and `BACKUP_BUCKET_NAME` identify the backup bucket.
`BACKUP_BUCKET_ENDPOINT` is only needed for jurisdiction-specific R2 buckets.

## Backup Contract

Backups use Minecraft RCON only for filesystem consistency:

1. `save-off`
2. `save-all flush`
3. Sandbox SDK backup creation
4. `save-on`

Backup creation is serialized through one app-level coordinator so manual,
periodic, stop, and restore-related backups cannot race each other.

## Release Verification

Before release, run:

```sh
corepack yarn typecheck
corepack yarn test:unit
corepack yarn build
corepack yarn wrangler deploy
```

After deploy, verify:

```sh
curl -fsS https://minecraft.ashishkumarsingh.com/api/health
curl -fsSL https://minecraft.ashishkumarsingh.com/install.sh | sh
cubeflare help
cubeflare connect --help
```

The Minecraft protocol E2E script exists at
`tests/e2e/minecraft-protocol-smoke.mjs`, but it creates real production
account/server state and should only be run when a cleanup-safe production test
namespace is available.
