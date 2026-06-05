# Security Policy

Cubeflare is infrastructure for running persistent Minecraft servers on
ephemeral Cloudflare Containers. Security issues in authentication, server
ownership, invite codes, backup/restore, file access, terminal access, or the
CLI bridge should be treated as high priority.

## Reporting

For a public repository, configure a private security advisory channel before
launch and list it here. Until then, do not publish exploitable details in
issues or pull requests.

## Supported Versions

Only the current `main` branch is supported before a tagged release exists.

## Security Model

- `CUBEFLARE_SECRET` is the root application secret. The Worker derives
  purpose-specific keys for password hashing, CLI auth, invite codes, bridge
  tokens, activity heartbeats, and Dynmap sync.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are required by the current
  Sandbox SDK backup/restore transport and must be scoped to the backup bucket
  wherever possible.
- Server invite codes authorize bridge sessions only. They do not create or
  grant account sessions.
- Passive dashboard reads should not wake sleeping containers.
- RCON is reserved for Minecraft consistency operations, especially backup
  `save-off`, `save-all flush`, and `save-on`.

## Release Checks

Before deploying or publishing:

```sh
yarn release:check
```

For production releases, also run a cleanup-safe end-to-end connector smoke
test.
