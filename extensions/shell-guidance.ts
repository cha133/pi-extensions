/**
 * Shell workflow guidance -- teach the agent to use ripgrep for file discovery
 * and content search, and to move non-trivial shell logic into temporary Bun
 * scripts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SHELL_GUIDANCE = `## Shell workflow

### Search with ripgrep

Prefer \`rg\` for file discovery and content search.

- Use \`rg --files\` to list files and \`rg --files -g '*.md'\` to filter by glob.
- Use \`rg -n PATTERN PATH\` to search content. Ripgrep searches directories recursively by default.
- Never use grep-style \`rg -r\` or \`rg -rn\`: in ripgrep, \`-r\` means \`--replace\`.
- Add \`--hidden\` to include hidden files while respecting ignore files.
- Add \`--no-ignore -g '!**/.git/**'\` only when ignored files are also required.

### Script complex logic with Bun

When a task becomes awkward or error-prone in shell, stop extending the shell command and write a script instead.

- Prefer a TypeScript (\`.ts\`) script for non-trivial logic; use JavaScript (\`.js\`) only for a very short script where types add no value.
- Put throwaway scripts in the system temporary directory (\`$env:TEMP\` in PowerShell), not in the project.
- Run them with \`bun run "$env:TEMP\\<name>.ts"\`.
- Keep using shell for simple commands and pipelines; switch to Bun for branching, loops, structured-data processing, or logic that is difficult to quote safely in shell.
`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${SHELL_GUIDANCE}`,
	}));
}
