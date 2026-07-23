import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	keyHint,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * view_image -- add vision support for text-only models (inspired by mcp-sight).
 *
 * - baseUrl and model are fixed to Xiaomi MiMo's OpenAI-compatible endpoint.
 * - apiKey is read from MIMO_API_KEY.
 * - If the current model already accepts "image" input, remove this tool from the active
 *   set. Keep it visible for text-only models. Synchronize on session_start/model_select.
 */

const TOOL_NAME = "view_image";
const BASE_URL = "https://api.xiaomimimo.com/v1";
const MODEL = "mimo-v2.5";

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
	truncated: boolean;
	totalLines: number;
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
			const apiKey = process.env.MIMO_API_KEY;
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: "MIMO_API_KEY is not set. Configure the environment variable before calling view_image.",
						},
					],
					details: {
						path: params.image_path,
						detailLevel: (params.detail_level ?? "standard") as DetailLevel,
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
						detailLevel: (params.detail_level ?? "standard") as DetailLevel,
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
						detailLevel: (params.detail_level ?? "standard") as DetailLevel,
						truncated: false,
						totalLines: 1,
					} satisfies ViewImageDetails,
				};
			}

			const detailLevel = (params.detail_level ?? "standard") as DetailLevel;
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

			const dataUrl = `data:${mediaType};base64,${buffer.toString("base64")}`;

			try {
				const res = await fetch(`${BASE_URL}/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify({
						model: MODEL,
						messages: [
							{ role: "system", content: systemPrompt },
							{
								role: "user",
								content: [
									{ type: "text", text: userPrompt },
									{ type: "image_url", image_url: { url: dataUrl } },
								],
							},
						],
					}),
					signal,
				});

				const payload = (await res.json()) as {
					error?: { message?: string };
					choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
				};

				if (!res.ok || payload.error) {
					const msg = payload.error?.message ?? `${res.status} ${res.statusText}`;
					return {
						content: [
							{
								type: "text",
								text: `Vision model API error: ${msg}. Check MIMO_API_KEY and endpoint connectivity.`,
							},
						],
						details: {
							path: absPath,
							detailLevel,
							truncated: false,
							totalLines: 1,
						} satisfies ViewImageDetails,
					};
				}

				const rawContent = payload.choices?.[0]?.message?.content;
				let text = "";
				if (typeof rawContent === "string") {
					text = rawContent;
				} else if (Array.isArray(rawContent)) {
					text = rawContent
						.filter((part) => part.type === "text" && part.text)
						.map((part) => part.text)
						.join("\n");
				}
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
								"Check MIMO_API_KEY and network connectivity.",
						},
					],
					details: {
						path: absPath,
						detailLevel,
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
