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
 * view_image -- 给纯文本模型补视觉能力（参考 mcp-sight）。
 *
 * - baseUrl / model 写死：Xiaomi MiMo OpenAI-compatible 端点
 * - apiKey 从 MIMO_API_KEY 读取
 * - 若当前模型 input 已含 "image"（原生多模态），从 active tools 里摘掉本工具；
 *   纯文本模型则保持可见。session_start / model_select 时同步。
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
			"用视觉模型描述本地图片文件内容。当前主模型不支持读图时使用本工具。" +
			"传入图片路径（绝对路径或相对 cwd），可选 prompt / context / detail_level。" +
			"支持 JPEG、PNG、GIF、WebP、BMP、SVG、TIFF、ICO、HEIC、HEIF。" +
			"输出截断到 2000 行或 50KB。",
		promptSnippet: "用视觉模型描述本地图片（主模型无读图能力时）",
		promptGuidelines: [
			"当前主模型不能直接读图时，用 view_image 描述截图、照片或本地图片，不要猜测图片内容。",
			"用户给出相对路径时按工作目录解析；优先传绝对路径更稳妥。",
		],
		parameters: Type.Object({
			image_path: Type.String({
				description: "图片路径（绝对路径，或相对当前工作目录）",
			}),
			prompt: Type.Optional(
				Type.String({
					description: '给视觉模型的具体问题或指令。默认 "Describe this image in detail."',
				}),
			),
			context: Type.Optional(
				Type.String({
					description: "对话背景 / 用户原始问题，帮助视觉模型理解最终目的",
				}),
			),
			detail_level: Type.Optional(
				Type.Union([Type.Literal("brief"), Type.Literal("standard"), Type.Literal("detailed")], {
					description:
						"描述粒度：brief=1-2 句，standard=常规详细，detailed=穷尽分析。默认 standard。",
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
			if (truncated) summary += theme.fg("warning", " · 已截断");
			summary += theme.fg("dim", ` (${keyHint("app.tools.expand", "展开")})`);
			if (!expanded) return new Text(summary, 0, 0);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const lines = text.split("\n");
			let out = summary;
			for (const line of lines.slice(0, PREVIEW_LINES)) {
				out += `\n${theme.fg("toolOutput", line)}`;
			}
			if (lines.length > PREVIEW_LINES) {
				out += `\n${theme.fg("muted", `... 还有 ${lines.length - PREVIEW_LINES} 行`)}`;
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
							text: "MIMO_API_KEY 未设置。请在环境变量中配置后再调用 view_image。",
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
								`不支持的图片格式 "${ext}"。` +
								`支持：JPEG、PNG、GIF、WebP、BMP、SVG、TIFF、ICO、HEIC、HEIF。`,
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
								`无法读取图片 "${absPath}": ${err instanceof Error ? err.message : String(err)}。` +
								`请确认路径存在且可读。`,
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
								text: `视觉模型 API 错误: ${msg}。检查 MIMO_API_KEY 与端点可达性。`,
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
				if (!text) text = "(视觉模型返回空内容)";

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
						content: [{ type: "text", text: "已取消" }],
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
								`视觉模型请求失败: ${err instanceof Error ? err.message : String(err)}。` +
								`检查 MIMO_API_KEY 与网络。`,
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
