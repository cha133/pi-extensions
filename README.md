# pi-extensions

A collection of [pi](https://pi.dev) coding-agent extensions.

| Extension | Tools / behavior |
|-----------|------------------|
| `bash.ts` | **Overrides built-in `bash`** to run PowerShell 7 (`pwsh.exe`); injects `TERM=dumb` so the profile skips interactive init but keeps UTF-8 + mise |
| `bun.ts` | Adds system-prompt guidance to move non-trivial shell logic into temporary TypeScript/JavaScript scripts run with Bun; registers no tool |
| `edit.ts` | **Overrides built-in `edit`** with multi-strategy fuzzy matching (Exact -> LineTrimmed -> WhitespaceNorm -> IndentFlexible -> EscapeNorm -> PartialLineIndent -> BlockAnchor), ported from opencode and extended for partial-line indentation differences |
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
| `bun` | `bun` on PATH |
| `edit` | None (no extra runtime deps; reuses pi's `diff` package) |
| `codegraph` | `codegraph` CLI on PATH; a project must be indexed (`codegraph init`) for queries to work |
| `web-search` | Network access to `https://mcp.exa.ai/mcp` |
| `view-image` | `MIMO_API_KEY` env var; calls `https://api.xiaomimimo.com/v1` with model `mimo-v2.5` |

## Develop

```bash
npm install --ignore-scripts
npm test
npm run typecheck
```

`devDependencies` exist only for editor types / `tsc`. At runtime pi provides `@earendil-works/pi-*` and `typebox`.

## Layout

```
pi-extensions/
├── extensions/          # one extension per .ts file, loaded by pi (package manifest)
├── tests/               # Bun regression tests
├── package.json         # pi-package manifest + peerDeps (runtime) + devDeps (types/tsc)
├── tsconfig.json        # noEmit; strict; NodeNext; types: ["node"]
├── AGENTS.md            # agent quick-reference (auto-read by coding agents)
└── README.md            # this file
```
