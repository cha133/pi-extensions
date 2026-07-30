import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerEdit, {
	applyHashlinePatch,
	computeHashlineTag,
	parseHashlinePatch,
} from "../extensions/edit.ts";

function patch(body, path = "example.txt", tag = "A1B2C3D4") {
	return `[${path}#${tag}]\n${body}`;
}

function registerDefinition() {
	let definition;
	registerEdit({
		registerTool(tool) {
			definition = tool;
		},
	});
	return definition;
}

describe("hashline parser", () => {
	test("parses every supported operation", () => {
		const parsed = parseHashlinePatch(
			patch(
				[
					"SWAP 2:",
					"+two",
					"SWAP 4.=5:",
					"+four-five",
					"CUT 7",
					"CUT 9.=10",
					"INS.PRE 12:",
					"+before",
					"INS.POST 13:",
					"+after",
					"INS.HEAD:",
					"+head",
					"INS.TAIL:",
					"+tail",
				].join("\n"),
			),
		);

		expect(parsed.path).toBe("example.txt");
		expect(parsed.tag).toBe("A1B2C3D4");
		expect(parsed.hunks.map((hunk) => hunk.kind)).toEqual([
			"swap",
			"swap",
			"cut",
			"cut",
			"insert",
			"insert",
			"insert",
			"insert",
		]);
		expect(parsed.hunks[0]).toMatchObject({ start: 2, end: 2, body: ["two"] });
		expect(parsed.hunks[1]).toMatchObject({ start: 4, end: 5, body: ["four-five"] });
	});

	test("preserves indentation and literal leading punctuation in body rows", () => {
		const parsed = parseHashlinePatch(
			patch(["SWAP 1:", "+\tindented", "+- bullet", "++plus", "+"].join("\n")),
		);

		expect(parsed.hunks[0].body).toEqual(["\tindented", "- bullet", "+plus", ""]);
	});

	test("accepts lowercase hex in a copied header and canonicalizes it", () => {
		expect(parseHashlinePatch(patch("CUT 1", "x", "abcdef12")).tag).toBe("ABCDEF12");
	});

	test("rejects a missing header", () => {
		expect(() => parseHashlinePatch("SWAP 1:\n+x")).toThrow("must begin");
	});

	test("rejects a second file section", () => {
		expect(() =>
			parseHashlinePatch(`${patch("CUT 1")}\n[other.txt#11223344]\nCUT 1`),
		).toThrow("only one file section");
	});

	test("rejects payload without a hunk", () => {
		expect(() => parseHashlinePatch(patch("+orphan"))).toThrow("no preceding");
	});

	test("rejects empty SWAP and insertion bodies", () => {
		expect(() => parseHashlinePatch(patch("SWAP 1:"))).toThrow("needs at least one");
		expect(() => parseHashlinePatch(patch("INS.HEAD:"))).toThrow("needs at least one");
	});

	test("rejects body rows under CUT", () => {
		expect(() => parseHashlinePatch(patch("CUT 1\n+wrong"))).toThrow("CUT takes no body");
	});

	test("rejects descending ranges", () => {
		expect(() => parseHashlinePatch(patch("CUT 5.=2"))).toThrow("ends before");
	});

	test("rejects non-canonical or unknown hunk headers", () => {
		expect(() => parseHashlinePatch(patch("SWAP 1-2:\n+x"))).toThrow("invalid hunk");
		expect(() => parseHashlinePatch(patch("@@ -1 +1 @@\n+x"))).toThrow("invalid hunk");
	});
});

describe("hashline application", () => {
	test("applies multiple hunks against original line numbers", () => {
		const parsed = parseHashlinePatch(
			patch(["SWAP 2:", "+B", "CUT 3", "INS.POST 4:", "+after-d"].join("\n")),
		);

		expect(applyHashlinePatch("a\nb\nc\nd\ne\n", parsed.hunks)).toBe(
			"a\nB\nd\nafter-d\ne\n",
		);
	});

	test("does not shift later anchors when an earlier replacement changes length", () => {
		const parsed = parseHashlinePatch(
			patch(["SWAP 1:", "+one-a", "+one-b", "SWAP 4:", "+FOUR"].join("\n")),
		);

		expect(applyHashlinePatch("one\ntwo\nthree\nfour\n", parsed.hunks)).toBe(
			"one-a\none-b\ntwo\nthree\nFOUR\n",
		);
	});

	test("supports head and tail insertion", () => {
		const parsed = parseHashlinePatch(
			patch(["INS.HEAD:", "+head", "INS.TAIL:", "+tail"].join("\n")),
		);

		expect(applyHashlinePatch("middle\n", parsed.hunks)).toBe("head\nmiddle\ntail\n");
	});

	test("can initialize an empty file with an edge insertion", () => {
		const parsed = parseHashlinePatch(patch("INS.HEAD:\n+first"));
		expect(applyHashlinePatch("", parsed.hunks)).toBe("first");
	});

	test("can delete the entire file without leaving a phantom newline", () => {
		const parsed = parseHashlinePatch(patch("CUT 1.=2"));
		expect(applyHashlinePatch("a\nb\n", parsed.hunks)).toBe("");
	});

	test("preserves the original final-newline state", () => {
		const parsed = parseHashlinePatch(patch("SWAP 1:\n+A"));
		expect(applyHashlinePatch("a\nb\n", parsed.hunks)).toBe("A\nb\n");
		expect(applyHashlinePatch("a\nb", parsed.hunks)).toBe("A\nb");
	});

	test("rejects out-of-range anchors", () => {
		const parsed = parseHashlinePatch(patch("SWAP 3:\n+x"));
		expect(() => applyHashlinePatch("a\nb\n", parsed.hunks)).toThrow(
			"line 3 does not exist",
		);
	});

	test("rejects overlapping ranges", () => {
		const parsed = parseHashlinePatch(
			patch(["SWAP 2.=4:", "+x", "CUT 4.=5"].join("\n")),
		);
		expect(() => applyHashlinePatch("1\n2\n3\n4\n5\n", parsed.hunks)).toThrow(
			"overlap",
		);
	});

	test("rejects duplicate insertion points", () => {
		const parsed = parseHashlinePatch(
			patch(["INS.POST 1:", "+x", "INS.PRE 2:", "+y"].join("\n")),
		);
		expect(() => applyHashlinePatch("1\n2\n", parsed.hunks)).toThrow(
			"same insertion point",
		);
	});

	test("rejects insertion inside a replaced range", () => {
		const parsed = parseHashlinePatch(
			patch(["SWAP 2.=4:", "+x", "INS.POST 2:", "+y"].join("\n")),
		);
		expect(() => applyHashlinePatch("1\n2\n3\n4\n5\n", parsed.hunks)).toThrow(
			"overlap",
		);
	});
});

describe("hashline tags", () => {
	test("normalizes BOM and line endings", () => {
		expect(computeHashlineTag("\uFEFFa\r\nb\r\n")).toBe(computeHashlineTag("a\nb\n"));
	});

	test("changes when file content changes", () => {
		expect(computeHashlineTag("a\n")).not.toBe(computeHashlineTag("b\n"));
	});
});

describe("edit registration and execution", () => {
	test("exposes only the compact input schema and sequential execution", () => {
		const definition = registerDefinition();
		expect(Object.keys(definition.parameters.properties)).toEqual(["input"]);
		expect(definition.executionMode).toBe("sequential");
		expect(definition.promptGuidelines.join("\n")).toContain(
			"Put all non-overlapping changes for one file in one edit call",
		);
	});

	test("uses extension-owned renderers", () => {
		const definition = registerDefinition();
		expect(definition.renderShell).toBe("default");
		expect(definition.renderCall).toBeFunction();
		expect(definition.renderResult).toBeFunction();
	});

	test("preserves BOM and CRLF while applying a multi-hunk patch", async () => {
		const definition = registerDefinition();
		const directory = await mkdtemp(join(tmpdir(), "pi-hashline-edit-"));
		const path = join(directory, "example.txt");
		const original = "\uFEFFalpha\r\nbeta\r\ngamma\r\n";
		await writeFile(path, original, "utf8");
		const tag = computeHashlineTag(original);

		try {
			const result = await definition.execute(
				"tool-call",
				{
					input: `[${path}#${tag}]\nSWAP 2:\n+BETA\nINS.POST 3:\n+delta`,
				},
				undefined,
				undefined,
				{ cwd: directory },
			);
			expect(await readFile(path, "utf8")).toBe(
				"\uFEFFalpha\r\nBETA\r\ngamma\r\ndelta\r\n",
			);
			expect(result.content[0].text).toContain("Applied 2 hashline hunks");
			expect(result.content[0].text).toMatch(/#[0-9A-F]{8}\]/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects a stale tag without changing the file", async () => {
		const definition = registerDefinition();
		const directory = await mkdtemp(join(tmpdir(), "pi-hashline-stale-"));
		const path = join(directory, "example.txt");
		await writeFile(path, "current\n", "utf8");

		try {
			await expect(
				definition.execute(
					"tool-call",
					{ input: `[${path}#00000000]\nSWAP 1:\n+changed` },
					undefined,
					undefined,
					{ cwd: directory },
				),
			).rejects.toThrow("Stale hashline tag");
			expect(await readFile(path, "utf8")).toBe("current\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("validates every hunk before writing any change", async () => {
		const definition = registerDefinition();
		const directory = await mkdtemp(join(tmpdir(), "pi-hashline-atomic-"));
		const path = join(directory, "example.txt");
		const original = "one\ntwo\n";
		await writeFile(path, original, "utf8");
		const tag = computeHashlineTag(original);

		try {
			await expect(
				definition.execute(
					"tool-call",
					{ input: `[${path}#${tag}]\nSWAP 1:\n+ONE\nSWAP 99:\n+bad` },
					undefined,
					undefined,
					{ cwd: directory },
				),
			).rejects.toThrow("line 99 does not exist");
			expect(await readFile(path, "utf8")).toBe(original);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects a byte-identical no-op", async () => {
		const definition = registerDefinition();
		const directory = await mkdtemp(join(tmpdir(), "pi-hashline-noop-"));
		const path = join(directory, "example.txt");
		const original = "same\n";
		await writeFile(path, original, "utf8");
		const tag = computeHashlineTag(original);

		try {
			await expect(
				definition.execute(
					"tool-call",
					{ input: `[${path}#${tag}]\nSWAP 1:\n+same` },
					undefined,
					undefined,
					{ cwd: directory },
				),
			).rejects.toThrow("produced no change");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
