import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerRead, {
	buildVisionPrompt,
	computeHashlineTag,
	formatHashlineRead,
	needsVisionFallback,
	resolveVisionConfig,
	restoreHashlineState,
} from "../extensions/read.ts";
import { computeHashlineTag as computeEditHashlineTag } from "../extensions/edit.ts";
import {
	coversHashlineRange,
	getHashlineCoverage,
} from "../extensions/lib/hashline-state.ts";

describe("read hashline formatting", () => {
	test("uses the same normalized tag as edit", () => {
		const content = "\uFEFFalpha\r\nbeta\r\n";
		expect(computeHashlineTag(content)).toBe(computeEditHashlineTag(content));
	});

	test("emits a versioned header and one-indexed source lines", () => {
		const content = "alpha\nbeta\ngamma\n";
		const output = formatHashlineRead(content, { path: "src/example.ts" });

		expect(output).toBe(
			`[src/example.ts#${computeHashlineTag(content)}]\n1:alpha\n2:beta\n3:gamma`,
		);
	});

	test("keeps original numbers for offset reads and reports continuation", () => {
		const output = formatHashlineRead("one\ntwo\nthree\nfour\n", {
			path: "x.txt",
			offset: 2,
			limit: 2,
		});

		expect(output).toContain("\n2:two\n3:three\n");
		expect(output).toContain("1 more lines in file. Use offset=4");
	});

	test("does not expose a phantom line for a final newline", () => {
		const output = formatHashlineRead("one\n", { path: "x.txt" });
		expect(output).toContain("\n1:one");
		expect(output).not.toContain("\n2:");
	});

	test("gives an insertion instruction for an empty file", () => {
		const output = formatHashlineRead("", { path: "empty.txt" });
		expect(output).toContain("[empty.txt#");
		expect(output).toContain("File is empty");
		expect(output).toContain("INS.HEAD");
	});
});

describe("read vision settings", () => {
	test("reads a provider and model from the vision object", () => {
		expect(resolveVisionConfig({ provider: "wps", model: "kimi" }, undefined)).toEqual({
			provider: "wps",
			model: "kimi",
		});
	});

	test("merges trusted project vision fields over global settings", () => {
		expect(
			resolveVisionConfig(
				{ provider: "wps", model: "global-model" },
				{ model: "project-model" },
			),
		).toEqual({
			provider: "wps",
			model: "project-model",
		});
	});

	test("rejects missing or malformed vision settings", () => {
		expect(() => resolveVisionConfig(undefined, undefined)).toThrow("Vision fallback is not configured");
		expect(() => resolveVisionConfig("wps/kimi", undefined)).toThrow('must be a JSON object');
		expect(() => resolveVisionConfig({ provider: "wps" }, undefined)).toThrow(
			'must contain a non-empty string "model"',
		);
	});
});

describe("read vision fallback routing", () => {
	const textResult = {
		content: [{ type: "text", text: "hello" }],
	};
	const imageResult = {
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "abc", mimeType: "image/png" },
		],
	};

	test("keeps native text reads on the native path", () => {
		expect(needsVisionFallback(textResult, { input: ["text"] })).toBe(false);
	});

	test("keeps image reads on the native path for vision models", () => {
		expect(needsVisionFallback(imageResult, { input: ["text", "image"] })).toBe(false);
	});

	test("uses fallback when a text-only model receives an image", () => {
		expect(needsVisionFallback(imageResult, { input: ["text"] })).toBe(true);
		expect(needsVisionFallback(imageResult, undefined)).toBe(true);
	});
});

describe("read image query prompts", () => {
	test("uses a general description when no image query is provided", () => {
		expect(buildVisionPrompt(undefined)).toBe("Describe this image accurately.");
	});

	test("preserves natural-language queries", () => {
		expect(buildVisionPrompt({ query: "Transcribe the dialog exactly." })).toBe(
			"Transcribe the dialog exactly.",
		);
	});

	test("keeps regions inside the natural-language query", () => {
		expect(buildVisionPrompt({ query: "What does the lower-right error say?" })).toBe(
			"What does the lower-right error say?",
		);
	});
});

describe("read override registration", () => {
	test("replaces read with one truthful, always-visible tool", async () => {
		let sessionStart;
		let registered;
		const pi = {
			on(event, handler) {
				if (event === "session_start") sessionStart = handler;
			},
			registerTool(tool) {
				registered = tool;
			},
		};

		registerRead(pi);
		await sessionStart({}, {
			cwd: "C:\\workspace",
			isProjectTrusted: () => false,
			sessionManager: {
				getBranch: () => [],
				getSessionId: () => "registration-test-session",
			},
		});

		expect(registered.name).toBe("read");
		expect(registered.promptSnippet).toContain("version-tagged text snapshots");
		expect(registered.promptGuidelines.join("\n")).toContain("[PATH#TAG]");
		expect(registered.promptGuidelines.join("\n")).toContain("Do not look for or call a separate image-viewing tool");
		expect(registered.parameters.properties.image.properties).toHaveProperty("query");
		expect(registered.parameters.properties.image.properties).toHaveProperty("detail");
		expect(registered.parameters.properties.image.properties).not.toHaveProperty("region");
	});

	test("returns an editable hashline snapshot through the real native read path", async () => {
		let sessionStart;
		let registered;
		const pi = {
			on(event, handler) {
				if (event === "session_start") sessionStart = handler;
			},
			registerTool(tool) {
				registered = tool;
			},
		};
		const directory = await mkdtemp(join(tmpdir(), "pi-hashline-read-"));
		const path = join(directory, "example.txt");
		await writeFile(path, "alpha\r\nbeta\r\n", "utf8");

		try {
			registerRead(pi);
			await sessionStart({}, {
				cwd: directory,
				isProjectTrusted: () => false,
				sessionManager: {
					getBranch: () => [],
					getSessionId: () => "read-test-session",
				},
			});
			const result = await registered.execute(
				"tool-call",
				{ path: "example.txt" },
				undefined,
				undefined,
				{
					cwd: directory,
					model: { input: ["text"] },
					sessionManager: { getSessionId: () => "read-test-session" },
				},
			);

			expect(result.content[0].text).toBe(
				`[example.txt#${computeHashlineTag("alpha\nbeta\n")}]\n1:alpha\n2:beta`,
			);
			const coverage = getHashlineCoverage(
				"read-test-session",
				path,
				computeHashlineTag("alpha\nbeta\n"),
			);
			expect(coverage).toBeDefined();
			expect(coversHashlineRange(coverage, 1, 2)).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("hashline resume restoration", () => {
	test("rebuilds partial read coverage from the active session branch", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-hashline-resume-read-"));
		const path = join(directory, "example.txt");
		const content = "one\ntwo\nthree\n";
		await writeFile(path, content, "utf8");
		const tag = computeHashlineTag(content);
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					toolCallId: "read-1",
					isError: false,
					content: [{ type: "text", text: `[example.txt#${tag}]\n2:two` }],
				},
			},
		];

		try {
			expect(await restoreHashlineState(entries, "resume-read-session", directory)).toBe(1);
			const coverage = getHashlineCoverage("resume-read-session", path, tag);
			expect(coverage).toBeDefined();
			expect(coversHashlineRange(coverage, 2, 2)).toBe(true);
			expect(coversHashlineRange(coverage, 1, 1)).toBe(false);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("restores full coverage from a successful write result", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-hashline-resume-write-"));
		const path = join(directory, "example.txt");
		const content = "one\ntwo\n";
		await writeFile(path, content, "utf8");
		const tag = computeHashlineTag(content);
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "write",
					toolCallId: "write-1",
					isError: false,
					content: [{ type: "text", text: `[example.txt#${tag}]\nSuccessfully wrote file` }],
				},
			},
		];

		try {
			expect(await restoreHashlineState(entries, "resume-write-session", directory)).toBe(1);
			const coverage = getHashlineCoverage("resume-write-session", path, tag);
			expect(coverage).toBeDefined();
			expect(coversHashlineRange(coverage, 1, 2)).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("does not restore coverage when the live file no longer matches the persisted tag", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-hashline-resume-stale-"));
		const path = join(directory, "example.txt");
		const oldTag = computeHashlineTag("old\n");
		await writeFile(path, "new\n", "utf8");
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					toolCallId: "read-stale",
					isError: false,
					content: [{ type: "text", text: `[example.txt#${oldTag}]\n1:old` }],
				},
			},
		];

		try {
			expect(await restoreHashlineState(entries, "resume-stale-session", directory)).toBe(0);
			expect(getHashlineCoverage("resume-stale-session", path, oldTag)).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
