import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	keyHint,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * view_image -- add vision support for text-only models (inspired by mcp-sight).
 *
 * - The vision provider and model are selected in ~/.pi/agent/view-image.json.
 * - The model and its authentication are resolved through pi's model registry.
 * - If the current model already accepts "image" input, remove this tool from the active
 *   set. Keep it visible for text-only models. Synchronize on session_start/model_select.
 */

const TOOL_NAME = "view_image";
const CONFIG_FILE = "view-image.json";

const MIME_MAP: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".tiff": "image/tiff",
	".tif": "image/tiff",
	".ico": "image/x-icon",
	".heic": "image/heic",
	".heif": "image/heif",
};

const SYSTEM_PROMPTS: Record<"brief" | "standard" | "detailed", string> = {
	brief:
		"You are a concise image describer. Reply in 1-2 short sentences. " +
		"Focus only on the most important subject and action in the image. " +
		"Be direct and brief.",
	standard:
		"You are a helpful image describer. Describe the image in detail - " +
		"cover main subjects, composition, colors, setting, and any notable elements. " +
		"Be thorough but focused. Do not add interpretation beyond what is visible.",
	detailed:
		"You are an expert visual analyst. Provide an extremely thorough, " +
		"comprehensive description. Cover: main subjects, background, composition, " +
		"lighting/contrast, colors/palette, textures, mood/atmosphere, " +
		"spatial relationships, any text visible (transcribe exactly), " +
		"and subtle details that might be overlooked. Be exhaustive.",
};

const PREVIEW_LINES = 20;

function modelSupportsImage(model: { input?: readonly string[] } | undefined): boolean {
	return !!model?.input?.includes("image");
}

function syncToolVisibility(pi: ExtensionAPI, model: { input?: readonly string[] } | undefined): void {
	const active = pi.getActiveTools();
	const currentlyActive = active.includes(TOOL_NAME);
	const shouldShow = !modelSupportsImage(model);

	if (shouldShow && !currentlyActive) {
		pi.setActiveTools([...active, TOOL_NAME]);
	} else if (!shouldShow && currentlyActive) {
		pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	}
}

function resolveImagePath(imagePath: string, cwd: string): string {
	return isAbsolute(imagePath) ? imagePath : resolve(cwd, imagePath);
}

function getMediaType(filePath: string): string | null {
	return MIME_MAP[extname(filePath).toLowerCase()] ?? null;
}

type DetailLevel = "brief" | "standard" | "detailed";

interface ViewImageDetails {
	path: string;
	detailLevel: DetailLevel;
	model?: string;
	truncated: boolean;
	totalLines: number;
}

interface ViewImageConfig {
	provider: string;
	model: string;
}

function configPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

async function loadConfig(): Promise<ViewImageConfig> {
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
				`Vision model is not configured. Create "${path}" with ` +
					'{"provider":"<provider>","model":"<model-id>"}.',
			);
		}
		throw new Error(
			`Could not read vision model config "${path}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error: unknown) {
		throw new Error(
			`Invalid JSON in vision model config "${path}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Vision model config "${path}" must be a JSON object.`);
	}
	const config = value as { provider?: unknown; model?: unknown };
	if (typeof config.provider !== "string" || !config.provider.trim()) {
		throw new Error(`Vision model config "${path}" must contain a non-empty string "provider".`);
	}
	if (typeof config.model !== "string" || !config.model.trim()) {
		throw new Error(`Vision model config "${path}" must contain a non-empty string "model".`);
	}

	return { provider: config.provider.trim(), model: config.model.trim() };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "View Image",
		description:
			"Describe a local image with a vision model when the primary model cannot read images. " +
			"Pass an absolute path or one relative to cwd, with optional prompt, context, and detail_level. " +
			"Supports JPEG, PNG, GIF, WebP, BMP, SVG, TIFF, ICO, HEIC, and HEIF. " +
			"Output is truncated to 2,000 lines or 50 KB.",
		promptSnippet: "Describe local images when the primary model lacks vision",
		promptGuidelines: [
			"When the primary model cannot read images directly, use view_image to describe screenshots, photos, or other local images instead of guessing their contents.",
			"Resolve user-provided relative paths against the working directory; prefer absolute paths when practical.",
		],
		parameters: Type.Object({
			image_path: Type.String({
				description: "Image path, either absolute or relative to the current working directory",
			}),
			prompt: Type.Optional(
				Type.String({
					description: 'Specific question or instruction for the vision model. Defaults to "Describe this image in detail."',
				}),
			),
			context: Type.Optional(
				Type.String({
					description: "Conversation context or the user's original question, to clarify the ultimate goal",
				}),
			),
			detail_level: Type.Optional(
				Type.Union([Type.Literal("brief"), Type.Literal("standard"), Type.Literal("detailed")], {
					description:
						"Description depth: brief = 1-2 sentences, standard = normally detailed, detailed = exhaustive analysis. Defaults to standard.",
				}),
			),
		}),

		renderCall(args, theme) {
			const p = args.image_path.length > 50 ? `...${args.image_path.slice(-47)}` : args.image_path;
			let text = theme.fg("toolTitle", theme.bold("view_image "));
			text += theme.fg("accent", p);
			if (args.detail_level) text += theme.fg("dim", ` · ${args.detail_level}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Viewing..."), 0, 0);

			const details = result.details as ViewImageDetails | undefined;
			const truncated = details?.truncated ?? false;
			let summary = theme.fg("success", "View Image");
			if (details?.detailLevel) summary += theme.fg("dim", ` · ${details.detailLevel}`);
			if (details?.model) summary += theme.fg("dim", ` · ${details.model}`);
			if (truncated) summary += theme.fg("warning", " · truncated");
			summary += theme.fg("dim", ` (${keyHint("app.tools.expand", "expand")})`);
			if (!expanded) return new Text(summary, 0, 0);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const lines = text.split("\n");
			let out = summary;
			for (const line of lines.slice(0, PREVIEW_LINES)) {
				out += `\n${theme.fg("toolOutput", line)}`;
			}
			if (lines.length > PREVIEW_LINES) {
				out += `\n${theme.fg("muted", `... ${lines.length - PREVIEW_LINES} more lines`)}`;
			}
			return new Text(out, 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			const detailLevel = (params.detail_level ?? "standard") as DetailLevel;
			let config: ViewImageConfig;
			try {
				config = await loadConfig();
			} catch (error: unknown) {
				return {
					content: [
						{
							type: "text",
							text: error instanceof Error ? error.message : String(error),
						},
					],
					details: {
						path: params.image_path,
						detailLevel,
						truncated: false,
						totalLines: 1,
					} satisfies ViewImageDetails,
				};
			}

			const modelName = `${config.provider}/${config.model}`;
			const model = ctx.modelRegistry.find(config.provider, config.model);
			if (!model) {
				return {
					content: [
						{
							type: "text",
							text:
								`Configured vision model "${modelName}" was not found. ` +
								`Check "${configPath()}" and ensure the model is available in pi.`,
						},
					],
					details: {
						path: params.image_path,
						detailLevel,
						model: modelName,
						truncated: false,
						totalLines: 1,
					} satisfies ViewImageDetails,
				};
			}
			if (!modelSupportsImage(model)) {
				return {
					content: [
						{
							type: "text",
							text:
								`Configured vision model "${modelName}" does not declare image input support. ` +
								'Choose a model whose "input" includes "image".',
						},
					],
					details: {
						path: params.image_path,
						detailLevel,
						model: modelName,
						truncated: false,
						totalLines: 1,
					} satisfies ViewImageDetails,
				};
			}

			const absPath = resolveImagePath(params.image_path, ctx.cwd);
			const mediaType = getMediaType(absPath);
			if (!mediaType) {
				const ext = extname(absPath).toLowerCase() || "(no extension)";
				return {
					content: [
						{
							type: "text",
							text:
								`Unsupported image format "${ext}". ` +
								"Supported formats: JPEG, PNG, GIF, WebP, BMP, SVG, TIFF, ICO, HEIC, and HEIF.",
						},
					],
					details: {
						path: absPath,
						detailLevel,
						model: modelName,
						truncated: false,
						totalLines: 1,
					} satisfies ViewImageDetails,
				};
			}

			let buffer: Buffer;
			try {
				buffer = await readFile(absPath);
			} catch (err: unknown) {
				return {
					content: [
						{
							type: "text",
							text:
								`Could not read image "${absPath}": ${err instanceof Error ? err.message : String(err)}. ` +
								"Make sure the path exists and is readable.",
						},
					],
					details: {
						path: absPath,
						detailLevel,
						model: modelName,
						truncated: false,
						totalLines: 1,
					} satisfies ViewImageDetails,
				};
			}

			const systemPrompt = SYSTEM_PROMPTS[detailLevel];
			let userPrompt = params.prompt || "Describe this image in detail.";
			if (params.context) {
				userPrompt = [
					"Background context (the user is asking about this):",
					params.context,
					"",
					"Specific request:",
					userPrompt,
				].join("\n");
			}

			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Could not authenticate configured vision model "${modelName}": ${auth.error}`,
							},
						],
						details: {
							path: absPath,
							detailLevel,
							model: modelName,
							truncated: false,
							totalLines: 1,
						} satisfies ViewImageDetails,
					};
				}

				const userMessage: UserMessage = {
					role: "user",
					content: [
						{ type: "text", text: userPrompt },
						{ type: "image", data: buffer.toString("base64"), mimeType: mediaType },
					],
					timestamp: Date.now(),
				};
				const response = await complete(
					model,
					{ systemPrompt, messages: [userMessage] },
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						env: auth.env,
						signal,
					},
				);

				if (response.stopReason === "aborted") {
					return {
						content: [{ type: "text", text: "Cancelled" }],
						details: {
							path: absPath,
							detailLevel,
							model: modelName,
							truncated: false,
							totalLines: 1,
						} satisfies ViewImageDetails,
					};
				}
				if (response.stopReason === "error") {
					return {
						content: [
							{
								type: "text",
								text:
									`Vision model "${modelName}" failed: ` +
									(response.errorMessage ?? "the provider returned an unknown error"),
							},
						],
						details: {
							path: absPath,
							detailLevel,
							model: modelName,
							truncated: false,
							totalLines: 1,
						} satisfies ViewImageDetails,
					};
				}

				let text = response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				if (!text) text = "(vision model returned no content)";

				const t = truncateHead(text, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				return {
					content: [{ type: "text", text: t.content }],
					details: {
						path: absPath,
						detailLevel,
						model: modelName,
						truncated: t.truncated,
						totalLines: t.totalLines,
					} satisfies ViewImageDetails,
				};
			} catch (err: unknown) {
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Cancelled" }],
						details: {
							path: absPath,
							detailLevel,
							model: modelName,
							truncated: false,
							totalLines: 1,
						} satisfies ViewImageDetails,
					};
				}
				return {
					content: [
						{
							type: "text",
							text:
								`Vision model request failed: ${err instanceof Error ? err.message : String(err)}. ` +
								`Check the configuration for "${modelName}" and network connectivity.`,
						},
					],
					details: {
						path: absPath,
						detailLevel,
						model: modelName,
						truncated: false,
						totalLines: 1,
					} satisfies ViewImageDetails,
				};
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		syncToolVisibility(pi, ctx.model);
	});

	pi.on("model_select", (event) => {
		syncToolVisibility(pi, event.model);
	});
}
