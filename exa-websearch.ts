import { Type } from "typebox";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	keyHint,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Exa Web Search / Fetch -- 调用 Exa 公共 MCP 端点（https://mcp.exa.ai/mcp），免 API key。
 *
 * pi 不内置 MCP，但扩展可以自己当 MCP client。这里手写 Streamable HTTP 调用，
 * 不引入 @modelcontextprotocol/sdk，保持单文件零依赖（放 ~/.pi/agent/extensions/ 自动发现、/reload 热重载）。
 *
 * 关键点（已实测端点行为）：
 * - Exa 端点对每个 JSON-RPC 请求返回 text/event-stream（SSE），格式 `event: message\ndata: {json}`，
 *   必须解析 SSE 而非直接 JSON.parse。见 parseSse。
 * - initialize 返回 Mcp-Session-Id，后续请求带上；session 失效时重置并重试一次。
 * - 不在 factory 里发网络请求（会拖慢启动 / 在无 session 的调用里误触），
 *   lazy initialize：首次 tool 调用时才握手，session id 缓存在模块作用域。
 * - 工具名硬编码 web_search_exa / web_fetch_exa，参数对齐 Exa 公共 schema：
 *     search: { query, numResults }
 *     fetch:  { urls, maxCharacters }
 *   运行时不调 tools/list（Exa 工具集稳定 v3.2.1，省一个往返）。
 * - 输出截断到 2000 行或 50KB（pi 内置上限），透传 signal 支持 Esc 取消。
 *   注意：截断只影响给 LLM 的 content；给用户看的 TUI 渲染走 renderResult，默认折叠摘要、展开预览前 N 行。
 *     LLM 始终拿到截断后的全文（content 不变），折叠只是 TUI 显示层。
 */

const ENDPOINT = "https://mcp.exa.ai/mcp";
const PROTOCOL_VERSION = "2025-03-26";

/** 折叠态展开后，TUI 预览的前 N 行（全文已存进 content 给 LLM，这里只是显示层）。 */
const SEARCH_PREVIEW_LINES = 20;
const FETCH_PREVIEW_LINES = 30;

/** 解析 MCP Streamable HTTP 的 SSE 响应：收集所有 `data:` 行拼接后 JSON.parse。 */
function parseSse(text: string): any {
	const data = text
		.split("\n")
		.filter((l) => l.startsWith("data:"))
		.map((l) => l.slice(5).trimStart())
		.join("");
	if (!data) throw new Error("Exa MCP 返回了空 SSE 响应");
	return JSON.parse(data);
}

let sessionId: string | null = null;

/** lazy 握手：首次调用时 initialize + 发 initialized 通知，缓存 session id。 */
async function ensureInitialized(signal?: AbortSignal): Promise<void> {
	if (sessionId) return;
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-exa-websearch", version: "1.0" },
			},
		}),
		signal,
	});
	sessionId = res.headers.get("mcp-session-id");
	const payload = parseSse(await res.text());
	if (payload.error) throw new Error(`Exa MCP initialize 失败: ${JSON.stringify(payload.error)}`);
	await fetch(ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		signal,
	});
}

let reqId = 1;

/** 调用 Exa MCP 工具；session 失效（服务端重启等）时自动重置并重试一次。 */
async function callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
	await ensureInitialized(signal);
	for (let attempt = 0; attempt < 2; attempt++) {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: ++reqId,
				method: "tools/call",
				params: { name, arguments: args },
			}),
			signal,
		});
		const payload = parseSse(await res.text());
		const errMsg: string = payload.error?.message ?? "";
		if (payload.error && attempt === 0 && /session|invalid|expired|unauthor/i.test(errMsg)) {
			sessionId = null;
			await ensureInitialized(signal);
			continue;
		}
		if (payload.error) throw new Error(`Exa MCP ${name} 失败: ${JSON.stringify(payload.error)}`);
		return payload.result;
	}
	throw new Error(`Exa MCP ${name} 重试后仍失败`);
}

/** 把 MCP tool result 的 content[] 拼成纯文本。 */
function extractText(result: any): string {
	if (!result?.content) return JSON.stringify(result ?? {});
	return result.content.map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
}

/** 折叠态摘要行：`<主标签> · <统计> [· 已截断] (展开键提示)`。 */
function summaryLine(theme: any, main: string, stat: string, truncated: boolean): string {
	let line = theme.fg("success", `${main} · ${stat}`);
	if (truncated) line += theme.fg("warning", " · 已截断");
	line += theme.fg("dim", ` (${keyHint("app.tools.expand", "展开")})`);
	return line;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "exa_web_search",
		label: "Exa Web Search",
		description:
			"通过 Exa 搜索网络，返回最相关页面的标题、URL 与内容摘要。用于查当前信息、新闻、事实、人物、公司等任何主题。" +
			"query 写自然语言描述理想页面而非关键词（如 'blog post comparing React and Vue performance'）。" +
			"输出截断到 2000 行或 50KB。",
		promptSnippet: "通过 Exa 搜索网络获取当前信息",
		promptGuidelines: [
			"当用户问到当前信息、最新新闻、网络事实，或你不确定时效性的内容时，用 exa_web_search 而不是凭记忆回答。",
			"需要深入读某个 URL 的正文时，在 exa_web_search 之后再调 exa_web_fetch。",
		],
		parameters: Type.Object({
			query: Type.String({ description: "自然语言查询，描述理想页面而非关键词" }),
			numResults: Type.Optional(Type.Number({ description: "返回结果数，默认 5", minimum: 1 })),
		}),

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("exa_web_search "));
			const q = args.query.length > 60 ? `${args.query.slice(0, 57)}...` : args.query;
			text += theme.fg("accent", `"${q}"`);
			if (args.numResults) text += theme.fg("dim", ` · ${args.numResults}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);

			const count: number = result.details?.resultCount ?? 0;
			const truncated: boolean = result.details?.truncated ?? false;
			const summary = summaryLine(theme, "Exa", `${count} 条结果`, truncated);
			if (!expanded) return new Text(summary, 0, 0);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const lines = text.split("\n");
			let out = summary;
			for (const line of lines.slice(0, SEARCH_PREVIEW_LINES)) {
				out += `\n${theme.fg("toolOutput", line)}`;
			}
			if (lines.length > SEARCH_PREVIEW_LINES) {
				out += `\n${theme.fg("muted", `... 还有 ${lines.length - SEARCH_PREVIEW_LINES} 行`)}`;
			}
			return new Text(out, 0, 0);
		},

		async execute(_toolCallId, params, signal) {
			const result = await callTool(
				"web_search_exa",
				{ query: params.query, numResults: params.numResults ?? 5 },
				signal,
			);
			const raw = extractText(result);
			const t = truncateHead(raw, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			// Exa 每条结果以 "Title: " 开头，按行首计数。用截断前的 raw 计数更准。
			const resultCount = (raw.match(/^Title: /gm) || []).length;
			return {
				content: [{ type: "text", text: t.content }],
				details: { truncated: t.truncated, resultCount, totalLines: t.totalLines },
			};
		},
	});

	pi.registerTool({
		name: "exa_web_fetch",
		label: "Exa Web Fetch",
		description:
			"通过 Exa 抓取指定 URL 的正文（clean text）。用于在 exa_web_search 选中某条结果后深入阅读。" +
			"输入一个或多个 URL，返回干净文本。输出截断到 2000 行或 50KB。",
		promptSnippet: "通过 Exa 抓取指定 URL 的正文",
		parameters: Type.Object({
			urls: Type.Array(Type.String(), { description: "要抓取的 URL 列表" }),
			maxCharacters: Type.Optional(
				Type.Number({ description: "每个 URL 最多返回的字符数，默认 3000" }),
			),
		}),

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("exa_web_fetch "));
			text += theme.fg("accent", `${args.urls.length} url${args.urls.length > 1 ? "s" : ""}`);
			if (args.urls[0]) {
				const u = args.urls[0].length > 50 ? `${args.urls[0].slice(0, 47)}...` : args.urls[0];
				text += theme.fg("dim", ` ${u}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);

			const urlCount: number = result.details?.urlCount ?? 0;
			const truncated: boolean = result.details?.truncated ?? false;
			const summary = summaryLine(theme, "Exa", `fetched ${urlCount} url${urlCount > 1 ? "s" : ""}`, truncated);
			if (!expanded) return new Text(summary, 0, 0);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const lines = text.split("\n");
			let out = summary;
			for (const line of lines.slice(0, FETCH_PREVIEW_LINES)) {
				out += `\n${theme.fg("toolOutput", line)}`;
			}
			if (lines.length > FETCH_PREVIEW_LINES) {
				out += `\n${theme.fg("muted", `... 还有 ${lines.length - FETCH_PREVIEW_LINES} 行`)}`;
			}
			return new Text(out, 0, 0);
		},

		async execute(_toolCallId, params, signal) {
			const result = await callTool(
				"web_fetch_exa",
				{ urls: params.urls, maxCharacters: params.maxCharacters ?? 3000 },
				signal,
			);
			const raw = extractText(result);
			const t = truncateHead(raw, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			return {
				content: [{ type: "text", text: t.content }],
				details: {
					truncated: t.truncated,
					urlCount: params.urls.length,
					totalLines: t.totalLines,
				},
			};
		},
	});
}
