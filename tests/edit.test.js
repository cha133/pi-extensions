import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerEdit, { findMatch } from "../extensions/edit.ts";

describe("deterministic matching", () => {
	test("prefers an exact unique match", () => {
		const content = ["before", "target();", "after"].join("\n");
		const match = findMatch(content, "target();", "example.ts");

		expect(match.strategy).toBe("exact");
		expect(content.slice(match.index, match.index + match.length)).toBe("target();");
	});

	test("rejects duplicate exact matches", () => {
		const content = ["start", "alpha", "end", "---", "start", "alpha", "end"].join("\n");
		const oldText = ["start", "alpha", "end"].join("\n");

		expect(() => findMatch(content, oldText, "example.ts")).toThrow(
			"Found multiple matches for oldText",
		);
	});

	test("uses relative indentation to disambiguate line-trimmed candidates", () => {
		const content = [
			"  if (ready) {",
			"    run();",
			"  }",
			"",
			"  if (ready) {",
			"  run();",
			"  }",
		].join("\n");
		const oldText = ["if (ready) {", "  run();", "}"].join("\n");
		const match = findMatch(content, oldText, "example.ts");

		expect(match.strategy).toBe("indentation-flexible");
		expect(match.index).toBe(0);
	});

	test("unescapes a small set of oldText escapes", () => {
		const content = ["alpha", "\tbeta"].join("\n");
		const match = findMatch(content, "alpha\\n\\tbeta", "example.ts");

		expect(match.strategy).toBe("escape-normalized");
		expect(match.length).toBe(content.length);
	});
});

describe("partial-line indentation matching", () => {
	const firstLine =
		'\t\t\t\t"For searching, prefer rg and locate commands with `(Get-Command name).Source` (not `which`).",';
	const insertedLine =
		'\t\t\t\t"When using Select-String, count MatchInfo objects rather than Matches.",';
	const followingLine = '\t\t\t\t"Pass multiline arguments with a here-string.",';
	const content = [firstLine, insertedLine, followingLine].join("\n");

	test("matches a multiline fragment despite different leading indentation", () => {
		const oldText = [
			'(not `which`).",',
			'\t\t\t"When using Select-String, count MatchInfo objects rather than Matches.",',
		].join("\n");

		const match = findMatch(content, oldText, "example.ts");
		const matchedText = content.slice(match.index, match.index + match.length);

		expect(match.strategy).toBe("partial-line-indentation");
		expect(match.index).toBe(content.indexOf('(not `which`).",'));
		expect(matchedText).toBe(
			[
				'(not `which`).",',
				'\t\t\t\t"When using Select-String, count MatchInfo objects rather than Matches.",',
			].join("\n"),
		);
	});

	test("preserves text before the fragment and after the matched span", () => {
		const oldText = [
			'(not `which`).",',
			'\t\t\t"When using Select-String, count MatchInfo objects rather than Matches.",',
		].join("\n");
		const match = findMatch(content, oldText, "example.ts");
		const updated =
			content.slice(0, match.index) + '(not `which`).",' + content.slice(match.index + match.length);

		expect(updated).toContain("locate commands with `(Get-Command name).Source` (not `which`).\",");
		expect(updated).toContain(followingLine);
		expect(updated).not.toContain("When using Select-String");
	});

	test("does not consume indentation after a trailing newline", () => {
		const oldText = ['(not `which`).",', "   "].join("\n");
		const match = findMatch(content, oldText, "example.ts");
		const matchedText = content.slice(match.index, match.index + match.length);

		expect(matchedText).toBe('(not `which`).",\n');
		expect(content.slice(match.index + match.length)).toStartWith("\t\t\t\t");
	});

	test("preserves a suffix after a last-line fragment", () => {
		const suffixContent = ["\t\talpha();", "\t\tbeta(); // keep this suffix"].join("\n");
		const oldText = ["  alpha();", "  beta();"].join("\n");
		const match = findMatch(suffixContent, oldText, "example.ts");
		const matchedText = suffixContent.slice(match.index, match.index + match.length);

		expect(match.strategy).toBe("partial-line-indentation");
		expect(matchedText).toBe(["alpha();", "\t\tbeta();"].join("\n"));
		expect(suffixContent.slice(match.index + match.length)).toBe(" // keep this suffix");
	});

	test("rejects multiple normalized candidates even when their indentation differs", () => {
		const duplicate = [
			content,
			"",
			firstLine,
			insertedLine.replace(/^\t+/, "  "),
			followingLine,
		].join("\n");
		const oldText = [
			'(not `which`).",',
			'\t\t\t"When using Select-String, count MatchInfo objects rather than Matches.",',
		].join("\n");

		expect(() => findMatch(duplicate, oldText, "example.ts")).toThrow(
			"Found multiple matches for oldText",
		);
	});

	test("adds a focused hint when a fragment still cannot be matched", () => {
		const oldText = ['(not `which`).",', '"A different second line.",'].join("\n");

		expect(() => findMatch(content, oldText, "example.ts")).toThrow(
			"The first line of oldText appears to be a line fragment",
		);
	});
});

describe("block-anchor matching", () => {
	test("selects a clearly better fuzzy candidate", () => {
		const content = [
			"start",
			"const value = alphaX;",
			"end",
			"---",
			"start",
			"completely different",
			"end",
		].join("\n");
		const oldText = ["start", "const value = alphaY;", "end"].join("\n");
		const match = findMatch(content, oldText, "example.ts");

		expect(match.strategy).toBe("block-anchor");
		expect(match.index).toBe(0);
	});

	test("rejects tied fuzzy candidates instead of choosing the first", () => {
		const content = [
			"start",
			"const value = alphaX;",
			"end",
			"---",
			"start",
			"const value = alphaZ;",
			"end",
		].join("\n");
		const oldText = ["start", "const value = alphaY;", "end"].join("\n");

		expect(() => findMatch(content, oldText, "example.ts")).toThrow(
			"Found multiple matches for oldText",
		);
	});

	test("penalizes a missing middle line", () => {
		const content = ["start", "alpha", "beta", "end"].join("\n");
		const oldText = ["start", "alpha", "beta", "gamma", "end"].join("\n");

		expect(() => findMatch(content, oldText, "example.ts")).toThrow(
			"Could not find oldText",
		);
	});

	test("penalizes an inserted middle line", () => {
		const content = ["start", "alpha", "beta", "gamma", "end"].join("\n");
		const oldText = ["start", "alpha", "beta", "end"].join("\n");

		expect(() => findMatch(content, oldText, "example.ts")).toThrow(
			"Could not find oldText",
		);
	});

	test("continues past an early out-of-window tail anchor", () => {
		const content = ["start", "alpha", "end", "beta", "end"].join("\n");
		const oldText = ["start", "alpha", "ends", "beta", "end"].join("\n");
		const match = findMatch(content, oldText, "example.ts");

		expect(match.strategy).toBe("block-anchor");
		expect(match.length).toBe(content.length);
	});

	test("does not fuzzy-match blocks with empty anchors", () => {
		const content = ["", "alphaX", "end"].join("\n");
		const oldText = ["", "alphaY", "end"].join("\n");

		expect(() => findMatch(content, oldText, "example.ts")).toThrow(
			"Could not find oldText",
		);
	});
});

describe("edit rendering", () => {
	test("uses extension-owned renderers instead of the built-in exact preview", () => {
		let definition;
		registerEdit({
			registerTool(tool) {
				definition = tool;
			},
		});

		expect(definition.renderShell).toBe("default");
		expect(definition.renderCall).toBeFunction();
		expect(definition.renderResult).toBeFunction();
	});

	test("renders one final error inside the shared tool shell", () => {
		let definition;
		registerEdit({
			registerTool(tool) {
				definition = tool;
			},
		});
		const theme = {
			bold: (text) => text,
			fg: (_color, text) => text,
		};
		const context = {
			isError: true,
		};
		const component = definition.renderResult(
			{ content: [{ type: "text", text: "Could not find oldText." }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			context,
		);
		const rendered = component.render(120).join("\n");

		expect(rendered.match(/Could not find oldText\./g)).toHaveLength(1);
	});
});

describe("edit execution", () => {
	test("preserves BOM and CRLF and does not inspect cancellation after commit", async () => {
		let definition;
		registerEdit({
			registerTool(tool) {
				definition = tool;
			},
		});

		const directory = await mkdtemp(join(tmpdir(), "pi-edit-test-"));
		const path = join(directory, "example.txt");
		await writeFile(path, "\uFEFFalpha\r\nbeta\r\n", "utf8");
		let abortChecks = 0;
		const signal = {
			get aborted() {
				abortChecks++;
				return abortChecks > 5;
			},
		};

		try {
			await definition.execute(
				"tool-call",
				{ path, oldText: "alpha\nbeta", newText: "alpha\ngamma" },
				signal,
				undefined,
				{ cwd: directory },
			);
			const updated = await readFile(path, "utf8");

			expect(abortChecks).toBe(5);
			expect(updated).toBe("\uFEFFalpha\r\ngamma\r\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
