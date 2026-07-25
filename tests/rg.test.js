import { describe, expect, test } from "bun:test";
import registerRg, { RG_GUIDANCE } from "../extensions/rg.ts";

describe("ripgrep guidance", () => {
	test("teaches file discovery and content search without depending on fd", () => {
		expect(RG_GUIDANCE).toContain("`rg --files` to list files");
		expect(RG_GUIDANCE).toContain("`rg --files -g '*.md'`");
		expect(RG_GUIDANCE).toContain("`rg -n PATTERN PATH`");
		expect(RG_GUIDANCE).toContain("`--hidden`");
		expect(RG_GUIDANCE).toContain("`--no-ignore -g '!**/.git/**'`");
		expect(RG_GUIDANCE).not.toContain("`fd`");
	});

	test("warns that ripgrep -r replaces matches instead of enabling recursion", () => {
		expect(RG_GUIDANCE).toContain("searches directories recursively by default");
		expect(RG_GUIDANCE).toContain("`-r` means `--replace`");
	});

	test("appends its guidance before each agent turn", () => {
		let handler;
		registerRg({
			on(event, candidate) {
				if (event === "before_agent_start") handler = candidate;
			},
		});

		expect(handler({ systemPrompt: "base" })).toEqual({
			systemPrompt: `base\n\n${RG_GUIDANCE}`,
		});
	});
});
