/**
 * Vision read -- override Pi's built-in reader with transparent vision fallback.
 *
 * The native read definition still owns path resolution, text handling, image
 * detection, image resizing, truncation, and rendering. When it returns an
 * image that the current model cannot consume, this wrapper sends that already
 * processed image to the vision model selected by the `vision` object in
 * ~/.pi/agent/settings.json and returns the description as the read result.
 *
 * Text results are reformatted as hashline snapshots: a sixteen-hex whole-file
 * tag followed by 1-indexed `LINE:TEXT` rows. The edit extension consumes those
 * anchors so models can address several changes without reproducing old text.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
	stream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type ImageContent,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	createReadToolDefinition,
	CONFIG_DIR_NAME,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	SettingsManager,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadToolDetails,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	type HashlineState,
	HASHLINE_TAG_LENGTH,
	HASHLINE_TAG_PATTERN,
} from "./hashline-state.js";

const HASHLINE_HEADER_RE = new RegExp(`^\\[(.+)#(${HASHLINE_TAG_PATTERN})\\]$`);

const SYSTEM_PROMPTS = {
	brief:
		"You are a concise visual analyst. Answer in 1-2 short sentences. " +
		"Focus only on the requested subject or the most important visible content.",
	standard:
		"You are a careful visual analyst. Answer the request accurately with enough visible detail to be useful. " +
		"Cover relevant subjects, setting, composition, colors, spatial relationships, and text. " +
		"Do not add interpretations that are not supported by the image.",
	detailed:
		"You are an expert visual analyst. Give an exhaustive, precise answer grounded in the supplied image. " +
		"Cover all details relevant to the request, including background, composition, colors, lighting, textures, " +
		"spatial relationships, subtle elements, and exact transcription of visible text.",
} as const;

type ImageDetail = keyof typeof SYSTEM_PROMPTS;

export interface ImageReadOptions {
	/** Natural-language question or instruction for the image. */
	query?: string;
	/** Requested depth of the visual response. */
	detail?: ImageDetail;
}

interface VisionConfig {
	provider: string;
	model: string;
}

interface SettingsWithVision {
	vision?: unknown;
}

interface ModelWithInputs {
	input?: readonly string[];
}

interface NativeReadLikeResult {
	content: Array<{ type: string; text?: string }>;
}

export type VisionReadPhase = "sending" | "thinking" | "reasoning" | "replying";

export interface VisionReadStatus {
	phase: VisionReadPhase;
	summary: string;
}

interface VisionReadDetails extends ReadToolDetails {
	visionStatus?: VisionReadStatus;
}

interface HashlineReadOptions {
	path: string;
	offset?: number;
	limit?: number;
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripBom(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function resolveLocalPath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return join(homedir(), path.slice(2));
	}
	return resolve(cwd, path);
}

/** Must stay byte-for-byte compatible with edit.ts's optimistic-concurrency tag. */
export function computeHashlineTag(text: string): string {
	return createHash("sha256")
		.update(normalizeToLF(stripBom(text)), "utf8")
		.digest("hex")
		.slice(0, HASHLINE_TAG_LENGTH)
		.toUpperCase();
}

function splitFileLines(content: string): string[] {
	if (content === "") return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

function displayedHashlineRange(output: string): { start: number; end: number } | undefined {
	const numbers = output
		.split("\n")
		.map((line) => /^(\d+):/.exec(line))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => Number(match[1]));
	if (numbers.length === 0) return undefined;
	return { start: numbers[0], end: numbers[numbers.length - 1] };
}

interface PersistedGrounding {
	kind: "read" | "write";
	path: string;
	tag: string;
	lines: number[];
}

function persistedGroundingFromEntry(entry: SessionEntry): PersistedGrounding | undefined {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined;
	const message = entry.message;
	if (message.isError || (message.toolName !== "read" && message.toolName !== "write")) {
		return undefined;
	}
	const text = message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const rows = normalizeToLF(text).split("\n");
	const header = HASHLINE_HEADER_RE.exec(rows[0] ?? "");
	if (!header) return undefined;
	const lines = rows
		.slice(1)
		.map((row) => /^([1-9]\d*):/.exec(row))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => Number(match[1]));
	return {
		kind: message.toolName,
		path: header[1],
		tag: header[2].toUpperCase(),
		lines,
	};
}

/** Rebuild session-local grounding from successful read/write results on the active branch. */
export async function restoreHashlineState(
	entries: readonly SessionEntry[],
	sessionId: string,
	cwd: string,
	state: HashlineState,
): Promise<number> {
	state.clearSession(sessionId);
	const records = entries
		.map(persistedGroundingFromEntry)
		.filter((record): record is PersistedGrounding => record !== undefined);
	const liveFiles = new Map<string, { lineCount: number; tag: string } | undefined>();
	let restored = 0;

	for (const record of records) {
		const absolutePath = resolveLocalPath(record.path, cwd);
		let live = liveFiles.get(absolutePath);
		if (!liveFiles.has(absolutePath)) {
			try {
				const raw = await readFile(absolutePath, "utf8");
				const content = normalizeToLF(stripBom(raw));
				live = {
					lineCount: splitFileLines(content).length,
					tag: computeHashlineTag(content),
				};
			} catch {
				live = undefined;
			}
			liveFiles.set(absolutePath, live);
		}
		if (!live || live.tag !== record.tag) continue;

		if (record.kind === "write" || live.lineCount === 0) {
			state.recordComplete(
				sessionId,
				absolutePath,
				record.tag,
				live.lineCount,
			);
			restored++;
			continue;
		}
		for (const line of record.lines) {
			state.recordRange(sessionId, absolutePath, record.tag, live.lineCount, line, line);
		}
		if (record.lines.length > 0) restored++;
	}
	return restored;
}

/**
 * Format a complete text snapshot into the bounded, model-facing hashline shape.
 * Prefix bytes count toward the cap and source lines are never partially emitted.
 */
export function formatHashlineRead(
	rawContent: string,
	options: HashlineReadOptions,
): string {
	const content = normalizeToLF(stripBom(rawContent));
	const allLines = splitFileLines(content);
	const startLine = Math.max(1, Math.floor(options.offset ?? 1));
	const startIndex = startLine - 1;
	const requestedLimit =
		options.limit === undefined
			? allLines.length - startIndex
			: Math.max(0, Math.floor(options.limit));
	const endIndex = Math.min(allLines.length, startIndex + requestedLimit);
	const header = `[${options.path}#${computeHashlineTag(content)}]`;

	if (allLines.length === 0) {
		return `${header}\n[File is empty. Use INS.HEAD or INS.TAIL to add content.]`;
	}

	const output = [header];
	let outputBytes = Buffer.byteLength(header, "utf8");
	let displayed = 0;
	for (
		let index = startIndex;
		index < endIndex && displayed < DEFAULT_MAX_LINES;
		index++
	) {
		const row = `${index + 1}:${allLines[index]}`;
		const rowBytes = Buffer.byteLength(row, "utf8") + 1;
		if (outputBytes + rowBytes > DEFAULT_MAX_BYTES) break;
		output.push(row);
		outputBytes += rowBytes;
		displayed++;
	}

	if (displayed === 0) {
		const lineBytes = Buffer.byteLength(allLines[startIndex] ?? "", "utf8");
		output.push(
			`[Line ${startLine} is ${formatSize(lineBytes)}, too large to emit as a complete editable hashline row.]`,
		);
		return output.join("\n");
	}

	const nextIndex = startIndex + displayed;
	if (nextIndex < endIndex) {
		output.push(
			`[Showing lines ${startLine}-${nextIndex} of ${allLines.length}. Use offset=${nextIndex + 1} to continue.]`,
		);
	} else if (endIndex < allLines.length) {
		output.push(
			`[${allLines.length - endIndex} more lines in file. Use offset=${endIndex + 1} to continue.]`,
		);
	}
	return output.join("\n");
}

function isNativeImageResult(result: NativeReadLikeResult): boolean {
	if (result.content.some((part) => part.type === "image")) return true;
	return result.content.some(
		(part) =>
			part.type === "text" &&
			typeof part.text === "string" &&
			part.text.startsWith("Read image file ["),
	);
}

function settingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function readVisionObject(value: unknown, source: string): Record<string, unknown> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`The "vision" setting in ${source} must be a JSON object.`);
	}
	return value as Record<string, unknown>;
}

export function resolveVisionConfig(
	globalValue: unknown,
	projectValue: unknown,
	globalSource = "global settings",
	projectSource = "project settings",
): VisionConfig {
	const globalVision = readVisionObject(globalValue, globalSource);
	const projectVision = readVisionObject(projectValue, projectSource);
	const config = { ...(globalVision ?? {}), ...(projectVision ?? {}) };

	if (!globalVision && !projectVision) {
		throw new Error(
			`Vision fallback is not configured. Add ` +
				`"vision": {"provider":"<provider>","model":"<model-id>"} to "${settingsPath()}".`,
		);
	}
	if (typeof config.provider !== "string" || !config.provider.trim()) {
		throw new Error('The "vision" setting must contain a non-empty string "provider".');
	}
	if (typeof config.model !== "string" || !config.model.trim()) {
		throw new Error('The "vision" setting must contain a non-empty string "model".');
	}

	return { provider: config.provider.trim(), model: config.model.trim() };
}

function loadVisionConfig(ctx: ExtensionContext): VisionConfig {
	const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
		projectTrusted: ctx.isProjectTrusted(),
	});
	const errors = settingsManager.drainErrors();
	if (errors.length > 0) {
		const summary = errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; ");
		throw new Error(`Could not load pi settings: ${summary}`);
	}

	const globalSettings = settingsManager.getGlobalSettings() as SettingsWithVision;
	const projectSettings = settingsManager.getProjectSettings() as SettingsWithVision;
	return resolveVisionConfig(
		globalSettings.vision,
		projectSettings.vision,
		settingsPath(),
		join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"),
	);
}

function modelSupportsImages(model: ModelWithInputs | undefined): boolean {
	return model?.input?.includes("image") ?? false;
}

export function needsVisionFallback(result: NativeReadLikeResult, model: ModelWithInputs | undefined): boolean {
	return !modelSupportsImages(model) && result.content.some((part) => part.type === "image");
}

export function buildVisionPrompt(options: ImageReadOptions | undefined): string {
	return options?.query?.trim() || "Describe this image accurately.";
}

function findImage(result: NativeReadLikeResult): ImageContent | undefined {
	return result.content.find((part): part is ImageContent => part.type === "image");
}

function appendBounded(current: string, chunk: string): string {
	const combined = current + chunk;
	if (Buffer.byteLength(combined, "utf8") <= DEFAULT_MAX_BYTES) return combined;
	return Buffer.from(combined, "utf8").subarray(-DEFAULT_MAX_BYTES).toString("utf8");
}

function recentParagraphLine(value: string, fallback: string): string {
	const paragraphs = value.trim().split(/\r?\n\s*\r?\n/);
	const line = (paragraphs.at(-1) ?? "")
		.split(/\r?\n/, 1)[0]
		.replace(/\s+/g, " ")
		.trim();
	return line || fallback;
}

export function formatVisionStatus(status: VisionReadStatus): string {
	switch (status.phase) {
		case "sending":
		case "thinking":
			return status.summary;
		case "reasoning":
			return `Reasoning: ${status.summary}`;
		case "replying":
			return `Replying: ${status.summary}`;
	}
}

/** Reduce the vision model event stream to the latest useful one-line activity. */
export class VisionProgressTracker {
	private thinking = "";
	private reply = "";
	private status: VisionReadStatus = { phase: "sending", summary: "Sending image to model..." };

	get current(): VisionReadStatus {
		return this.status;
	}

	handle(event: AssistantMessageEvent): VisionReadStatus | undefined {
		switch (event.type) {
			case "start":
				return this.set({ phase: "thinking", summary: "Model is thinking..." });
			case "thinking_delta":
				this.thinking = appendBounded(this.thinking, event.delta);
				return this.set({
					phase: "reasoning",
					summary: recentParagraphLine(this.thinking, "Model is thinking..."),
				});
			case "text_delta":
				this.reply = appendBounded(this.reply, event.delta);
				return this.set({
					phase: "replying",
					summary: recentParagraphLine(this.reply, "Model is replying..."),
				});
			default:
				return undefined;
		}
	}

	private set(status: VisionReadStatus): VisionReadStatus | undefined {
		if (status.phase === this.status.phase && status.summary === this.status.summary) return undefined;
		this.status = status;
		return status;
	}
}

function fallbackFailure(message: string): { content: [{ type: "text"; text: string }]; details: undefined } {
	return {
		content: [{ type: "text", text: `[Vision fallback failed: ${message}]` }],
		details: undefined,
	};
}

async function describeImage(
	image: ImageContent,
	options: ImageReadOptions | undefined,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	onUpdate: AgentToolUpdateCallback<VisionReadDetails | undefined> | undefined,
): Promise<{ content: [{ type: "text"; text: string }]; details: ReadToolDetails | undefined }> {
	let config: VisionConfig;
	try {
		config = loadVisionConfig(ctx);
	} catch (error: unknown) {
		return fallbackFailure(error instanceof Error ? error.message : String(error));
	}

	const modelName = `${config.provider}/${config.model}`;
	const model = ctx.modelRegistry.find(config.provider, config.model);
	if (!model) {
		return fallbackFailure(
			`configured model "${modelName}" was not found; check "${settingsPath()}" and reload pi after model changes`,
		);
	}
	if (!modelSupportsImages(model)) {
		return fallbackFailure(`configured model "${modelName}" does not declare image input support`);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return fallbackFailure(`could not authenticate "${modelName}": ${auth.error}`);
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [
			{ type: "text", text: buildVisionPrompt(options) },
			image,
		],
		timestamp: Date.now(),
	};

	try {
		const progress = new VisionProgressTracker();
		let pendingStatus: VisionReadStatus | undefined;
		let statusTimer: ReturnType<typeof setTimeout> | undefined;
		let lastStatusUpdate = 0;
		const flushStatus = () => {
			if (!pendingStatus || !onUpdate) return;
			onUpdate({ content: [], details: { visionStatus: pendingStatus } });
			pendingStatus = undefined;
			lastStatusUpdate = Date.now();
		};
		const publishStatus = (status: VisionReadStatus, immediate = false) => {
			if (!onUpdate) return;
			pendingStatus = status;
			const elapsed = Date.now() - lastStatusUpdate;
			if (immediate || elapsed >= 100) {
				if (statusTimer) clearTimeout(statusTimer);
				statusTimer = undefined;
				flushStatus();
				return;
			}
			if (!statusTimer) {
				statusTimer = setTimeout(() => {
					statusTimer = undefined;
					flushStatus();
				}, 100 - elapsed);
			}
		};
		publishStatus(progress.current, true);

		const responseStream = stream(
			model,
			{ systemPrompt: SYSTEM_PROMPTS[options?.detail ?? "standard"], messages: [userMessage] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal,
			},
		);
		let response: AssistantMessage | undefined;
		try {
			for await (const event of responseStream) {
				const status = progress.handle(event);
				if (status) publishStatus(status);
				if (event.type === "done") response = event.message;
				if (event.type === "error") response = event.error;
			}
		} finally {
			if (statusTimer) clearTimeout(statusTimer);
			flushStatus();
		}
		if (!response) {
			return fallbackFailure(`model "${modelName}" ended without a final response`);
		}

		if (response.stopReason === "aborted") {
			return fallbackFailure("cancelled");
		}
		if (response.stopReason === "error") {
			return fallbackFailure(
				`model "${modelName}" returned an error: ${response.errorMessage ?? "unknown provider error"}`,
			);
		}

		const description = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (!description) {
			return fallbackFailure(`model "${modelName}" returned no text`);
		}

		const truncation = truncateHead(description, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		return {
			content: [{ type: "text", text: truncation.content }],
			details: truncation.truncated ? { truncation } : undefined,
		};
	} catch (error: unknown) {
		if (signal?.aborted) {
			return fallbackFailure("cancelled");
		}
		return fallbackFailure(
			`request to "${modelName}" failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function registerRead(pi: ExtensionAPI, state: HashlineState): void {
	let registeredCwd: string | undefined;

	pi.on("session_shutdown", (_event, ctx) => {
		state.clearSession(ctx.sessionManager.getSessionId());
	});
	pi.on("session_tree", async (_event, ctx) => {
		await restoreHashlineState(
			ctx.sessionManager.getBranch(),
			ctx.sessionManager.getSessionId(),
			ctx.cwd,
			state,
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		await restoreHashlineState(
			ctx.sessionManager.getBranch(),
			ctx.sessionManager.getSessionId(),
			ctx.cwd,
			state,
		);
		if (registeredCwd === ctx.cwd) {
			return;
		}
		registeredCwd = ctx.cwd;

		const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		});
		const nativeRead = createReadToolDefinition(ctx.cwd, {
			autoResizeImages: settingsManager.getImageAutoResize(),
		});
		const nativeExecute = nativeRead.execute;
		const parameters = Type.Object({
			...nativeRead.parameters.properties,
			image: Type.Optional(
				Type.Object({
					query: Type.Optional(
						Type.String({
							description:
								"Natural-language question or instruction for the image, such as asking what text appears",
						}),
					),
					detail: Type.Optional(
						Type.Union([Type.Literal("brief"), Type.Literal("standard"), Type.Literal("detailed")], {
							description: "Visual response depth; defaults to standard",
						}),
					),
				}),
			),
		});

		pi.registerTool({
			...nativeRead,
			parameters,
			description: nativeRead.description.replace(
				"Images are sent as attachments.",
				"Images are automatically sent either to the current model when it supports image input " +
					"or to the configured fallback vision model. Put image questions, instructions, and areas to " +
					"focus in image.query; use image.detail to select the response depth.",
			),
			promptSnippet:
				"Read numbered, version-tagged text snapshots and inspect images with automatic vision fallback",
			promptGuidelines: [
				...(nativeRead.promptGuidelines ?? []),
				"Use read for both text files and local images.",
				"Text reads begin with [PATH#TAG] and show LINE:TEXT rows. Copy that header and the original line numbers into edit.",
				"When the user asks a specific question about an image, pass it in image.query.",
				"Include any area to prioritize in image.query, and use image.detail when response depth matters.",
				"Do not look for or call a separate image-viewing tool; read automatically routes images to a capable model.",
			],
			renderResult(result, options, theme, context) {
				const details = result.details as VisionReadDetails | undefined;
				if (options.isPartial && details?.visionStatus) {
					return new Text(theme.fg("muted", formatVisionStatus(details.visionStatus)), 0, 0);
				}
				return nativeRead.renderResult!(
					result as Parameters<NonNullable<typeof nativeRead.renderResult>>[0],
					options,
					theme,
					context,
				);
			},
			async execute(toolCallId, params, signal, onUpdate, toolCtx) {
				const { image: imageOptions, ...nativeParams } = params;
				const result = await nativeExecute(toolCallId, nativeParams, signal, onUpdate, toolCtx);
				if (needsVisionFallback(result, toolCtx.model)) {
					const image = findImage(result);
					if (!image) {
						return result;
					}
					return describeImage(image, imageOptions, signal, toolCtx, onUpdate);
				}
				if (isNativeImageResult(result)) {
					return result;
				}

				const textPath = nativeParams.path;
				const absolutePath = resolveLocalPath(textPath, toolCtx.cwd);
				const rawContent = await readFile(absolutePath, "utf8");
				const formatted = formatHashlineRead(rawContent, {
					path: textPath,
					offset: nativeParams.offset,
					limit: nativeParams.limit,
				});
				const normalized = normalizeToLF(stripBom(rawContent));
				const lineCount = splitFileLines(normalized).length;
				const displayed = displayedHashlineRange(formatted);
				if (displayed) {
					state.recordRange(
						toolCtx.sessionManager.getSessionId(),
						absolutePath,
						computeHashlineTag(normalized),
						lineCount,
						displayed.start,
						displayed.end,
					);
				} else if (lineCount === 0) {
					// Record the empty revision so INS.HEAD/INS.TAIL can initialize it.
					state.recordComplete(
						toolCtx.sessionManager.getSessionId(),
						absolutePath,
						computeHashlineTag(normalized),
						0,
					);
				}
				return {
					content: [
						{
							type: "text" as const,
							text: formatted,
						},
					],
					details: result.details,
				};
			},
		});
	});
}
