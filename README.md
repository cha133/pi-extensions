# pi-extensions

Personal [pi](https://pi.dev) coding-agent extensions.

| Extension | Tools / behavior |
|-----------|------------------|
| `exa-websearch.ts` | `exa_web_search`, `exa_web_fetch` via Exa public MCP (no API key) |
| `pwsh-bash.ts` | Overrides built-in `bash` to run PowerShell 7 |
| `view-image.ts` | `view_image` — MiMo vision for text-only models; hidden when the active model already accepts images |

## Install

```bash
pi install git:github.com/cha133/pi-extensions
# or local path
pi install /absolute/path/to/pi-extensions
```

Or copy files from `extensions/` into `~/.pi/agent/extensions/` for auto-discovery and `/reload`.

## Requirements

| Extension | Notes |
|-----------|--------|
| `exa-websearch` | Network access to `https://mcp.exa.ai/mcp` |
| `pwsh-bash` | PowerShell 7 at `C:\Program Files\PowerShell\7\pwsh.exe` (edit the path if needed) |
| `view-image` | `MIMO_API_KEY` env var; calls `https://api.xiaomimimo.com/v1` with model `mimo-v2.5` |

## Develop

```bash
npm install --ignore-scripts
npm run typecheck
```

`devDependencies` exist only for editor types / `tsc`. At runtime pi provides `@earendil-works/pi-*` and `typebox`.

## Layout

```
pi-extensions/
├── extensions/          # loaded by pi (package manifest)
├── package.json         # pi-package + peerDeps
├── tsconfig.json
└── README.md
```
