import { join } from "node:path";
import { complete, type ImageContent, type UserMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
	createReadToolDefinition,
	CONFIG_DIR_NAME,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	SettingsManager,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadToolDetails,
} from "@earendil-works/pi-coding-agent";

/**
 * read -- override pi's built-in reader with transparent vision fallback.
 *
 * The native read definition still owns path resolution, text handling, image
 * detection, image resizing, truncation, and rendering. When it returns an
 * image that the current model cannot consume, this wrapper sends that already
 * processed image to the vision model selected by the `vision` object in
 * ~/.pi/agent/settings.json
 * and returns the description as the read result.
 */

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
	/** Natural-language region to prioritize, such as "upper-right corner". */
	region?: string;
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
	content: Array<{ type: string }>;
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
	const query = options?.query?.trim() || "Describe this image accurately.";
	const region = options?.region?.trim();
	if (!region) {
		return query;
	}
	return [`Focus region: ${region}`, "", `Request: ${query}`].join("\n");
}

function findImage(result: NativeReadLikeResult): ImageContent | undefined {
	return result.content.find((part): part is ImageContent => part.type === "image");
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
		const response = await complete(
			model,
			{ systemPrompt: SYSTEM_PROMPTS[options?.detail ?? "standard"], messages: [userMessage] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal,
			},
		);

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

export default function (pi: ExtensionAPI) {
	let registeredCwd: string | undefined;

	pi.on("session_start", (_event, ctx) => {
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
					region: Type.Optional(
						Type.String({
							description:
								'Natural-language area to prioritize, such as "upper-right corner" or "the red dialog"',
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
					"or to the configured fallback vision model. For image questions, response depth, or regional " +
					"focus, pass the optional image.query, image.detail, and image.region fields.",
			),
			promptSnippet: "Read text files and inspect images with automatic vision fallback",
			promptGuidelines: [
				...(nativeRead.promptGuidelines ?? []),
				"Use read for both text files and local images.",
				"When the user asks a specific question about an image, pass it in image.query.",
				"Use image.region for a natural-language area to prioritize and image.detail when response depth matters.",
				"Do not look for or call a separate image-viewing tool; read automatically routes images to a capable model.",
			],
			async execute(toolCallId, params, signal, onUpdate, toolCtx) {
				const { image: imageOptions, ...nativeParams } = params;
				const result = await nativeExecute(toolCallId, nativeParams, signal, onUpdate, toolCtx);
				if (!needsVisionFallback(result, toolCtx.model)) {
					return result;
				}

				const image = findImage(result);
				if (!image) {
					return result;
				}
				return describeImage(image, imageOptions, signal, toolCtx);
			},
		});
	});
}
