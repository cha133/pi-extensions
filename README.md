# pi-extensions

A collection of [pi](https://pi.dev) coding-agent extensions.

| Extension | Tools / behavior |
|-----------|------------------|
| `bash.ts` | **Overrides built-in `bash`** to run PowerShell 7 (`pwsh.exe`); injects `TERM=dumb` so the profile skips interactive init but keeps UTF-8 + mise |
| `shell-guidance.ts` | Adds system-prompt guidance to use ripgrep for discovery/search and move non-trivial shell logic into temporary Bun scripts; registers no tool |
| `session-info.ts` | Captures the first user message's date/time and selected model, then reuses those fixed values after model switches and resume |
| `edit.ts` | **Overrides built-in `edit`** with multi-strategy fuzzy matching (Exact -> IndentFlexible -> LineTrimmed -> WhitespaceNorm -> EscapeNorm -> PartialLineIndent -> BlockAnchor), plus a matching-aware renderer that avoids the built-in exact preview |
| `read.ts` | **Overrides built-in `read`** while preserving its native behavior; images are automatically routed to the current model or a configured fallback vision model |
| `advisor.ts` | `advisor` - lets the main model explicitly request a tool-free independent review, using either the current model or a configured higher-capability model |
| `codegraph.ts` | `codegraph_explore` - bridges codegraph's MCP tool into a native pi tool (spawns `codegraph serve --mcp`, lazy, once per session) |
| `web-search.ts` | `web_search`, `web_fetch` via Exa public MCP (`https://mcp.exa.ai/mcp`, no API key) |

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
| `rg` | `rg` on PATH |
| `session-info` | None |
| `edit` | None (no extra runtime deps; reuses pi's `diff` package) |
| `read` | A `vision` model configured in `~/.pi/agent/settings.json` for use when the current model cannot consume images |
| `advisor` | None; optionally configure an `advisor` model in `~/.pi/agent/settings.json` |
| `codegraph` | `codegraph` CLI on PATH; a project must be indexed (`codegraph init`) for queries to work |
| `web-search` | Network access to `https://mcp.exa.ai/mcp` |

### Configure image fallback for `read`

Choose any image-capable model already configured in pi and add a `vision`
object to `~/.pi/agent/settings.json`:

```json
{
  "vision": {
    "provider": "google",
    "model": "gemini-2.5-flash"
  }
}
```

The `provider` and `model` values must identify a model available to pi, and
that model must declare `"image"` in its supported inputs. The overridden
`read` tool uses pi's model registry and existing authentication, including built-in providers,
`~/.pi/agent/models.json`, `~/.pi/agent/auth.json`, OAuth, and provider
environment variables. The extension does not store a separate API key.

For text files, and for images when the current model already supports image
input, `read` delegates to pi's native implementation. Otherwise it sends the
native reader's processed image to the configured fallback model and returns
the description. Trusted project settings may override either value with a
`vision` object in `.pi/settings.json`. Settings are read on every fallback
call, so changing the selected model does not require `/reload`. Changes to
pi's model or provider configuration may still require `/reload`.

For targeted image analysis, `read` also accepts an optional `image` object:

```json
{
  "path": "screenshot.png",
  "image": {
    "query": "What does the red error message in the lower-right corner say?",
    "detail": "detailed"
  }
}
```

`query` is a natural-language question or instruction, `detail` is `brief`,
`standard`, or `detailed`. Areas to prioritize should be expressed directly in
`query`. When the current model supports images, pi's native image result is
left untouched and these arguments remain visible in the tool call context. For
text-only current models, the extension sends them to the configured fallback
vision model.

### Configure `advisor`

The `advisor` tool is called explicitly by the main model when a difficult
judgment, material uncertainty, or important draft would benefit from an
independent review. It is not an automatic hook. The main model sends a focused
question, relevant context, and optionally a proposed answer; the advisor has no
tools and receives no other conversation or project state.

With no additional settings, `advisor` uses the current model with an
independent second-pass prompt. To select a different model, add an `advisor`
object to `~/.pi/agent/settings.json`:

```json
{
  "advisor": {
    "provider": "anthropic",
    "model": "claude-opus-4-6"
  }
}
```

A configured model must already be available to pi. Existing model registry and
authentication settings are reused; the extension stores no API key. When the
configured provider and model differ from the current model, the extension
treats that model as a user-selected higher-capability advisor and uses a
different system prompt. Trusted project settings may override either field
with an `advisor` object in `.pi/settings.json`.

The advisor returns either `ANSWER` with its conclusion first, or
`NEED_MORE_INFO` with the minimum concrete evidence the main model should
collect. It inherits the current pi thinking level and does not impose a custom
generation-token cap. The final visible result is truncated to 2,000 lines or
50 KB before being returned to the main model.

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
