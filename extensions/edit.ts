/**
 * Hashline edit -- override the built-in edit tool with versioned line-anchored patches.
 *
 * Text reads expose an eight-hex whole-file tag and numbered lines. The model copies
 * that header into one edit input and addresses every change against the original line
 * numbers. All hunks are parsed and validated before a single write, so a stale tag,
 * invalid range, overlap, or no-op rejects the complete batch without a partial edit.
 *
 * The deliberately small grammar supports SWAP, CUT, and literal insertions before,
 * after, at the head, or at the tail. It omits fuzzy recovery, syntax-tree block
 * resolution, multi-file transactions, and clipboard operations. Preserve BOM and the
 * file's existing LF/CRLF convention, and reuse pi's native diff helpers and rendering.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	generateDiffString,
	generateUnifiedPatch,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";

const editSchema = Type.Object({
	input: Type.String({
		description:
			"One hashline patch for one existing file. Begin with [PATH#TAG] copied from read, then add one or more SWAP, CUT, or INS hunks.",
	}),
});

const HASH_LENGTH = 8;
const HEADER_RE = /^\[(.+)#([0-9A-Fa-f]{8})\]$/;
const RANGE_RE = "([1-9]\\d*)(?:\\.=(\\d+))?";

type LineEnding = "\r\n" | "\n";
type InsertPosition = "pre" | "post" | "head" | "tail";

interface ParsedPatch {
	path: string;
	tag: string;
	hunks: ParsedHunk[];
}

interface ReplaceHunk {
	kind: "swap";
	sourceLine: number;
	start: number;
	end: number;
	body: string[];
}

interface CutHunk {
	kind: "cut";
	sourceLine: number;
	start: number;
	end: number;
}

interface InsertHunk {
	kind: "insert";
	sourceLine: number;
	position: InsertPosition;
	anchor?: number;
	body: string[];
}

type ParsedHunk = ReplaceHunk | CutHunk | InsertHunk;

interface ConcreteEdit {
	index: number;
	deleteCount: number;
	body: string[];
	sourceLine: number;
}

interface EditDetails {
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLineEnding(content: string): LineEnding {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, ending: LineEnding): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content };
}

function resolvePath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return join(homedir(), path.slice(2));
	}
	return resolve(cwd, path);
}

/** Compute the optimistic-concurrency tag emitted by read and consumed by edit. */
export function computeHashlineTag(text: string): string {
	return createHash("sha256")
		.update(normalizeToLF(stripBom(text).text), "utf8")
		.digest("hex")
		.slice(0, HASH_LENGTH)
		.toUpperCase();
}

function parseRange(
	startText: string,
	endText: string | undefined,
	sourceLine: number,
): { start: number; end: number } {
	const start = Number(startText);
	const end = endText === undefined ? start : Number(endText);
	if (end < start) {
		throw new Error(`Patch line ${sourceLine}: range ${start}.=${end} ends before it starts.`);
	}
	return { start, end };
}

function bodyFor(
	lines: string[],
	startIndex: number,
	headerLine: number,
	op: string,
): { body: string[]; nextIndex: number } {
	const body: string[] = [];
	let index = startIndex;
	while (index < lines.length) {
		const line = lines[index];
		if (line.startsWith("+")) {
			body.push(line.slice(1));
			index++;
			continue;
		}
		if (line.trim() === "") {
			index++;
			continue;
		}
		break;
	}
	if (body.length === 0) {
		throw new Error(
			`Patch line ${headerLine}: ${op} needs at least one +TEXT body row. Use CUT to delete lines.`,
		);
	}
	return { body, nextIndex: index };
}

/**
 * Parse the compact hashline grammar. Parsing is intentionally strict so malformed
 * unified diffs or copied read output cannot silently become file content.
 */
export function parseHashlinePatch(input: string): ParsedPatch {
	const lines = normalizeToLF(input).split("\n");
	let index = 0;
	while (index < lines.length && lines[index].trim() === "") index++;
	if (index >= lines.length) {
		throw new Error("Hashline input is empty.");
	}

	const header = HEADER_RE.exec(lines[index].trim());
	if (!header) {
		throw new Error(
			'Hashline input must begin with "[PATH#TAG]" copied from the latest read output.',
		);
	}
	const path = header[1];
	const tag = header[2].toUpperCase();
	index++;

	const hunks: ParsedHunk[] = [];
	const swapRe = new RegExp(`^SWAP\\s+${RANGE_RE}:$`);
	const cutRe = new RegExp(`^CUT\\s+${RANGE_RE}$`);
	const insertAnchoredRe = /^INS\.(PRE|POST)\s+([1-9]\d*):$/;
	const insertEdgeRe = /^INS\.(HEAD|TAIL):$/;

	while (index < lines.length) {
		const raw = lines[index];
		const text = raw.trim();
		const sourceLine = index + 1;
		if (text === "") {
			index++;
			continue;
		}
		if (HEADER_RE.test(text)) {
			throw new Error(
				`Patch line ${sourceLine}: only one file section is supported per edit call.`,
			);
		}
		if (raw.startsWith("+")) {
			throw new Error(
				`Patch line ${sourceLine}: payload row has no preceding SWAP or INS header.`,
			);
		}

		const swap = swapRe.exec(text);
		if (swap) {
			const range = parseRange(swap[1], swap[2], sourceLine);
			const parsedBody = bodyFor(lines, index + 1, sourceLine, "SWAP");
			hunks.push({ kind: "swap", sourceLine, ...range, body: parsedBody.body });
			index = parsedBody.nextIndex;
			continue;
		}

		const cut = cutRe.exec(text);
		if (cut) {
			const range = parseRange(cut[1], cut[2], sourceLine);
			hunks.push({ kind: "cut", sourceLine, ...range });
			index++;
			if (index < lines.length && lines[index].startsWith("+")) {
				throw new Error(
					`Patch line ${sourceLine}: CUT takes no body rows. Use SWAP to replace lines.`,
				);
			}
			continue;
		}

		const anchoredInsert = insertAnchoredRe.exec(text);
		if (anchoredInsert) {
			const position = anchoredInsert[1].toLowerCase() as "pre" | "post";
			const anchor = Number(anchoredInsert[2]);
			const parsedBody = bodyFor(lines, index + 1, sourceLine, `INS.${anchoredInsert[1]}`);
			hunks.push({
				kind: "insert",
				sourceLine,
				position,
				anchor,
				body: parsedBody.body,
			});
			index = parsedBody.nextIndex;
			continue;
		}

		const edgeInsert = insertEdgeRe.exec(text);
		if (edgeInsert) {
			const position = edgeInsert[1].toLowerCase() as "head" | "tail";
			const parsedBody = bodyFor(lines, index + 1, sourceLine, `INS.${edgeInsert[1]}`);
			hunks.push({ kind: "insert", sourceLine, position, body: parsedBody.body });
			index = parsedBody.nextIndex;
			continue;
		}

		throw new Error(
			`Patch line ${sourceLine}: invalid hunk header "${text}". Use SWAP, CUT, or INS.PRE|POST|HEAD|TAIL.`,
		);
	}

	if (hunks.length === 0) {
		throw new Error("Hashline patch contains no hunks.");
	}
	return { path, tag, hunks };
}

function splitFileLines(content: string): { lines: string[]; finalNewline: boolean } {
	if (content === "") return { lines: [], finalNewline: false };
	const finalNewline = content.endsWith("\n");
	const lines = content.split("\n");
	if (finalNewline) lines.pop();
	return { lines, finalNewline };
}

function validateAnchor(anchor: number, lineCount: number, sourceLine: number): void {
	if (anchor > lineCount) {
		throw new Error(
			`Patch line ${sourceLine}: line ${anchor} does not exist (file has ${lineCount} lines).`,
		);
	}
}

function concretizeHunks(hunks: ParsedHunk[], lineCount: number): ConcreteEdit[] {
	const edits: ConcreteEdit[] = [];
	for (const hunk of hunks) {
		if (hunk.kind === "swap" || hunk.kind === "cut") {
			validateAnchor(hunk.start, lineCount, hunk.sourceLine);
			validateAnchor(hunk.end, lineCount, hunk.sourceLine);
			edits.push({
				index: hunk.start - 1,
				deleteCount: hunk.end - hunk.start + 1,
				body: hunk.kind === "swap" ? hunk.body : [],
				sourceLine: hunk.sourceLine,
			});
			continue;
		}

		let index: number;
		switch (hunk.position) {
			case "head":
				index = 0;
				break;
			case "tail":
				index = lineCount;
				break;
			case "pre":
				validateAnchor(hunk.anchor!, lineCount, hunk.sourceLine);
				index = hunk.anchor! - 1;
				break;
			case "post":
				validateAnchor(hunk.anchor!, lineCount, hunk.sourceLine);
				index = hunk.anchor!;
				break;
		}
		edits.push({
			index,
			deleteCount: 0,
			body: hunk.body,
			sourceLine: hunk.sourceLine,
		});
	}
	return edits;
}

function validateNoOverlap(edits: ConcreteEdit[]): void {
	for (let i = 0; i < edits.length; i++) {
		const left = edits[i];
		for (let j = i + 1; j < edits.length; j++) {
			const right = edits[j];
			const leftEnd = left.index + left.deleteCount;
			const rightEnd = right.index + right.deleteCount;
			const rangesOverlap =
				left.deleteCount > 0 &&
				right.deleteCount > 0 &&
				left.index < rightEnd &&
				right.index < leftEnd;
			const sameCursor = left.index === right.index;
			const leftInsertInsideRight =
				left.deleteCount === 0 && left.index > right.index && left.index < rightEnd;
			const rightInsertInsideLeft =
				right.deleteCount === 0 && right.index > left.index && right.index < leftEnd;

			if (rangesOverlap || sameCursor || leftInsertInsideRight || rightInsertInsideLeft) {
				throw new Error(
					`Patch lines ${left.sourceLine} and ${right.sourceLine} overlap or target the same insertion point. Merge them into one hunk.`,
				);
			}
		}
	}
}

export function applyHashlinePatch(content: string, hunks: ParsedHunk[]): string {
	const split = splitFileLines(content);
	const edits = concretizeHunks(hunks, split.lines.length);
	validateNoOverlap(edits);

	const result = [...split.lines];
	for (const edit of [...edits].sort((a, b) => b.index - a.index)) {
		result.splice(edit.index, edit.deleteCount, ...edit.body);
	}

	if (result.length === 0) return "";
	return result.join("\n") + (split.finalNewline ? "\n" : "");
}

function renderEditDiff(
	diff: string,
	theme: {
		fg: (
			color: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext",
			text: string,
		) => string;
	},
): string {
	return diff
		.split("\n")
		.map((line) => {
			const expanded = line.replace(/\t/g, "   ");
			if (line.startsWith("+")) return theme.fg("toolDiffAdded", expanded);
			if (line.startsWith("-")) return theme.fg("toolDiffRemoved", expanded);
			return theme.fg("toolDiffContext", expanded);
		})
		.join("\n");
}

function pathFromInput(input: unknown): string {
	if (typeof input !== "string") return "";
	const first = normalizeToLF(input)
		.split("\n")
		.find((line) => line.trim() !== "");
	return first ? HEADER_RE.exec(first.trim())?.[1] ?? "" : "";
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Apply one versioned, line-anchored patch to an existing file. Copy [PATH#TAG] and line numbers from the latest read. Multiple non-overlapping hunks apply atomically against the original line numbers.",
		parameters: editSchema,
		promptSnippet: "Apply a compact hashline patch with one or more line-anchored hunks",
		promptGuidelines: [
			"Before editing a text file, use read and copy its [PATH#TAG] header. The tag prevents edits against stale line numbers.",
			"Patch syntax: SWAP N: or SWAP N.=M: replaces original inclusive lines with following +TEXT rows; CUT N or CUT N.=M deletes original lines.",
			"Use INS.PRE N:, INS.POST N:, INS.HEAD:, or INS.TAIL: for pure insertions. Every SWAP/INS body row begins with +; + alone inserts a blank line.",
			"Put all non-overlapping changes for one file in one edit call. Every hunk uses line numbers from the same pre-edit read; body length does not affect later anchors.",
			"After a successful edit, re-read before another edit because both line numbers and the file tag may have changed.",
		],
		executionMode: "sequential",
		renderShell: "default",

		renderCall(args, theme) {
			const input = typeof args.input === "string" ? args.input : "";
			const path = pathFromInput(input);
			const title = theme.fg("toolTitle", theme.bold("edit"));
			return new Text(
				path ? `${title} ${theme.fg("accent", path)}` : title,
				0,
				0,
			);
		},

		renderResult(result, { isPartial }, theme, context) {
			const component = new Container();
			if (isPartial) return component;

			const text = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			const details = result.details as EditDetails | undefined;
			const output = context.isError
				? text
					? theme.fg("error", text)
					: ""
				: details?.diff
					? renderEditDiff(details.diff, theme)
					: text
						? theme.fg("toolOutput", text)
						: "";
			if (!output) return component;
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 0, 0));
			return component;
		},

		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const rawInput = (input as { input?: unknown }).input;
			if (typeof rawInput !== "string") {
				throw new Error("edit requires an 'input' string.");
			}
			const parsed = parseHashlinePatch(rawInput);
			const absolutePath = resolvePath(parsed.path, ctx.cwd);

			const throwIfAborted = (): void => {
				if (signal?.aborted) throw new Error("Operation aborted");
			};
			throwIfAborted();

			try {
				await access(absolutePath, constants.R_OK | constants.W_OK);
			} catch (error: unknown) {
				const code =
					error instanceof Error && "code" in error
						? ` (code: ${(error as NodeJS.ErrnoException).code})`
						: "";
				throw new Error(`Could not edit file: ${parsed.path}${code}.`);
			}
			throwIfAborted();

			const buffer = await readFile(absolutePath);
			throwIfAborted();
			const rawContent = buffer.toString("utf8");
			const { bom, text } = stripBom(rawContent);
			const originalEnding = detectLineEnding(text);
			const content = normalizeToLF(text);
			const actualTag = computeHashlineTag(content);
			if (actualTag !== parsed.tag) {
				throw new Error(
					`Stale hashline tag for ${parsed.path}: patch has #${parsed.tag}, current file is #${actualTag}. Re-read the file and rebuild the patch from the new line numbers.`,
				);
			}

			const newContent = applyHashlinePatch(content, parsed.hunks);
			if (newContent === content) {
				throw new Error(
					`Hashline patch for ${parsed.path} produced no change. Re-read the file and verify the target lines.`,
				);
			}
			throwIfAborted();

			await writeFile(
				absolutePath,
				bom + restoreLineEndings(newContent, originalEnding),
				"utf8",
			);

			const diffResult = generateDiffString(content, newContent);
			const patch = generateUnifiedPatch(parsed.path, content, newContent);
			const newTag = computeHashlineTag(newContent);
			return {
				content: [
					{
						type: "text" as const,
						text: `[${parsed.path}#${newTag}]\nApplied ${parsed.hunks.length} hashline hunk${parsed.hunks.length === 1 ? "" : "s"}. Re-read before the next edit.`,
					},
				],
				details: {
					diff: diffResult.diff,
					patch,
					firstChangedLine: diffResult.firstChangedLine,
				},
			};
		},
	});
}
