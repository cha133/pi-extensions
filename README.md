# pi-extensions

Personal [pi](https://pi.dev) coding-agent extensions.

| Extension | Tools / behavior |
|-----------|------------------|
| `bash.ts` | **Overrides built-in `bash`** to run PowerShell 7 (`pwsh.exe`); injects `TERM=dumb` so the profile skips interactive init but keeps UTF-8 + mise |
| `edit.ts` | **Overrides built-in `edit`** with multi-strategy fuzzy matching (Exact -> LineTrimmed -> WhitespaceNorm -> IndentFlexible -> EscapeNorm -> BlockAnchor), ported from opencode |
| `codegraph.ts` | `codegraph_explore` - bridges codegraph's MCP tool into a native pi tool (spawns `codegraph serve --mcp`, lazy, once per session) |
| `web-search.ts` | `web_search`, `web_fetch` via Exa public MCP (`https://mcp.exa.ai/mcp`, no API key) |
| `view-image.ts` | `view_image` - MiMo vision for text-only models; hidden when the active model already accepts images |

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
| `bash` | PowerShell 7 at `C:\Program Files\PowerShell\7\pwsh.exe` (edit the path if needed) |
| `edit` | None (no extra runtime deps; reuses pi's `diff` package) |
| `codegraph` | `codegraph` CLI on PATH; a project must be indexed (`codegraph init`) for queries to work |
| `web-search` | Network access to `https://mcp.exa.ai/mcp` |
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
├── extensions/          # one extension per .ts file, loaded by pi (package manifest)
├── package.json         # pi-package manifest + peerDeps (runtime) + devDeps (types/tsc)
├── tsconfig.json        # noEmit; strict; NodeNext; types: ["node"]
├── AGENTS.md            # agent quick-reference (auto-read by coding agents)
└── README.md            # this file
```
