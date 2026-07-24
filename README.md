# pi-extensions

A collection of [pi](https://pi.dev) coding-agent extensions.

| Extension | Tools / behavior |
|-----------|------------------|
| `bash.ts` | **Overrides built-in `bash`** to run PowerShell 7 (`pwsh.exe`); injects `TERM=dumb` so the profile skips interactive init but keeps UTF-8 + mise |
| `bun.ts` | Adds system-prompt guidance to move non-trivial shell logic into temporary TypeScript/JavaScript scripts run with Bun; registers no tool |
| `edit.ts` | **Overrides built-in `edit`** with multi-strategy fuzzy matching (Exact -> LineTrimmed -> WhitespaceNorm -> IndentFlexible -> EscapeNorm -> PartialLineIndent -> BlockAnchor), plus a matching-aware renderer that avoids the built-in exact preview |
| `codegraph.ts` | `codegraph_explore` - bridges codegraph's MCP tool into a native pi tool (spawns `codegraph serve --mcp`, lazy, once per session) |
| `web-search.ts` | `web_search`, `web_fetch` via Exa public MCP (`https://mcp.exa.ai/mcp`, no API key) |
| `view-image.ts` | `view_image` - configurable vision model for text-only models; hidden when the active model already accepts images |

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
| `view-image` | `~/.pi/agent/view-image.json` containing a configured pi model, for example `{"provider":"google","model":"gemini-2.5-flash"}` |

### Configure `view-image`

Choose any image-capable model already configured in pi and create
`~/.pi/agent/view-image.json`:

```json
{
  "provider": "google",
  "model": "gemini-2.5-flash"
}
```

The `provider` and `model` values must identify a model available to pi, and
that model must declare `"image"` in its supported inputs. `view_image` uses
pi's model registry and existing authentication, including built-in providers,
`~/.pi/agent/models.json`, `~/.pi/agent/auth.json`, OAuth, and provider
environment variables. The extension does not store a separate API key.

The configuration file is read on every `view_image` call, so changing the
selected model does not require `/reload`. Changes to pi's model or provider
configuration may still require `/reload`.

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
