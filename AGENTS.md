# AGENTS.md

A [pi](https://pi.dev) coding-agent extension package. Auto-discovered as a pi
package; each file in `extensions/` is a self-contained extension.

This file is a quick-reference for any agent (or human) working in this repo. For
the human-facing overview see `README.md`; for exact behavior read the source.

## Layout

```
extensions/        # one extension per .ts file, default-exported factory (pi: ExtensionAPI) => void
  bash.ts          # overrides built-in `bash` -> runs PowerShell 7 (pwsh.exe)
  bun.ts           # adds guidance to use temp Bun scripts for non-trivial shell logic
  datetime.ts      # persists and injects a fixed session-start date/time
  edit.ts          # overrides built-in `edit` -> multi-strategy fuzzy matching
  read.ts          # overrides built-in `read` -> native behavior + automatic vision fallback
  codegraph.ts     # bridges codegraph's codegraph_explore MCP tool into a native pi tool
  web-search.ts    # web_search + web_fetch via Exa public MCP (no API key)
package.json       # pi-package manifest + peerDeps (runtime) + devDeps (types/tsc only)
tsconfig.json      # noEmit; strict; NodeNext; types: ["node"]
```

## Tools provided

| Tool | File | Notes |
|------|------|-------|
| `bash` | bash.ts | **Overrides built-in.** Runs `C:\Program Files\PowerShell\7\pwsh.exe` with `TERM=dumb` injected so the profile skips interactive init (starship/PSReadLine/zoxide) but keeps UTF-8 + mise. Reuses the built-in bash execute/stream/truncate/timeout/kill via `createBashTool`. |
| _(none)_ | bun.ts | Adds system-prompt guidance via `before_agent_start`: move non-trivial shell logic into a temporary TypeScript/JavaScript script under `$env:TEMP`, then run it with `bun run`. |
| _(none)_ | datetime.ts | Persists the session-start date/time in a custom session entry and appends the same value to the system prompt on every turn and resume. |
| `edit` | edit.ts | **Overrides built-in.** Single `oldText` → `newText` replacement per call, with multi-strategy fuzzy matching (Exact → IndentFlexible → LineTrimmed → WhitespaceNorm → EscapeNorm → PartialLineIndent → BlockAnchor). Owns its renderer so pi does not run the built-in exact-match preview against fuzzy arguments. Separate calls run sequentially; preserves BOM + EOL. |
| `read` | read.ts | **Overrides built-in.** Wraps `createReadToolDefinition` so native text/image handling and rendering remain intact. When the current model cannot consume the native image result, routes it through the `vision` model selected in `~/.pi/agent/settings.json`. Optional `image.query` and `image.detail` parameters guide targeted fallback analysis without modifying native multimodal results. |
| `codegraph_explore` | codegraph.ts | Spawns `codegraph serve --mcp` (lazy, once per session), newline-delimited JSON-RPC 2.0. Always visible (no `.codegraph/` gating). Agent passes `projectPath` per call. |
| `web_search` | web-search.ts | Exa public MCP (`https://mcp.exa.ai/mcp`), SSE transport parsed manually, zero deps. |
| `web_fetch` | web-search.ts | Same Exa MCP, fetches URL bodies. Call after `web_search`. |

## Conventions

- **File naming**: multi-word concepts are hyphenated (`web-search.ts`);
  single concepts are bare (`bash.ts`, `edit.ts`, `codegraph.ts`). "Web search" is two
  words -- never write `websearch`.
- **Tool names**: lowercase + underscore (`web_search`, `codegraph_explore`).
  Don't prefix provider names (`exa_` was dropped; the provider is an impl detail).
- **Override built-ins** by registering a tool with the same `name` (e.g. `bash`, `edit`).
  The TUI shows an override warning; that's expected.
- **One extension per file**, `export default function (pi: ExtensionAPI) { ... }`. Use
  `pi.registerTool({ name, label, description, parameters: Type.Object({...}), ... })`.
- **Module comments**: start every extension file with a JSDoc comment that summarizes
  the extension's purpose and important implementation behavior, before all imports.
  Keep function-level JSDoc for details specific to that function.
- **Parameter schemas**: TypeBox (`Type.Object`/`Type.String`/...). Never `zod`.
- **Truncation**: reuse `truncateHead` from `@earendil-works/pi-coding-agent` for any
  tool output; cap at 2000 lines / 50KB (see `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`).
- **Types**: `strict` mode. `result.details` from `registerTool` defaults to `unknown` --
  when reading custom fields in `renderResult`, define a local interface and cast
  `result.details as Foo | undefined` (see `web-search.ts` `SearchDetails`). Don't rely
  on inference to `{}`/`unknown`.
- **Runtime deps**: none beyond pi's peer deps + `typebox`. `@types/node` and `typescript`
  are `devDependencies` only (editor types / `tsc`); at runtime pi provides
  `@earendil-works/pi-*` and `typebox`. Keep extensions single-file and zero added deps.

## Develop

```bash
npm install --ignore-scripts
npm test               # Bun regression tests
npm run typecheck      # tsc --noEmit; must pass before commit
```

`moduleResolution: "NodeNext"` means `node:` protocol imports work and `@types/node`
must be resolvable. `tsconfig` has `"types": ["node"]` so VS Code's TS server finds
it reliably (without it, editors may show `ts(2591)` on `node:fs/promises` even though
`tsc` passes).

If VS Code shows stale type errors after dependency changes:
1. Command palette → `TypeScript: Restart TS Server`
2. Command palette → `TypeScript: Select TypeScript Version` → Use Workspace Version

## Git

- Historical commits do not consistently follow [Conventional Commits
  1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), but all future
  commits must. Use the specification's `<type>[optional scope]: <description>`
  format (for example, `feat: add image fallback`, `fix(edit): preserve BOM`,
  or `chore: update dependencies`) and follow its rules for bodies, footers,
  and breaking changes.
- Line endings: repo is LF; git may warn about LF→CRLF on Windows -- safe to ignore.

## Platform

Targets **Windows + PowerShell 7**. `bash.ts` hard-codes the pwsh path
(`C:\Program Files\PowerShell\7\pwsh.exe`) and `edit.ts`/`codegraph.ts` are
cross-platform but untested elsewhere. Don't "fix" pwsh-isms to sh/bash.
