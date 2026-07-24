import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { complete, type ImageContent, type UserMessage } from "@earendil-works/pi-ai/compat";
import {
	createReadToolDefinition,
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
 * processed image to the vision model selected in ~/.pi/agent/view-image.json
 * and returns the description as the read result.
 */

const CONFIG_FILE = "view-image.json";

const SYSTEM_PROMPT =
	"You are an expert visual analyst. Describe the supplied image accurately and thoroughly. " +
	"Cover the main subjects, setting, composition, colors, spatial relationships, and notable details. " +
	"Transcribe visible text exactly. Do not add interpretations that are not supported by the image.";

interface VisionConfig {
	provider: string;
	model: string;
}

interface ModelWithInputs {
	input?: readonly string[];
}

interface NativeReadLikeResult {
	content: Array<{ type: string }>;
}

function configPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

async function loadVisionConfig(): Promise<VisionConfig> {
	const path = configPath();
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error: unknown) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: undefined;
		if (code === "ENOENT") {
			throw new Error(
				`Vision fallback is not configured. Create "${path}" with ` +
					'{"provider":"<provider>","model":"<model-id>"}.',
			);
		}
		throw new Error(
			`Could not read vision fallback config "${path}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error: unknown) {
		throw new Error(
			`Invalid JSON in vision fallback config "${path}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Vision fallback config "${path}" must be a JSON object.`);
	}

	const config = value as { provider?: unknown; model?: unknown };
	if (typeof config.provider !== "string" || !config.provider.trim()) {
		throw new Error(`Vision fallback config "${path}" must contain a non-empty string "provider".`);
	}
	if (typeof config.model !== "string" || !config.model.trim()) {
		throw new Error(`Vision fallback config "${path}" must contain a non-empty string "model".`);
	}

	return { provider: config.provider.trim(), model: config.model.trim() };
}

function modelSupportsImages(model: ModelWithInputs | undefined): boolean {
	return model?.input?.includes("image") ?? false;
}

export function needsVisionFallback(result: NativeReadLikeResult, model: ModelWithInputs | undefined): boolean {
	return !modelSupportsImages(model) && result.content.some((part) => part.type === "image");
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
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<{ content: [{ type: "text"; text: string }]; details: ReadToolDetails | undefined }> {
	let config: VisionConfig;
	try {
		config = await loadVisionConfig();
	} catch (error: unknown) {
		return fallbackFailure(error instanceof Error ? error.message : String(error));
	}

	const modelName = `${config.provider}/${config.model}`;
	const model = ctx.modelRegistry.find(config.provider, config.model);
	if (!model) {
		return fallbackFailure(
			`configured model "${modelName}" was not found; check "${configPath()}" and reload pi after model changes`,
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
			{ type: "text", text: "Describe this image in detail." },
			image,
		],
		timestamp: Date.now(),
	};

	try {
		const response = await complete(
			model,
			{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
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

		pi.registerTool({
			...nativeRead,
			description: nativeRead.description.replace(
				"Images are sent as attachments.",
				"Images are automatically sent either to the current model when it supports image input " +
					"or to the configured fallback vision model.",
			),
			promptSnippet: "Read text files and inspect images with automatic vision fallback",
			promptGuidelines: [
				...(nativeRead.promptGuidelines ?? []),
				"Use read for both text files and local images.",
				"Do not look for or call a separate image-viewing tool; read automatically routes images to a capable model.",
			],
			async execute(toolCallId, params, signal, onUpdate, toolCtx) {
				const result = await nativeExecute(toolCallId, params, signal, onUpdate, toolCtx);
				if (!needsVisionFallback(result, toolCtx.model)) {
					return result;
				}

				const image = findImage(result);
				if (!image) {
					return result;
				}
				return describeImage(image, signal, toolCtx);
			},
		});
	});
}
