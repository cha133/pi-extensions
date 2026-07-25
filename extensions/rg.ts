/**
 * Ripgrep guidance -- teach the agent to use rg for file discovery and content
 * search, including hidden and ignored files and the -r replacement trap.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RG_GUIDANCE = `## Ripgrep

Prefer \`rg\` for file discovery and content search.

- Use \`rg --files\` to list files and \`rg --files -g '*.md'\` to filter by glob.
- Use \`rg -n PATTERN PATH\` to search content. Ripgrep searches directories recursively by default.
- Never use grep-style \`rg -r\` or \`rg -rn\`: in ripgrep, \`-r\` means \`--replace\`.
- Add \`--hidden\` to include hidden files while respecting ignore files.
- Add \`--no-ignore -g '!**/.git/**'\` only when ignored files are also required.
`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${RG_GUIDANCE}`,
	}));
}
