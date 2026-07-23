# AGENTS.md

Personal [pi](https://pi.dev) coding-agent extension package. Auto-discovered as a
pi package; each file in `extensions/` is a self-contained extension.

This file is a quick-reference for any agent (or human) working in this repo. For
the human-facing overview see `README.md`; for exact behavior read the source.

## Layout

```
extensions/        # one extension per .ts file, default-exported factory (pi: ExtensionAPI) => void
  bash.ts          # overrides built-in `bash` -> runs PowerShell 7 (pwsh.exe)
  edit.ts          # overrides built-in `edit` -> multi-strategy fuzzy matching
  codegraph.ts     # bridges codegraph's codegraph_explore MCP tool into a native pi tool
  web-search.ts    # web_search + web_fetch via Exa public MCP (no API key)
  view-image.ts    # view_image: vision for text-only models (hidden when model already reads images)
package.json       # pi-package manifest + peerDeps (runtime) + devDeps (types/tsc only)
tsconfig.json      # noEmit; strict; NodeNext; types: ["node"]
```

## Tools provided

| Tool | File | Notes |
|------|------|-------|
| `bash` | bash.ts | **Overrides built-in.** Runs `C:\Program Files\PowerShell\7\pwsh.exe` with `TERM=dumb` injected so the profile skips interactive init (starship/PSReadLine/zoxide) but keeps UTF-8 + mise. Reuses the built-in bash execute/stream/truncate/timeout/kill via `createBashTool`. |
| `edit` | edit.ts | **Overrides built-in.** Multi-strategy fuzzy match (Exact → LineTrimmed → WhitespaceNorm → IndentFlexible → EscapeNorm → BlockAnchor) ported from opencode. Same edits[] semantics: one-pass on original content, each `oldText` unique, no overlap, preserves BOM + EOL. |
| `codegraph_explore` | codegraph.ts | Spawns `codegraph serve --mcp` (lazy, once per session), newline-delimited JSON-RPC 2.0. Always visible (no `.codegraph/` gating). Agent passes `projectPath` per call. |
| `web_search` | web-search.ts | Exa public MCP (`https://mcp.exa.ai/mcp`), SSE transport parsed manually, zero deps. |
| `web_fetch` | web-search.ts | Same Exa MCP, fetches URL bodies. Call after `web_search`. |
| `view_image` | view-image.ts | MiMo vision API (`MIMO_API_KEY`). Hidden when active model already accepts `image` input. |

## Conventions

- **File naming**: multi-word concepts are hyphenated (`web-search.ts`, `view-image.ts`);
  single concepts are bare (`bash.ts`, `edit.ts`, `codegraph.ts`). "Web search" is two
  words -- never write `websearch`.
- **Tool names**: lowercase + underscore (`web_search`, `view_image`, `codegraph_explore`).
  Don't prefix provider names (`exa_` was dropped; the provider is an impl detail).
- **Override built-ins** by registering a tool with the same `name` (e.g. `bash`, `edit`).
  The TUI shows an override warning; that's expected.
- **One extension per file**, `export default function (pi: ExtensionAPI) { ... }`. Use
  `pi.registerTool({ name, label, description, parameters: Type.Object({...}), ... })`.
- **Parameter schemas**: TypeBox (`Type.Object`/`Type.String`/...). Never `zod`.
- **Truncation**: reuse `truncateHead` from `@earendil-works/pi-coding-agent` for any
  tool output; cap at 2000 lines / 50KB (see `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`).
- **Types**: `strict` mode. `result.details` from `registerTool` defaults to `unknown` --
  when reading custom fields in `renderResult`, define a local interface and cast
  `result.details as Foo | undefined` (see `web-search.ts` `SearchDetails`, `view-image.ts`
  `ViewImageDetails`). Don't rely on inference to `{}`/`unknown`.
- **Runtime deps**: none beyond pi's peer deps + `typebox`. `@types/node` and `typescript`
  are `devDependencies` only (editor types / `tsc`); at runtime pi provides
  `@earendil-works/pi-*` and `typebox`. Keep extensions single-file and zero added deps.

## Develop

```bash
npm install --ignore-scripts
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

- Commit author: `cha133 <cha133@vip.qq.com>` (set in this repo's `.git/config`,
  overrides the global config). Use `git commit --author="cha133 <cha133@vip.qq.com>"`
  if authoring from a context where committer differs.
- Commit messages: imperative mood, subject <= ~72 chars, blank line, bullet body.
- Line endings: repo is LF; git may warn about LF→CRLF on Windows -- safe to ignore.

## Platform

Targets **Windows + PowerShell 7**. `bash.ts` hard-codes the pwsh path
(`C:\Program Files\PowerShell\7\pwsh.exe`) and `edit.ts`/`codegraph.ts` are
cross-platform but untested elsewhere. Don't "fix" pwsh-isms to sh/bash.
