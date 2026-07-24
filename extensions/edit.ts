/**
 * Fuzzy edit -- override the built-in edit tool with multi-strategy fallback matching.
 *
 * The built-in edit tool only tries exact matching and line-trimmed fuzzy matching. It
 * fails on mixed tabs and spaces, shifted indentation, literal \n sequences emitted by
 * models, or blocks whose endpoints match but whose middle differs slightly. This ports
 * and streamlines opencode's multi-Replacer approach (see packages/opencode/src/tool/edit.ts
 * at https://github.com/nicepkg/opencode):
 *
 *   1. Exact            exact substring
 *   2. IndentFlexible   remove minimum common indentation before comparing
 *   3. LineTrimmed      compare trimmed lines, ignoring leading/trailing whitespace
 *   4. WhitespaceNorm   collapse \s+ to one space, handling tabs and repeated spaces
 *   5. EscapeNorm       unescape literal \n, \t, \r, and similar model quirks
 *   6. PartialLineIndent match a multiline substring while ignoring indentation after
 *                        newlines; only applies when an endpoint is a line fragment
 *   7. BlockAnchor      anchor on first/last lines and score the middle with aligned
 *                       line similarity (>= 0.72 plus a runner-up margin); tolerate a
 *                       line-count difference of up to 25%
 *
 * Every matcher yields exact spans in the original content. Deterministic strategies
 * accept the first unique match and may use a later, more structural matcher to resolve
 * ambiguity. BlockAnchor returns all fuzzy candidates and requires both a minimum score
 * and a clear margin over the runner-up.
 *
 * Like opencode and Claude Code, each call performs one oldText -> newText replacement.
 * Multiple changes should use separate calls, serialized by executionMode: "sequential".
 * A failed match then does not invalidate unrelated edits, and the model need not spend
 * time assembling a large edits array.
 *
 * Preserve the BOM and the file's original line endings. Diff generation reuses the same
 * `diff` package and display format as built-in edit-diff.ts, including line numbers,
 * collapsed context, and firstChangedLine positioning, for consistent TUI rendering.
 *
 * Place this file in ~/.pi/agent/extensions/ for auto-discovery. Registering the same
 * name overrides the built-in edit tool; use /reload to hot-reload it in a session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	generateDiffString,
	generateUnifiedPatch,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({
		description: "Text for one targeted replacement. It must identify a unique region in the file.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
});

// ---------------------------------------------------------------------------
// Line endings and BOM
// ---------------------------------------------------------------------------

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlf = content.indexOf("\r\n");
	const lf = content.indexOf("\n");
	if (lf === -1 || crlf === -1 || crlf >= lf) return "\n";
	return "\r\n";
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function resolvePath(p: string, cwd: string): string {
	if (p.startsWith("~")) return join(homedir(), p.slice(1));
	return resolve(cwd, p);
}

// ---------------------------------------------------------------------------
// Levenshtein distance, used by BlockAnchor scoring
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
	if (a === "" || b === "") return Math.max(a.length, b.length);

	// Keep the shorter string on the horizontal axis so memory stays O(min(a, b)).
	if (a.length < b.length) [a, b] = [b, a];
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	let current = new Array<number>(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		current[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
		}
		[previous, current] = [current, previous];
	}
	return previous[b.length];
}

// ---------------------------------------------------------------------------
// Matchers yield exact spans in the original content. Returning positions directly
// preserves matcher provenance and avoids re-scanning yielded substrings with indexOf.
// ---------------------------------------------------------------------------

type StrategyName =
	| "exact"
	| "indentation-flexible"
	| "line-trimmed"
	| "whitespace-normalized"
	| "escape-normalized"
	| "partial-line-indentation"
	| "block-anchor";

interface MatchCandidate {
	index: number;
	length: number;
	strategy: StrategyName;
	score?: number;
}

type Matcher = (content: string, find: string) => Generator<MatchCandidate, void, unknown>;

function findAllOccurrences(content: string, search: string): number[] {
	if (search.length === 0) return [];
	const indices: number[] = [];
	let fromIndex = 0;
	while (fromIndex <= content.length - search.length) {
		const index = content.indexOf(search, fromIndex);
		if (index === -1) break;
		indices.push(index);
		fromIndex = index + 1;
	}
	return indices;
}

function getLineOffsets(content: string): number[] {
	const offsets = [0];
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\n") offsets.push(i + 1);
	}
	return offsets;
}

function spanFromLines(
	content: string,
	lineOffsets: number[],
	startLine: number,
	lineCount: number,
	strategy: StrategyName,
	score?: number,
): MatchCandidate {
	const index = lineOffsets[startLine];
	const endLineExclusive = startLine + lineCount;
	const end =
		endLineExclusive < lineOffsets.length
			? lineOffsets[endLineExclusive] - 1
			: content.length;
	return { index, length: end - index, strategy, score };
}

/** 1. Exact substring matching. */
const ExactMatcher: Matcher = function* (content, find) {
	for (const index of findAllOccurrences(content, find)) {
		yield { index, length: find.length, strategy: "exact" };
	}
};

/** Compare trimmed lines while returning the corresponding original whole-line span. */
const LineTrimmedMatcher: Matcher = function* (content, find) {
	const originalLines = content.split("\n");
	const searchLines = find.split("\n");
	if (searchLines[searchLines.length - 1] === "") searchLines.pop();
	if (searchLines.length === 0) return;
	const lineOffsets = getLineOffsets(content);

	for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
		let matches = true;
		for (let j = 0; j < searchLines.length; j++) {
			if (originalLines[i + j].trim() !== searchLines[j].trim()) {
				matches = false;
				break;
			}
		}
		if (matches) {
			yield spanFromLines(content, lineOffsets, i, searchLines.length, "line-trimmed");
		}
	}
};

/** Compare fixed-line-count blocks after collapsing whitespace to one space. */
const WhitespaceNormalizedMatcher: Matcher = function* (content, find) {
	const norm = (s: string) => s.replace(/\s+/g, " ").trim();
	const normalizedFind = norm(find);
	if (normalizedFind === "") return;
	const lines = content.split("\n");
	const findLines = find.split("\n");
	const lineOffsets = getLineOffsets(content);
	for (let i = 0; i <= lines.length - findLines.length; i++) {
		const block = lines.slice(i, i + findLines.length).join("\n");
		if (norm(block) === normalizedFind) {
			yield spanFromLines(content, lineOffsets, i, findLines.length, "whitespace-normalized");
		}
	}
};

/** Compare after removing minimum common indentation while preserving relative indentation. */
const IndentationFlexibleMatcher: Matcher = function* (content, find) {
	const removeIndent = (text: string): string => {
		const lines = text.split("\n");
		const nonEmpty = lines.filter((l) => l.trim().length > 0);
		if (nonEmpty.length === 0) return text;
		const minIndent = Math.min(
			...nonEmpty.map((l) => {
				const m = l.match(/^(\s*)/);
				return m ? m[1].length : 0;
			}),
		);
		return lines.map((l) => (l.trim().length === 0 ? l : l.slice(minIndent))).join("\n");
	};

	const normalizedFind = removeIndent(find);
	const contentLines = content.split("\n");
	const findLines = find.split("\n");
	const lineOffsets = getLineOffsets(content);
	for (let i = 0; i <= contentLines.length - findLines.length; i++) {
		const block = contentLines.slice(i, i + findLines.length).join("\n");
		if (removeIndent(block) === normalizedFind) {
			yield spanFromLines(content, lineOffsets, i, findLines.length, "indentation-flexible");
		}
	}
};

/** Unescape a deliberately small set of literal escapes in oldText only. */
const EscapeNormalizedMatcher: Matcher = function* (content, find) {
	const unescape = (str: string): string =>
		str.replace(/\\(n|t|r|\\)/g, (match, captured: string) => {
			switch (captured) {
				case "n":
					return "\n";
				case "t":
					return "\t";
				case "r":
					return "\r";
				case "\\":
					return "\\";
				default:
					return match;
			}
		});

	const unescapedFind = unescape(find);
	if (unescapedFind === find) return;
	for (const index of findAllOccurrences(content, unescapedFind)) {
		yield { index, length: unescapedFind.length, strategy: "escape-normalized" };
	}
};

/**
 * 6. Match a multiline substring while ignoring horizontal indentation at line starts.
 *
 * Unlike the whole-line replacers above, this handles a find string whose first or last
 * line is only a fragment. Character offsets map back to the original content so the
 * replacement never consumes the unmatched prefix/suffix or indentation on adjacent
 * lines.
 */
const PartialLineIndentationMatcher: Matcher = function* (content, find) {
	if (!find.includes("\n")) return;

	const normalize = (
		text: string,
	): { text: string; originalStarts: number[]; originalEnds: number[] } => {
		let normalized = "";
		const originalStarts: number[] = [];
		const originalEnds: number[] = [];
		let atLineStart = true;

		for (let i = 0; i < text.length; i++) {
			const char = text[i];
			if (atLineStart && (char === " " || char === "\t")) continue;
			normalized += char;
			originalStarts.push(i);
			originalEnds.push(i + 1);
			atLineStart = char === "\n";
		}

		return { text: normalized, originalStarts, originalEnds };
	};

	const normalizedContent = normalize(content);
	const normalizedFind = normalize(find).text;
	if (normalizedFind === "") return;

	let fromIndex = 0;
	while (fromIndex <= normalizedContent.text.length - normalizedFind.length) {
		const normalizedIndex = normalizedContent.text.indexOf(normalizedFind, fromIndex);
		if (normalizedIndex === -1) break;

		const normalizedEnd = normalizedIndex + normalizedFind.length;
		const start = normalizedContent.originalStarts[normalizedIndex];
		const end = normalizedContent.originalEnds[normalizedEnd - 1];
		const lineStart = content.lastIndexOf("\n", start - 1) + 1;
		const nextNewline = content.indexOf("\n", end);
		const lineEnd = nextNewline === -1 ? content.length : nextNewline;
		const startsMidLine = content.slice(lineStart, start).trim().length > 0;
		const endsMidLine = content.slice(end, lineEnd).trim().length > 0;

		if (startsMidLine || endsMidLine) {
			yield {
				index: start,
				length: end - start,
				strategy: "partial-line-indentation",
			};
		}
		fromIndex = normalizedIndex + 1;
	}
};

const BLOCK_ANCHOR_SIMILARITY_THRESHOLD = 0.72;
const BLOCK_ANCHOR_MIN_SCORE_MARGIN = 0.08;

function lineSubstitutionCost(a: string, b: string): number {
	const left = a.trim();
	const right = b.trim();
	const maxLength = Math.max(left.length, right.length);
	if (maxLength === 0) return 0;
	return levenshtein(left, right) / maxLength;
}

function blockSimilarity(actual: string[], expected: string[]): number {
	if (actual.length === 0 && expected.length === 0) return 1;
	let previous = Array.from({ length: expected.length + 1 }, (_, index) => index);
	let current = new Array<number>(expected.length + 1);

	for (let i = 1; i <= actual.length; i++) {
		current[0] = i;
		for (let j = 1; j <= expected.length; j++) {
			current[j] = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + lineSubstitutionCost(actual[i - 1], expected[j - 1]),
			);
		}
		[previous, current] = [current, previous];
	}

	const distance = previous[expected.length];
	return Math.max(0, 1 - distance / Math.max(actual.length, expected.length, 1));
}

/** Anchor on first/last lines and score the entire middle as an aligned line sequence. */
const BlockAnchorMatcher: Matcher = function* (content, find) {
	const findLines = find.split("\n");
	if (findLines[findLines.length - 1] === "") findLines.pop();
	if (findLines.length < 3) return;
	const searchBlockSize = findLines.length;
	const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));
	const firstLine = findLines[0].trim();
	const lastLine = findLines[searchBlockSize - 1].trim();
	if (firstLine.length === 0 || lastLine.length === 0) return;
	if (firstLine === lastLine && firstLine.length < 4) return;
	const contentLines = content.split("\n");
	const lineOffsets = getLineOffsets(content);

	for (let i = 0; i < contentLines.length; i++) {
		if (contentLines[i].trim() !== firstLine) continue;
		const minBlockSize = Math.max(3, searchBlockSize - maxLineDelta);
		const maxBlockSize = searchBlockSize + maxLineDelta;
		const minEndLine = i + minBlockSize - 1;
		const maxEndLine = Math.min(contentLines.length - 1, i + maxBlockSize - 1);

		for (let endLine = minEndLine; endLine <= maxEndLine; endLine++) {
			if (contentLines[endLine].trim() !== lastLine) continue;
			const actualMiddle = contentLines.slice(i + 1, endLine);
			const expectedMiddle = findLines.slice(1, -1);
			const score = blockSimilarity(actualMiddle, expectedMiddle);
			yield spanFromLines(
				content,
				lineOffsets,
				i,
				endLine - i + 1,
				"block-anchor",
				score,
			);
		}
	}
};

// ---------------------------------------------------------------------------
// Safety check: reject blocks much larger than oldText because fuzzy strategies may overmatch.
// ---------------------------------------------------------------------------

function isDisproportionateMatch(search: string, oldString: string): boolean {
	const oldLines = oldString.split("\n").length;
	const searchLines = search.split("\n").length;
	if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
	if (oldLines === 1) return false;
	return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4);
}

// ---------------------------------------------------------------------------
// Find one unique match for a single oldText within content.
// ---------------------------------------------------------------------------

interface Match {
	index: number;
	length: number;
	strategy: StrategyName;
}

interface EditDetails {
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

const DETERMINISTIC_MATCHERS: Matcher[] = [
	ExactMatcher,
	IndentationFlexibleMatcher,
	LineTrimmedMatcher,
	WhitespaceNormalizedMatcher,
	EscapeNormalizedMatcher,
	PartialLineIndentationMatcher,
];

interface CandidateCollection {
	safe: MatchCandidate[];
	rejectedUnsafe: number;
}

function collectCandidates(
	content: string,
	oldText: string,
	candidates: Iterable<MatchCandidate>,
): CandidateCollection {
	const safe = new Map<string, MatchCandidate>();
	let rejectedUnsafe = 0;

	for (const candidate of candidates) {
		const search = content.substring(candidate.index, candidate.index + candidate.length);
		if (isDisproportionateMatch(search, oldText)) {
			rejectedUnsafe++;
			continue;
		}

		const key = `${candidate.index}:${candidate.length}`;
		const existing = safe.get(key);
		if (
			!existing ||
			(candidate.score !== undefined && candidate.score > (existing.score ?? Number.NEGATIVE_INFINITY))
		) {
			safe.set(key, candidate);
		}
	}

	return { safe: [...safe.values()], rejectedUnsafe };
}

function partialLineHint(content: string, oldText: string): string {
	const oldLines = oldText.split("\n");
	const contentLines = content.split("\n");
	const endpoints = [
		{ label: "first", text: oldLines[0].trim() },
		{ label: "last", text: oldLines[oldLines.length - 1].trim() },
	];

	const fragment = endpoints.find(
		(endpoint) =>
			endpoint.text.length > 0 &&
			contentLines.some((line) => {
				const trimmed = line.trim();
				return trimmed !== endpoint.text && trimmed.includes(endpoint.text);
			}),
	);
	if (!fragment) return "";
	return ` The ${fragment.label} line of oldText appears to be a line fragment; re-read the file and check its exact indentation and surrounding text.`;
}

export function findMatch(content: string, oldText: string, path: string): Match {
	let foundAmbiguousMatch = false;
	let rejectedUnsafe = 0;

	for (const matcher of DETERMINISTIC_MATCHERS) {
		const collected = collectCandidates(content, oldText, matcher(content, oldText));
		rejectedUnsafe += collected.rejectedUnsafe;
		if (collected.safe.length === 1) return collected.safe[0];
		if (collected.safe.length > 1) foundAmbiguousMatch = true;
	}

	const fuzzy = collectCandidates(content, oldText, BlockAnchorMatcher(content, oldText));
	rejectedUnsafe += fuzzy.rejectedUnsafe;
	const ranked = fuzzy.safe
		.filter((candidate) => candidate.score !== undefined)
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

	if ((ranked[0]?.score ?? -1) >= BLOCK_ANCHOR_SIMILARITY_THRESHOLD) {
		const best = ranked[0];
		const second = ranked[1];
		if (
			second &&
			(best.score ?? 0) - (second.score ?? 0) < BLOCK_ANCHOR_MIN_SCORE_MARGIN
		) {
			throw new Error(`Found multiple matches for oldText in ${path}. Provide more surrounding context to make it unique.`);
		}
		return best;
	}

	if (foundAmbiguousMatch) {
		throw new Error(`Found multiple matches for oldText in ${path}. Provide more surrounding context to make it unique.`);
	}
	if (rejectedUnsafe > 0) {
		throw new Error(
			`Refusing replacement in ${path}: the matched span is much larger than oldText. Re-read the file and provide the full exact oldText.`,
		);
	}
	throw new Error(
		`Could not find oldText in ${path}. It must match (exact, or via whitespace/indentation/escape-tolerant fallback).${partialLineHint(content, oldText)}`,
	);
}

function renderEditDiff(
	diff: string,
	theme: { fg: (color: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext", text: string) => string },
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

// ---------------------------------------------------------------------------
// Diff generation directly reuses Pi's built-in edit-diff.ts helpers. This keeps TUI
// line positioning and patch formatting aligned with the native edit tool. Rendering is
// intentionally local: inheriting the built-in edit renderer would run its exact-match
// preview against this extension's fuzzy-match arguments and display a transient,
// duplicate error before the real tool result.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "edit", // Registering the same name overrides the built-in edit tool.
		label: "edit",
		description:
			"Edit a single file with one targeted text replacement. oldText must identify a unique region. Matching tolerates minor whitespace, indentation, and escaping differences.",
		parameters: editSchema,
		promptSnippet: "Make one precise, fuzzy-tolerant text replacement in a file",
		promptGuidelines: [
			"Use edit for precise file edits. oldText is matched against the original file with multi-strategy fallback: exact, indentation-flexible, line-trimmed, whitespace-normalized, escape-normalized, partial-line indentation, and block-anchor fuzzy. Tab/space mixing and minor mismatches are tolerated, but still copy the original text as closely as possible.",
			"Each edit call performs exactly one oldText to newText replacement. For multiple changes, issue separate edit calls; they are executed sequentially.",
			"oldText must be unique in the file. If not unique, add more surrounding context to disambiguate.",
			"Keep oldText as small as possible while still being unique. Do not pad it with large unchanged regions.",
			"oldText must not be empty and must differ from newText.",
		],
		executionMode: "sequential", // Serialize calls to avoid concurrent writes to the same file.
		renderShell: "default",

		renderCall(args, theme) {
			const path = typeof args.path === "string" ? args.path : "";
			const title = theme.fg("toolTitle", theme.bold("edit"));
			return new Text(`${title} ${theme.fg("accent", path)}`, 0, 0);
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
			const args = input as { path?: string; oldText?: string; newText?: string };
			const path = args.path;
			const oldText = args.oldText;
			const newText = args.newText;
			if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string") {
				throw new Error("edit requires 'path', 'oldText', and 'newText' strings.");
			}
			if (oldText.length === 0) {
				throw new Error(`oldText must not be empty in ${path}.`);
			}
			if (oldText === newText) {
				throw new Error(`oldText and newText are identical in ${path}.`);
			}

			const absolutePath = resolvePath(path, ctx.cwd);

			const throwIfAborted = (): void => {
				if (signal?.aborted) throw new Error("Operation aborted");
			};
			throwIfAborted();

			// Verify that the file is readable and writable.
			try {
				await access(absolutePath, constants.R_OK | constants.W_OK);
			} catch (error: unknown) {
				const code = error instanceof Error && "code" in error ? ` (code: ${(error as NodeJS.ErrnoException).code})` : "";
				throw new Error(`Could not edit file: ${path}${code}.`);
			}
			throwIfAborted();

			const buffer = await readFile(absolutePath);
			throwIfAborted();

			const rawContent = buffer.toString("utf-8");
			const { bom, text } = stripBom(rawContent);
			const originalEnding = detectLineEnding(text);
			const content = normalizeToLF(text);

			const match = findMatch(content, normalizeToLF(oldText), path);
			throwIfAborted();

			const normalizedNewText = normalizeToLF(newText);
			const newContent =
				content.substring(0, match.index) +
				normalizedNewText +
				content.substring(match.index + match.length);

			if (newContent === content) {
				throw new Error(`No changes made to ${path}. The replacement produced identical content.`);
			}
			throwIfAborted();

			const finalContent = bom + restoreLineEndings(newContent, originalEnding);
			await writeFile(absolutePath, finalContent, "utf-8");

			const diffResult = generateDiffString(content, newContent);
			const patch = generateUnifiedPatch(path, content, newContent);
			const fallbackNote =
				match.strategy === "exact" ? "" : ` Matched using the ${match.strategy} fallback.`;
			return {
				content: [
					{
						type: "text" as const,
						text: `Successfully replaced text in ${path}.${fallbackNote}`,
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
