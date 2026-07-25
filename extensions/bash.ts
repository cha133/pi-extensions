/**
 * PowerShell bash -- override the built-in bash tool with PowerShell 7.
 *
 * shellPath points to pwsh7. Once overridden, the built-in settings lookup no longer
 * supplies shellPath, so it must be passed explicitly.
 *
 * spawnHook injects TERM=dumb:
 * 1. The guard at the top of $profile, `if ($env:TERM -eq 'dumb') { return }`, exits
 *    early. This skips interactive setup such as starship, PSReadLine, and zoxide
 *    while retaining UTF-8 configuration and mise activation.
 * 2. Tools such as git and eza detect a dumb terminal and omit ANSI escape sequences.
 *
 * promptGuidelines preserve the built-in non-shell guidance, then remind the model to
 * write PowerShell 7 rather than bash syntax. Everything else (execution, 50 KB/2,000-line
 * truncation, stream throttling, TUI rendering, timeouts, and process-tree termination)
 * reuses the built-in implementation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

type FileExists = (path: string) => boolean;

export const BASH_PROMPT_GUIDELINES = [
	[
		"The bash tool runs PowerShell 7, not bash/sh.",
		"Set environment variables with `$env:NAME = 'x'`, test paths with `Test-Path`,",
		"and invoke quoted executable paths with",
		"`& 'C:\\path\\app.exe' arg`.",
		"Prefer single quotes for literal arguments;",
		"in double-quoted strings, PowerShell uses the backtick, not `\\`, for escaping.",
		"Prefer natural multiline syntax over fragile backtick line continuations.",
	].join(" "),
	[
		"Limit pipeline output with `Select-Object -First N` or `-Last N`,",
		"and locate commands with `(Get-Command name).Source`.",
		"PowerShell pipelines pass objects rather than text.",
	].join(" "),
	[
		"For multiline native arguments, use a real multiline here-string:",
		"`@'` followed by a newline, the content, another newline, then `'@`.",
		"The opening marker must end its line;",
		"the closing marker must be alone at the start of a line.",
	].join(" "),
	[
		"Do not build a complete command string and pass it to `Invoke-Expression`;",
		"invoke the executable directly and pass arguments separately.",
		"Follow a script's required interpreter or shebang",
		"instead of choosing from its file extension alone.",
	].join(" "),
];

/** Preserve guidance supplied by pi's bash tool before adding PowerShell-specific rules. */
export function mergeBashPromptGuidelines(baseGuidelines: readonly string[] | undefined): string[] {
	return [...(baseGuidelines ?? []), ...BASH_PROMPT_GUIDELINES];
}

function getEnv(environment: NodeJS.ProcessEnv, name: string): string | undefined {
	const match = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
	return match ? environment[match] : undefined;
}

/**
 * Resolve pwsh.exe to an absolute path because createBashTool requires shellPath
 * to pass existsSync. PATH covers normal MSI, MSIX/Store/WinGet aliases, Scoop
 * shims, ZIP installs, and .NET tools. Known install roots handle stale PATHs.
 */
export function resolvePwshPath(
	environment: NodeJS.ProcessEnv = process.env,
	fileExists: FileExists = existsSync,
): string | undefined {
	const candidates: string[] = [];
	const pathValue = getEnv(environment, "PATH");

	if (pathValue) {
		for (const entry of pathValue.split(";")) {
			const directory = entry.trim().replace(/^"(.*)"$/, "$1");
			if (directory) candidates.push(win32.join(directory, "pwsh.exe"));
		}
	}

	const addKnownPath = (rootName: string, ...segments: string[]) => {
		const root = getEnv(environment, rootName);
		if (root) candidates.push(win32.join(root, ...segments));
	};

	addKnownPath("ProgramFiles", "PowerShell", "7", "pwsh.exe");
	addKnownPath("LOCALAPPDATA", "Microsoft", "WindowsApps", "pwsh.exe");
	addKnownPath("LOCALAPPDATA", "Microsoft", "WinGet", "Links", "pwsh.exe");
	addKnownPath("SCOOP", "shims", "pwsh.exe");
	addKnownPath("USERPROFILE", "scoop", "shims", "pwsh.exe");
	addKnownPath("SCOOP_GLOBAL", "shims", "pwsh.exe");
	addKnownPath("ProgramData", "scoop", "shims", "pwsh.exe");

	const seen = new Set<string>();
	return candidates.find((candidate) => {
		const normalized = win32.normalize(candidate);
		const key = normalized.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return fileExists(normalized);
	});
}

export function registerBash(pi: ExtensionAPI, platform: NodeJS.Platform = process.platform) {
	if (platform !== "win32") return;

	pi.on("session_start", async (_event, ctx) => {
		const pwshPath = resolvePwshPath();
		if (!pwshPath) {
			throw new Error(
				"PowerShell 7 (pwsh.exe) was not found. Install it or add its installation directory to PATH.",
			);
		}

		const base = createBashTool(ctx.cwd, {
			shellPath: pwshPath,
			spawnHook: ({ command, cwd, env }) => ({
				command,
				cwd,
				env: { ...env, TERM: "dumb" },
			}),
		});
		const basePromptGuidelines = (
			base as typeof base & { promptGuidelines?: readonly string[] }
		).promptGuidelines;

		pi.registerTool({
			...base,
			name: "bash", // Registering the same name overrides the built-in tool; the TUI warns about it.
			description:
				"Run a PowerShell 7 (pwsh) command in the current working directory and return stdout and stderr. " +
				"Output is truncated to the last 2,000 lines or 50 KB; overflow is saved to a temporary file whose path is included in the result. " +
				"An optional timeout may be provided in seconds. TERM=dumb is injected, $profile loads automatically, and mise plus UTF-8 support are ready.",
			promptSnippet: "Run PowerShell 7 commands",
			promptGuidelines: mergeBashPromptGuidelines(basePromptGuidelines),
		});
	});
}

export default function (pi: ExtensionAPI) {
	registerBash(pi);
}
