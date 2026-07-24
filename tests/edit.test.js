import { describe, expect, test } from "bun:test";
import { findMatch } from "../extensions/edit.ts";

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
