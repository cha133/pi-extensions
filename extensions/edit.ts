/**
 * Fuzzy edit -- 覆盖内置 edit 工具，用多策略 fallback 匹配大幅提高命中率。
 *
 * 内置 edit 只有「精确匹配 + 行尾 trim fuzzy」两层，tab/空格混用、缩进级别
 * 不一致、模型把换行写成字面 \n、首尾行对得上但中间略有出入等情况全部匹配失败，
 * 导致 agent 经常转去写临时 node 脚本。这里移植并精简 opencode 的多 Replacer 思路
 * （见 https://github.com/nicepkg/opencode 的 packages/opencode/src/tool/edit.ts）：
 *
 *   1. Exact            精确子串
 *   2. LineTrimmed      逐行 trim 后比较（忽略行首尾空白差异）
 *   3. WhitespaceNorm   \s+ 折叠成单空格后比较（tab/多空格/混排）
 *   4. IndentFlexible   去最小公共缩进后比较（整体缩进级别差异）
 *   5. EscapeNorm       反转义字面 \n \t \r 等（模型常见 quirk）
 *   6. BlockAnchor      首尾行做锚点 + 中间行 Levenshtein 相似度（≥0.65），
 *                       多候选取最高分。行数差容忍 ±25%。
 *
 * 每个 Replacer 都 yield 原始 content 的真实子串，保证后续 indexOf 定位精确、
 * 替换不会污染未编辑区域。外层逐个 yield，命中唯一匹配即采用；多匹配则继续试更
 * 严格的策略，全部失败才报 not found / multiple matches。
 *
 * 保留内置 edit 的语义：edits[] 一次性对原始内容匹配（非增量）、各 oldText 须唯一、
 * 禁止重叠、保留 BOM 与原文件行尾。diff 生成复用与内置 edit-diff.ts 相同的 `diff`
 * 包与相同的展示格式（带行号、上下文折叠、firstChangedLine 定位），TUI 渲染一致。
 *
 * 放 ~/.pi/agent/extensions/ 自动发现；同名 registerTool 覆盖内置 edit。
 * 热重载：会话内用 /reload 即可生效。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createEditTool,
	generateDiffString,
	generateUnifiedPatch,
} from "@earendil-works/pi-coding-agent";
import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// schema / description / prepareArguments 复用内置 edit，保持兼容（含旧式 oldText/newText、edits 为 JSON string 的 quirk）。cwd 仅用于取 schema，不影响 execute（execute 内用 ctx.cwd）。
const BUILTIN = createEditTool(process.cwd());

// ---------------------------------------------------------------------------
// 行尾 / BOM
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
// Levenshtein（BlockAnchor 评分用）
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
	if (a === "" || b === "") return Math.max(a.length, b.length);
	const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
		}
	}
	return matrix[a.length][b.length];
}

// ---------------------------------------------------------------------------
// Replacer：generator，yield 原始 content 的真实子串
// ---------------------------------------------------------------------------

type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

/** 1. 精确匹配。yield find 本身（若 content 含之）。 */
const ExactReplacer: Replacer = function* (content, find) {
	if (content.includes(find)) yield find;
};

/** 2. 逐行 trim 比较，命中则 yield 原始行块（保留原缩进/空白）。 */
const LineTrimmedReplacer: Replacer = function* (content, find) {
	const originalLines = content.split("\n");
	const searchLines = find.split("\n");
	if (searchLines[searchLines.length - 1] === "") searchLines.pop();
	if (searchLines.length === 0) return;

	for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
		let matches = true;
		for (let j = 0; j < searchLines.length; j++) {
			if (originalLines[i + j].trim() !== searchLines[j].trim()) {
				matches = false;
				break;
			}
		}
		if (matches) {
			let start = 0;
			for (let k = 0; k < i; k++) start += originalLines[k].length + 1;
			let end = start;
			for (let k = 0; k < searchLines.length; k++) {
				end += originalLines[i + k].length;
				if (k < searchLines.length - 1) end += 1;
			}
			yield content.substring(start, end);
		}
	}
};

/** 3. 所有空白折叠为单空格后比较（tab/多空格/混排）。 */
const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
	const norm = (s: string) => s.replace(/\s+/g, " ").trim();
	const normalizedFind = norm(find);
	if (normalizedFind === "") return;
	const lines = content.split("\n");
	const findLines = find.split("\n");
	for (let i = 0; i <= lines.length - findLines.length; i++) {
		const block = lines.slice(i, i + findLines.length).join("\n");
		if (norm(block) === normalizedFind) yield block;
	}
};

/** 4. 去最小公共缩进后比较（整体缩进级别差异）。 */
const IndentationFlexibleReplacer: Replacer = function* (content, find) {
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
	for (let i = 0; i <= contentLines.length - findLines.length; i++) {
		const block = contentLines.slice(i, i + findLines.length).join("\n");
		if (removeIndent(block) === normalizedFind) yield block;
	}
};

/** 5. 反转义字面 \n \t \r 等（模型常见 quirk）。 */
const EscapeNormalizedReplacer: Replacer = function* (content, find) {
	const unescape = (str: string): string =>
		str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, captured: string) => {
			switch (captured) {
				case "n":
					return "\n";
				case "t":
					return "\t";
				case "r":
					return "\r";
				case "'":
					return "'";
				case '"':
					return '"';
				case "`":
					return "`";
				case "\\":
					return "\\";
				case "\n":
					return "\n";
				case "$":
					return "$";
				default:
					return match;
			}
		});

	const unescapedFind = unescape(find);
	if (content.includes(unescapedFind)) yield unescapedFind;

	const lines = content.split("\n");
	const findLines = unescapedFind.split("\n");
	for (let i = 0; i <= lines.length - findLines.length; i++) {
		const block = lines.slice(i, i + findLines.length).join("\n");
		if (unescape(block) === unescapedFind) yield block;
	}
};

const BLOCK_ANCHOR_SIMILARITY_THRESHOLD = 0.65;

/** 6. 首尾行锚点 + 中间行 Levenshtein 相似度，多候选取最高分。合并 opencode BlockAnchor + ContextAware。 */
const BlockAnchorReplacer: Replacer = function* (content, find) {
	const findLines = find.split("\n");
	if (findLines.length < 3) return;
	if (findLines[findLines.length - 1] === "") findLines.pop();
	const searchBlockSize = findLines.length;
	const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));
	const firstLine = findLines[0].trim();
	const lastLine = findLines[searchBlockSize - 1].trim();
	const contentLines = content.split("\n");

	const candidates: Array<{ startLine: number; endLine: number }> = [];
	for (let i = 0; i < contentLines.length; i++) {
		if (contentLines[i].trim() !== firstLine) continue;
		for (let j = i + 2; j < contentLines.length; j++) {
			if (contentLines[j].trim() === lastLine) {
				const actualBlockSize = j - i + 1;
				if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
					candidates.push({ startLine: i, endLine: j });
				}
				break;
			}
		}
	}
	if (candidates.length === 0) return;

	const scoreCandidate = (c: { startLine: number; endLine: number }): number => {
		const actualBlockSize = c.endLine - c.startLine + 1;
		const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
		if (linesToCheck <= 0) return 1.0;
		let similarity = 0;
		for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
			const originalLine = contentLines[c.startLine + j].trim();
			const searchLine = findLines[j].trim();
			const maxLen = Math.max(originalLine.length, searchLine.length);
			if (maxLen === 0) {
				similarity += 1 / linesToCheck;
				continue;
			}
			similarity += (1 - levenshtein(originalLine, searchLine) / maxLen) / linesToCheck;
		}
		return similarity;
	};

	let bestMatch: { startLine: number; endLine: number } | null = null;
	let maxSimilarity = -1;
	for (const candidate of candidates) {
		const similarity = scoreCandidate(candidate);
		if (similarity > maxSimilarity) {
			maxSimilarity = similarity;
			bestMatch = candidate;
		}
	}

	if (bestMatch && maxSimilarity >= BLOCK_ANCHOR_SIMILARITY_THRESHOLD) {
		let start = 0;
		for (let k = 0; k < bestMatch.startLine; k++) start += contentLines[k].length + 1;
		let end = start;
		for (let k = bestMatch.startLine; k <= bestMatch.endLine; k++) {
			end += contentLines[k].length;
			if (k < bestMatch.endLine) end += 1;
		}
		yield content.substring(start, end);
	}
};

const REPLACERS: Replacer[] = [
	ExactReplacer,
	LineTrimmedReplacer,
	WhitespaceNormalizedReplacer,
	IndentationFlexibleReplacer,
	EscapeNormalizedReplacer,
	BlockAnchorReplacer,
];

// ---------------------------------------------------------------------------
// 安全检查：拒绝匹配到比 oldText 大得多的块（BlockAnchor 等模糊匹配可能误伤）
// ---------------------------------------------------------------------------

function isDisproportionateMatch(search: string, oldString: string): boolean {
	const oldLines = oldString.split("\n").length;
	const searchLines = search.split("\n").length;
	if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
	if (oldLines === 1) return false;
	return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4);
}

// ---------------------------------------------------------------------------
// 核心：对单个 oldText 在 content 中找一个唯一匹配
// ---------------------------------------------------------------------------

interface Match {
	index: number;
	length: number;
}

function findMatch(content: string, oldText: string, path: string, editIndex: number, total: number): Match {
	let notFound = true;

	for (const replacer of REPLACERS) {
		for (const search of replacer(content, oldText)) {
			const index = content.indexOf(search);
			if (index === -1) continue;
			notFound = false;
			if (isDisproportionateMatch(search, oldText)) {
				throw new Error(
					`Refusing replacement in ${path}: the matched span for edits[${editIndex}] is much larger than oldText. Re-read the file and provide the full exact oldText.`,
				);
			}
			const lastIndex = content.lastIndexOf(search);
			if (index !== lastIndex) continue; // 不唯一，试下一个 yield / 策略
			return { index, length: search.length };
		}
	}

	if (notFound) {
		const msg =
			total === 1
				? `Could not find oldText in ${path}. It must match (exact, or via whitespace/indentation/escape-tolerant fallback).`
				: `Could not find edits[${editIndex}].oldText in ${path}.`;
		throw new Error(msg);
	}
	throw new Error(
		total === 1
			? `Found multiple matches for oldText in ${path}. Provide more surrounding context to make it unique.`
			: `Found multiple matches for edits[${editIndex}].oldText in ${path}. Provide more surrounding context to make it unique.`,
	);
}

// ---------------------------------------------------------------------------
// diff 生成：直接复用 pi 内置 edit-diff.ts 的实现（同一组函数），与原生 edit 的
// TUI 渲染、行号定位、patch 格式逐字一致。pi 已把它们从 @earendil-works/pi-coding-agent
// 公共包 re-export，扩展通过该包导入即可在 pi 模块上下文运行（diff 包随之可解析）。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "edit", // 同名覆盖内置 edit
		label: "edit",
		description: BUILTIN.description,
		parameters: BUILTIN.parameters,
		prepareArguments: BUILTIN.prepareArguments,
		promptSnippet: "容错匹配的精确文件编辑（支持空白/缩进/转义/行尾归一化与首尾锚点模糊匹配）",
		promptGuidelines: [
			"Use edit for precise file edits. oldText is matched against the original file with multi-strategy fallback: exact, line-trimmed, whitespace-normalized, indentation-flexible, escape-normalized, and block-anchor fuzzy. Tab/space mixing and minor mismatches are tolerated, but still copy the original text as closely as possible.",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls.",
			"Each edits[].oldText must be unique in the file. If not unique, add more surrounding context to disambiguate.",
			"Keep edits[].oldText as small as possible while still being unique. Do not pad with large unchanged regions.",
			"edits[].oldText must not be empty and must differ from newText. Do not emit overlapping or nested edits.",
		],
		executionMode: "sequential", // 文件写入串行，避免同批 edit 并发写冲突

		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const args = input as { path?: string; edits?: Array<{ oldText?: string; newText?: string }> };
			const path = args.path;
			const edits = args.edits;
			if (typeof path !== "string" || !Array.isArray(edits) || edits.length === 0) {
				throw new Error("edit requires 'path' (string) and 'edits' (non-empty array of {oldText,newText}).");
			}

			const absolutePath = resolvePath(path, ctx.cwd);

			const throwIfAborted = (): void => {
				if (signal?.aborted) throw new Error("Operation aborted");
			};
			throwIfAborted();

			// 校验可读写
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

			// 对每个 edit 在原始 content 上找匹配
			const matched: Array<{ index: number; length: number; newText: string }> = [];
			for (let i = 0; i < edits.length; i++) {
				const edit = edits[i];
				if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
					throw new Error(`edits[${i}] in ${path} must have string oldText and newText.`);
				}
				if (edit.oldText.length === 0) {
					throw new Error(
						edits.length === 1 ? `oldText must not be empty in ${path}.` : `edits[${i}].oldText must not be empty in ${path}.`,
					);
				}
				if (edit.oldText === edit.newText) {
					throw new Error(
						edits.length === 1
							? `oldText and newText are identical in ${path}.`
							: `edits[${i}].oldText and newText are identical in ${path}.`,
					);
				}
				const m = findMatch(content, edit.oldText, path, i, edits.length);
				matched.push({ index: m.index, length: m.length, newText: normalizeToLF(edit.newText) });
			}
			throwIfAborted();

			// 重叠检查
			const sorted = [...matched].sort((a, b) => a.index - b.index);
			for (let i = 1; i < sorted.length; i++) {
				if (sorted[i - 1].index + sorted[i - 1].length > sorted[i].index) {
					const a = matched.indexOf(sorted[i - 1]);
					const b = matched.indexOf(sorted[i]);
					throw new Error(
						`edits[${a}] and edits[${b}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
					);
				}
			}

			// 倒序替换，保持 offset 稳定
			let newContent = content;
			for (let i = sorted.length - 1; i >= 0; i--) {
				const m = sorted[i];
				newContent = newContent.substring(0, m.index) + m.newText + newContent.substring(m.index + m.length);
			}

			if (newContent === content) {
				throw new Error(`No changes made to ${path}. The replacement produced identical content.`);
			}
			throwIfAborted();

			const finalContent = bom + restoreLineEndings(newContent, originalEnding);
			await writeFile(absolutePath, finalContent, "utf-8");
			throwIfAborted();

			const diffResult = generateDiffString(content, newContent);
			const patch = generateUnifiedPatch(path, content, newContent);
			return {
				content: [
					{
						type: "text" as const,
						text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
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