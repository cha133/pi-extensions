import { describe, expect, test } from "bun:test";
import registerShellGuidance, { SHELL_GUIDANCE } from "../extensions/shell-guidance.ts";

describe("shell workflow guidance", () => {
	test("teaches file discovery and content search without depending on fd", () => {
		expect(SHELL_GUIDANCE).toContain("`rg --files` to list files");
		expect(SHELL_GUIDANCE).toContain("`rg --files -g '*.md'`");
		expect(SHELL_GUIDANCE).toContain("`rg -n PATTERN PATH`");
		expect(SHELL_GUIDANCE).toContain("`--hidden`");
		expect(SHELL_GUIDANCE).toContain("`--no-ignore -g '!**/.git/**'`");
		expect(SHELL_GUIDANCE).not.toContain("`fd`");
	});

	test("warns that ripgrep -r replaces matches instead of enabling recursion", () => {
		expect(SHELL_GUIDANCE).toContain("searches directories recursively by default");
		expect(SHELL_GUIDANCE).toContain("`-r` means `--replace`");
	});

	test("teaches when and how to move complex shell logic into a temporary Bun script", () => {
		expect(SHELL_GUIDANCE).toContain("Prefer a TypeScript (`.ts`) script");
		expect(SHELL_GUIDANCE).toContain("`$env:TEMP`");
		expect(SHELL_GUIDANCE).toContain('`bun run "$env:TEMP\\<name>.ts"`');
		expect(SHELL_GUIDANCE).toContain("branching, loops, structured-data processing");
	});

	test("appends its guidance before each agent turn", () => {
		let handler;
		registerShellGuidance({
			on(event, candidate) {
				if (event === "before_agent_start") handler = candidate;
			},
		});

		expect(handler({ systemPrompt: "base" })).toEqual({
			systemPrompt: `base\n\n${SHELL_GUIDANCE}`,
		});
	});
});
