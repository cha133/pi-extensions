/**
 * Hashline-aware write -- wrap pi's built-in full-file writer.
 *
 * Ordinary `{ path, content }` calls retain native directory creation, mutation
 * queuing, cancellation, and rendering. Successful writes prepend a fresh sixteen-hex
 * hashline header computed from the successfully committed content, so a following edit can use
 * the new version without another read.
 *
 * When content is a complete hashline snapshot copied from read, the wrapper verifies
 * that it starts at line 1, has consecutive numbered rows, contains no truncation
 * notice, targets the same path, and still matches the live file tag. Only then are the
 * header and line prefixes removed. The existing BOM, line-ending convention, and
 * final-newline state are preserved for this copied-snapshot rewrite.
 */

import {
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	HASHLINE_TAG_LENGTH,
	HASHLINE_TAG_PATTERN,
	recordCompleteHashlineContent,
} from "./lib/hashline-state.js";

const HEADER_RE = new RegExp(`^\\[(.+)#(${HASHLINE_TAG_PATTERN})\\]$`);
const NUMBERED_LINE_RE = /^([1-9]\d*):(.*)$/;
const READ_NOTICE_RE =
	/^\[(?:Showing lines |\d+ more lines in file\.|Line \d+ is |File is empty\.)/;

interface CopiedHashlineSnapshot {
	path: string;
	tag: string;
	content: string;
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripBom(text: string): { bom: string; text: string } {
	return text.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: text.slice(1) }
		: { bom: "", text };
}

function resolveLocalPath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return join(homedir(), path.slice(2));
	}
	return resolve(cwd, path);
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function detectLineEnding(text: string): "\r\n" | "\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Must stay byte-for-byte compatible with read.ts and edit.ts. */
export function computeHashlineTag(text: string): string {
	return createHash("sha256")
		.update(normalizeToLF(stripBom(text).text), "utf8")
		.digest("hex")
		.slice(0, HASHLINE_TAG_LENGTH)
		.toUpperCase();
}

/**
 * Recognize only a complete copied read snapshot. Non-hashline content returns
 * undefined and remains untouched; malformed/partial snapshots fail closed.
 */
export function parseCopiedHashlineSnapshot(
	content: string,
): CopiedHashlineSnapshot | undefined {
	const lines = normalizeToLF(content).split("\n");
	const header = HEADER_RE.exec(lines[0] ?? "");
	if (!header) return undefined;

	const body: string[] = [];
	let expectedLine = 1;
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index];
		if (index === lines.length - 1 && line === "") continue;
		if (READ_NOTICE_RE.test(line)) {
			throw new Error(
				"Refusing to write copied hashline content from a partial or non-editable read. Read the complete file or provide clean full-file content.",
			);
		}
		const numbered = NUMBERED_LINE_RE.exec(line);
		if (!numbered) {
			throw new Error(
				`Copied hashline content has an invalid row at input line ${index + 1}. Every source row must be LINE:TEXT from a complete read.`,
			);
		}
		const actualLine = Number(numbered[1]);
		if (actualLine !== expectedLine) {
			throw new Error(
				`Copied hashline content must start at line 1 and remain consecutive; expected line ${expectedLine}, got ${actualLine}.`,
			);
		}
		body.push(numbered[2]);
		expectedLine++;
	}
	if (body.length === 0) {
		throw new Error(
			"Copied hashline content contains no source rows. To write an empty file, pass an empty content string.",
		);
	}

	return {
		path: header[1],
		tag: header[2].toUpperCase(),
		content: body.join("\n"),
	};
}

function prepareCopiedSnapshotContent(
	snapshot: CopiedHashlineSnapshot,
	targetPath: string,
	cwd: string,
	currentRaw: string,
): string {
	const snapshotPath = resolveLocalPath(snapshot.path, cwd);
	const absoluteTarget = resolveLocalPath(targetPath, cwd);
	if (!samePath(snapshotPath, absoluteTarget)) {
		throw new Error(
			`Copied hashline header targets ${snapshot.path}, but write targets ${targetPath}. Provide clean full-file content when copying to another path.`,
		);
	}

	const currentTag = computeHashlineTag(currentRaw);
	if (currentTag !== snapshot.tag) {
		throw new Error(
			`Stale hashline tag for ${targetPath}: content has #${snapshot.tag}, current file is #${currentTag}. Re-read before rewriting the file.`,
		);
	}

	const { bom, text } = stripBom(currentRaw);
	const normalizedCurrent = normalizeToLF(text);
	const finalNewline = normalizedCurrent.endsWith("\n");
	const normalizedOutput =
		snapshot.content + (finalNewline && snapshot.content.length > 0 ? "\n" : "");
	return bom + restoreLineEndings(normalizedOutput, detectLineEnding(text));
}

function prependResultHeader(
	result: { content: Array<{ type: string; text?: string }> },
	path: string,
	tag: string,
	stripped: boolean,
): void {
	const header = `[${path}#${tag}]`;
	const note = stripped ? "\nRemoved verified hashline read prefixes before writing." : "";
	const firstText = result.content.find(
		(part): part is { type: string; text: string } =>
			part.type === "text" && typeof part.text === "string",
	);
	if (firstText) {
		firstText.text = `${header}\n${firstText.text}${note}`;
	} else {
		result.content.unshift({ type: "text", text: `${header}${note}` });
	}
}

export default function (pi: ExtensionAPI): void {
	let registeredCwd: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (registeredCwd === ctx.cwd) return;
		registeredCwd = ctx.cwd;

		const nativeWrite = createWriteToolDefinition(ctx.cwd);
		const nativeExecute = nativeWrite.execute;
		pi.registerTool({
			...nativeWrite,
			description:
				`${nativeWrite.description} Successful writes return a fresh [PATH#TAG] for hashline edit. ` +
				"Complete numbered snapshots copied from read are verified and stripped safely.",
			promptSnippet: "Create or completely rewrite files and return a fresh hashline tag",
			promptGuidelines: [
				...(nativeWrite.promptGuidelines ?? []),
				"After a successful write, the returned [PATH#TAG] and the line numbers of the content you just wrote can be used immediately by edit. Re-read first if the final content is uncertain.",
				"Prefer clean full-file content. A complete numbered read snapshot may be rewritten directly; partial, stale, non-consecutive, or cross-path snapshots are rejected.",
			],
			async execute(toolCallId, params, signal, onUpdate, toolCtx) {
				const copied = parseCopiedHashlineSnapshot(params.content);
				let content = params.content;
				if (copied) {
					let currentRaw: string;
					try {
						currentRaw = await readFile(
							resolveLocalPath(params.path, toolCtx.cwd),
							"utf8",
						);
					} catch {
						throw new Error(
							`Cannot verify copied hashline content for ${params.path}. The target must be the existing file named by its header.`,
						);
					}
					content = prepareCopiedSnapshotContent(
						copied,
						params.path,
						toolCtx.cwd,
						currentRaw,
					);
				}

				const result = await nativeExecute(
					toolCallId,
					{ ...params, content },
					signal,
					onUpdate,
					toolCtx,
				);
				const absolutePath = resolveLocalPath(params.path, toolCtx.cwd);
				// Native write commits this exact string while holding Pi's mutation queue.
				// Base the returned revision on it so a later competing write makes edit fail
				// stale instead of accidentally grounding the model in unknown disk content.
				const normalizedWritten = normalizeToLF(stripBom(content).text);
				const writtenLines = normalizedWritten === ""
					? 0
					: normalizedWritten.split("\n").length - (normalizedWritten.endsWith("\n") ? 1 : 0);
				recordCompleteHashlineContent(
					toolCtx.sessionManager.getSessionId(),
					absolutePath,
					computeHashlineTag(normalizedWritten),
					writtenLines,
				);
				prependResultHeader(
					result,
					params.path,
					computeHashlineTag(normalizedWritten),
					copied !== undefined,
				);
				return result;
			},
		});
	});
}
