import { describe, expect, test } from "bun:test";
import registerRead, { needsVisionFallback } from "../extensions/read.ts";

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

describe("read override registration", () => {
	test("replaces read with one truthful, always-visible tool", () => {
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
		sessionStart({}, { cwd: "C:\\workspace", isProjectTrusted: () => false });

		expect(registered.name).toBe("read");
		expect(registered.promptSnippet).toContain("automatic vision fallback");
		expect(registered.promptGuidelines.join("\n")).toContain("Do not look for or call a separate image-viewing tool");
	});
});
