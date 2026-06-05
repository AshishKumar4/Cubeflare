# Cubeflare

Cubeflare is a Cloudflare-native Minecraft Java hosting platform. It runs a
multi-tenant control plane on Cloudflare Workers and Durable Objects, then runs
one Minecraft server per Cloudflare Container through the Cloudflare Sandbox
SDK.

The platform is designed around ephemeral containers: every server restores the
latest backup on fresh container start, backs up periodically while bridge
activity is present, and naturally sleeps when nobody is connected.

## Features

- Account registration, login, sessions, and per-user server ownership through
  SQLite-backed Durable Objects.
- One Minecraft server maps to one `MinecraftSandbox` Durable Object and one
  Sandbox SDK container runtime.
- Presets for Vanilla, Paper, Purpur, Folia, Fabric, and custom launch scripts.
- R2-backed Sandbox SDK backups with retention pruning.
- Server lifecycle controls: create, start/wake, restart, stop, backup, restore,
  and delete.
- Secure CLI bridge for Minecraft Java TCP traffic.
- Owner console for logs, terminal, files, plugins, backups, settings, player
  activity, and Dynmap mirror status.
- Dynmap mirroring to R2 for supported server/plugin combinations.

## Architecture

```text
Browser / CLI
    |
    v
Cloudflare Worker + Hono + Assets
    |
    +-- IdentityRegistryDO: global email, CLI auth, invite code registry
    +-- UserDO: profile, sessions, server summaries
    +-- MinecraftSandbox DO: one Minecraft server and one Sandbox container
            |
            +-- Cloudflare Container: Java server, bridge, Dynmap sync
            +-- R2: backups, plugin uploads, Dynmap mirror
```

Minecraft Java uses TCP, while Workers expose HTTP/WebSocket request handling.
Players connect through `cubeflare connect`, which opens a local TCP listener
and bridges Minecraft traffic to the server container over an authenticated
WebSocket path.

## Requirements

- Cloudflare account with Workers, Durable Objects, R2, and Containers enabled.
- A custom domain routed through Cloudflare.
- Node.js 20 or newer.
- Yarn 4 through Corepack.
- Docker for local container image builds during deployment.

## Quick Start

```sh
corepack enable
yarn install
cp .dev.vars.example .dev.vars
```

Create the required R2 buckets and Worker secrets, then deploy:

```sh
yarn release:check
yarn deploy
```

See [docs/deployment.md](docs/deployment.md) for the full deployment checklist.

## CLI

Install from your deployed Cubeflare origin:

```sh
curl -fsSL https://your-cubeflare-domain.example/install.sh | sh
```

Use an account login:

```sh
cubeflare auth
cubeflare servers
cubeflare connect "Survival world"
```

Or connect with a server invite code:

```sh
cubeflare connect CF-SURVIVAL-WORLD-....
```

The CLI chooses an available local port and prints the Minecraft address to
join. Keep the CLI process open while players are connected.

## Development

```sh
yarn dev
yarn typecheck
yarn test:unit
yarn build
```

The project uses Yarn Plug'n'Play. Generated artifacts such as `.pnp.cjs`,
`dist/`, `.wrangler/`, `node_modules/`, and local Sandbox SDK checkouts are not
part of the repository.

## Release Gate

Before publishing a release:

```sh
yarn release:check
```

For production confidence, also run the protocol smoke test against a cleanup
safe deployment:

```sh
BASE=https://your-cubeflare-domain.example yarn e2e:protocol
```

## License

MIT. See [LICENSE](LICENSE).
