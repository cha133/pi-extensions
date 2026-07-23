import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BUN_GUIDANCE = `## Bun scripts

When a task becomes awkward or error-prone in shell, stop extending the shell command and write a script instead.

- Prefer a TypeScript (\`.ts\`) script for non-trivial logic; use JavaScript (\`.js\`) only for a very short script where types add no value.
- Put throwaway scripts in the system temporary directory (\`$env:TEMP\` in PowerShell), not in the project.
- Run them with \`bun run "$env:TEMP\\<name>.ts"\`.
- Keep using shell for simple commands and pipelines; switch to Bun for branching, loops, structured-data processing, or logic that is difficult to quote safely in shell.
`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${BUN_GUIDANCE}`,
	}));
}
