# OpenClaw Time Travel

Local OpenClaw plugin that:

- stamps assistant replies with a rewind tag such as `#tt-ab12cd34ef`
- stores transcript snapshots for each tagged assistant reply
- keeps a shadow git repository for tracked workspace markdown files
- restores the current session and tracked markdown state with `/rewind <tag>`

## Tracked Files

V1 tracks only the standard workspace markdown set plus `memory/**/*.md`:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `IDENTITY.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `BOOT.md`
- `BOOTSTRAP.md`
- `MEMORY.md`
- `memory/**/*.md`

## Local Setup

This checkout expects OpenClaw to be installed globally via npm.

1. Link the global `openclaw` package into this plugin checkout:

```bash
node ./scripts/link-openclaw.mjs
```

2. Optional smoke check:

```bash
node ./scripts/smoke-import.mjs
```

3. Install the plugin into OpenClaw from this path:

```bash
openclaw plugins install /home/ubuntu/workspace/agent/openclaw-agent-time-travel
```

4. Enable internal hooks in your OpenClaw config:

```json5
{
  hooks: {
    internal: {
      enabled: true
    }
  }
}
```

## Commands

- `/versions [n]`
- `/rewind <tag>`

