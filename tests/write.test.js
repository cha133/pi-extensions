import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerWrite, {
	computeHashlineTag,
	parseCopiedHashlineSnapshot,
} from "../extensions/write.ts";
import registerEdit, {
	computeHashlineTag as computeEditHashlineTag,
} from "../extensions/edit.ts";
import { formatHashlineRead } from "../extensions/read.ts";

function registerDefinition(cwd) {
	let sessionStart;
	let definition;
	registerWrite({
		on(event, handler) {
			if (event === "session_start") sessionStart = handler;
		},
		registerTool(tool) {
			definition = tool;
		},
	});
	sessionStart({}, { cwd });
	return definition;
}

function registerEditDefinition() {
	let definition;
	registerEdit({
		registerTool(tool) {
			definition = tool;
		},
	});
	return definition;
}

describe("copied hashline write parsing", () => {
	test("strips a complete consecutive snapshot", () => {
		const parsed = parseCopiedHashlineSnapshot(
			"[example.txt#A1B2C3D4]\n1:alpha\n2:beta",
		);
		expect(parsed).toEqual({
			path: "example.txt",
			tag: "A1B2C3D4",
			content: "alpha\nbeta",
		});
	});

	test("leaves ordinary numbered content untouched", () => {
		expect(parseCopiedHashlineSnapshot("1:literal\n2:content")).toBeUndefined();
	});

	test("rejects partial read output", () => {
		expect(() =>
			parseCopiedHashlineSnapshot(
				"[example.txt#A1B2C3D4]\n1:alpha\n[2 more lines in file. Use offset=2 to continue.]",
			),
		).toThrow("partial or non-editable read");
	});

	test("rejects non-consecutive or offset snapshots", () => {
		expect(() =>
			parseCopiedHashlineSnapshot("[example.txt#A1B2C3D4]\n2:beta"),
		).toThrow("expected line 1");
		expect(() =>
			parseCopiedHashlineSnapshot("[example.txt#A1B2C3D4]\n1:alpha\n3:gamma"),
		).toThrow("expected line 2");
	});

	test("rejects unnumbered rows under a hashline header", () => {
		expect(() =>
			parseCopiedHashlineSnapshot("[example.txt#A1B2C3D4]\nalpha"),
		).toThrow("invalid row");
	});
});

describe("write hashline tags", () => {
	test("matches read and edit normalization", () => {
		const content = "\uFEFFalpha\r\nbeta\r\n";
		expect(computeHashlineTag(content)).toBe(computeEditHashlineTag(content));
	});
});

describe("write override", () => {
	test("preserves the native path/content schema and adds hashline guidance", () => {
		const definition = registerDefinition("C:\\workspace");
		expect(definition.name).toBe("write");
		expect(Object.keys(definition.parameters.properties)).toEqual(["path", "content"]);
		expect(definition.promptSnippet).toContain("fresh hashline tag");
		expect(definition.promptGuidelines.join("\n")).toContain("partial, stale");
	});

	test("creates a normal file and returns a tag for actual disk content", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-hashline-write-"));
		const definition = registerDefinition(directory);
		const path = join("nested", "example.txt");

		try {
			const result = await definition.execute(
				"tool-call",
				{ path, content: "alpha\n" },
				undefined,
				undefined,
				{ cwd: directory },
			);
			const written = await readFile(join(directory, path), "utf8");
			expect(written).toBe("alpha\n");
			expect(result.content[0].text).toStartWith(
				`[${path}#${computeHashlineTag(written)}]`,
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("makes the returned write header immediately usable by edit", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-write-edit-chain-"));
		const writeDefinition = registerDefinition(directory);
		const editDefinition = registerEditDefinition();

		try {
			const writeResult = await writeDefinition.execute(
				"write-call",
				{ path: "chain.txt", content: "alpha\nbeta\n" },
				undefined,
				undefined,
				{ cwd: directory },
			);
			const header = writeResult.content[0].text.split("\n")[0];
			await editDefinition.execute(
				"edit-call",
				{ input: `${header}\nSWAP 2:\n+BETA` },
				undefined,
				undefined,
				{ cwd: directory },
			);

			expect(await readFile(join(directory, "chain.txt"), "utf8")).toBe(
				"alpha\nBETA\n",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("keeps ordinary content beginning with line-number-like text", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-ordinary-write-"));
		const definition = registerDefinition(directory);

		try {
			await definition.execute(
				"tool-call",
				{ path: "literal.txt", content: "1:literal\n2:content" },
				undefined,
				undefined,
				{ cwd: directory },
			);
			expect(await readFile(join(directory, "literal.txt"), "utf8")).toBe(
				"1:literal\n2:content",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rewrites a verified copied snapshot and preserves BOM, CRLF, and final newline", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-copied-write-"));
		const definition = registerDefinition(directory);
		const path = join(directory, "example.txt");
		const original = "\uFEFFalpha\r\nbeta\r\n";
		await writeFile(path, original, "utf8");
		const snapshot = formatHashlineRead(original, { path: "example.txt" }).replace(
			"2:beta",
			"2:BETA",
		);

		try {
			const result = await definition.execute(
				"tool-call",
				{ path: "example.txt", content: snapshot },
				undefined,
				undefined,
				{ cwd: directory },
			);
			expect(await readFile(path, "utf8")).toBe("\uFEFFalpha\r\nBETA\r\n");
			expect(result.content[0].text).toContain(
				"Removed verified hashline read prefixes",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects stale copied snapshots without writing", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-stale-write-"));
		const definition = registerDefinition(directory);
		const path = join(directory, "example.txt");
		await writeFile(path, "current\n", "utf8");

		try {
			await expect(
				definition.execute(
					"tool-call",
					{
						path: "example.txt",
						content: "[example.txt#00000000]\n1:replacement",
					},
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

	test("rejects a copied snapshot targeting another path", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-cross-path-write-"));
		const definition = registerDefinition(directory);
		await writeFile(join(directory, "target.txt"), "current\n", "utf8");
		const tag = computeHashlineTag("current\n");

		try {
			await expect(
				definition.execute(
					"tool-call",
					{
						path: "target.txt",
						content: `[other.txt#${tag}]\n1:replacement`,
					},
					undefined,
					undefined,
					{ cwd: directory },
				),
			).rejects.toThrow("header targets other.txt");
			expect(await readFile(join(directory, "target.txt"), "utf8")).toBe("current\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
