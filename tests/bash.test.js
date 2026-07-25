import { describe, expect, test } from "bun:test";
import {
	BASH_PROMPT_GUIDELINES,
	mergeBashPromptGuidelines,
	registerBash,
	resolvePwshPath,
} from "../extensions/bash.ts";

describe("pwsh path resolution", () => {
	test("prefers the first pwsh.exe found on PATH", () => {
		const expected = "C:\\Tools\\PowerShell\\pwsh.exe";
		const result = resolvePwshPath(
			{ Path: '"C:\\Missing";C:\\Tools\\PowerShell;C:\\Later' },
			(path) => path === expected,
		);

		expect(result).toBe(expected);
	});

	test.each([
		[
			"MSI",
			{ ProgramFiles: "C:\\Program Files" },
			"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
		],
		[
			"Store or WinGet MSIX alias",
			{ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
			"C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe",
		],
		["custom Scoop", { SCOOP: "D:\\Scoop" }, "D:\\Scoop\\shims\\pwsh.exe"],
		[
			"default Scoop",
			{ USERPROFILE: "C:\\Users\\me" },
			"C:\\Users\\me\\scoop\\shims\\pwsh.exe",
		],
	])("falls back to the %s installation location", (_name, environment, expected) => {
		expect(resolvePwshPath(environment, (path) => path === expected)).toBe(expected);
	});

	test("returns undefined when pwsh.exe is unavailable", () => {
		expect(resolvePwshPath({}, () => false)).toBeUndefined();
	});
});

describe("bash platform registration", () => {
	test("keeps its prompt guidance specific to PowerShell", () => {
		const guidance = BASH_PROMPT_GUIDELINES.join("\n");

		expect(guidance).toContain("The bash tool runs PowerShell 7, not bash/sh.");
		expect(guidance).toContain("PowerShell pipelines pass objects rather than text.");
		expect(guidance).toContain("real multiline here-string");
		expect(guidance).not.toContain("ripgrep");
		expect(guidance).not.toContain("`rg");
	});

	test("preserves built-in non-shell guidance before PowerShell guidance", () => {
		const inherited = "Inspect PI_* environment variables for current model and session details.";
		const guidance = mergeBashPromptGuidelines([inherited]);

		expect(guidance[0]).toBe(inherited);
		expect(guidance.slice(1)).toEqual(BASH_PROMPT_GUIDELINES);
		expect(mergeBashPromptGuidelines(undefined)).toEqual(BASH_PROMPT_GUIDELINES);
	});

	test("does not register on macOS or Linux", () => {
		const events = [];
		const pi = {
			on(event) {
				events.push(event);
			},
		};

		registerBash(pi, "darwin");
		registerBash(pi, "linux");

		expect(events).toEqual([]);
	});

	test("registers the session hook on Windows", () => {
		const events = [];
		const pi = {
			on(event) {
				events.push(event);
			},
		};

		registerBash(pi, "win32");

		expect(events).toEqual(["session_start"]);
	});
});
