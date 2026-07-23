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
 * Exa Web Search / Fetch -- call Exa's public MCP endpoint
 * (https://mcp.exa.ai/mcp) without an API key.
 *
 * Pi has no built-in MCP client, but an extension can implement one. This file uses a
 * hand-written Streamable HTTP client instead of @modelcontextprotocol/sdk, keeping the
 * extension dependency-free and self-contained for auto-discovery and /reload.
 *
 * Important endpoint behavior verified in practice:
 * - Exa returns text/event-stream (SSE) for every JSON-RPC request, formatted as
 *   `event: message\ndata: {json}`. Parse SSE rather than calling JSON.parse directly;
 *   see parseSse.
 * - initialize returns Mcp-Session-Id. Include it in subsequent requests; if the session
 *   expires, reset it and retry once.
 * - Do not make network requests in the factory, which would delay startup and could
 *   trigger without a session. Initialize lazily on the first tool call and cache the
 *   session ID at module scope.
 * - Tool names are fixed to web_search_exa / web_fetch_exa and parameters match Exa's
 *   public schema:
 *     search: { query, numResults }
 *     fetch:  { urls, maxCharacters }
 *   Avoid tools/list at runtime because Exa's v3.2.1 tool set is stable, saving a round trip.
 * - Truncate output to Pi's built-in limit of 2,000 lines or 50 KB, and pass through the
 *   abort signal so Esc can cancel requests. Truncation affects the content sent to the
 *   LLM; renderResult independently shows a collapsed summary or the first N preview lines.
 */

const ENDPOINT = "https://mcp.exa.ai/mcp";
const PROTOCOL_VERSION = "2025-03-26";

/** Number of leading lines shown when the collapsed TUI result is expanded. */
const SEARCH_PREVIEW_LINES = 20;
const FETCH_PREVIEW_LINES = 30;

/** Parse an MCP Streamable HTTP SSE response by joining all `data:` lines before JSON.parse. */
function parseSse(text: string): any {
	const data = text
		.split("\n")
		.filter((l) => l.startsWith("data:"))
		.map((l) => l.slice(5).trimStart())
		.join("");
	if (!data) throw new Error("Exa MCP returned an empty SSE response");
	return JSON.parse(data);
}

let sessionId: string | null = null;

/** Lazily initialize on the first call, send the initialized notification, and cache the session ID. */
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
				clientInfo: { name: "pi-web-search", version: "1.0" },
			},
		}),
		signal,
	});
	sessionId = res.headers.get("mcp-session-id");
	const payload = parseSse(await res.text());
	if (payload.error) throw new Error(`Exa MCP initialization failed: ${JSON.stringify(payload.error)}`);
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

/** Call an Exa MCP tool; reset an expired session and retry once. */
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
		if (payload.error) throw new Error(`Exa MCP ${name} failed: ${JSON.stringify(payload.error)}`);
		return payload.result;
	}
	throw new Error(`Exa MCP ${name} still failed after retry`);
}

/** Flatten an MCP tool result's content array into plain text. */
function extractText(result: any): string {
	if (!result?.content) return JSON.stringify(result ?? {});
	return result.content.map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
}

/** Collapsed summary: `<label> · <stats> [· truncated] (expand key hint)`. */
function summaryLine(theme: any, main: string, stat: string, truncated: boolean): string {
	let line = theme.fg("success", `${main} · ${stat}`);
	if (truncated) line += theme.fg("warning", " · truncated");
	line += theme.fg("dim", ` (${keyHint("app.tools.expand", "expand")})`);
	return line;
}

interface SearchDetails {
	truncated: boolean;
	resultCount: number;
	totalLines: number;
}

interface FetchDetails {
	truncated: boolean;
	urlCount: number;
	totalLines: number;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web through Exa and return titles, URLs, and content excerpts from the most relevant pages. " +
			"Use it for current information, news, facts, people, companies, or any other topic. " +
			"Write query as a natural-language description of the ideal page rather than keywords (for example, 'blog post comparing React and Vue performance'). " +
			"Output is truncated to 2,000 lines or 50 KB.",
		promptSnippet: "Search the web through Exa for current information",
		promptGuidelines: [
			"Use web_search instead of relying on memory when the user asks about current information, breaking news, online facts, or anything whose freshness is uncertain.",
			"After web_search, use web_fetch when you need to read a selected URL in depth.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language query describing the ideal page rather than keywords" }),
			numResults: Type.Optional(Type.Number({ description: "Number of results to return; defaults to 5", minimum: 1 })),
		}),

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("web_search "));
			const q = args.query.length > 60 ? `${args.query.slice(0, 57)}...` : args.query;
			text += theme.fg("accent", `"${q}"`);
			if (args.numResults) text += theme.fg("dim", ` · ${args.numResults}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);

			const details = result.details as SearchDetails | undefined;
			const count = details?.resultCount ?? 0;
			const truncated = details?.truncated ?? false;
			const summary = summaryLine(theme, "Exa", `${count} results`, truncated);
			if (!expanded) return new Text(summary, 0, 0);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const lines = text.split("\n");
			let out = summary;
			for (const line of lines.slice(0, SEARCH_PREVIEW_LINES)) {
				out += `\n${theme.fg("toolOutput", line)}`;
			}
			if (lines.length > SEARCH_PREVIEW_LINES) {
				out += `\n${theme.fg("muted", `... ${lines.length - SEARCH_PREVIEW_LINES} more lines`)}`;
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
			// Each Exa result begins with "Title: ". Count against the untruncated text for accuracy.
			const resultCount = (raw.match(/^Title: /gm) || []).length;
			return {
				content: [{ type: "text", text: t.content }],
				details: {
					truncated: t.truncated,
					resultCount,
					totalLines: t.totalLines,
				} satisfies SearchDetails,
			};
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch clean text from specific URLs through Exa. Use it to read results selected with web_search in depth. " +
			"Accepts one or more URLs. Output is truncated to 2,000 lines or 50 KB.",
		promptSnippet: "Fetch clean text from specific URLs through Exa",
		parameters: Type.Object({
			urls: Type.Array(Type.String(), { description: "URLs to fetch" }),
			maxCharacters: Type.Optional(
				Type.Number({ description: "Maximum characters returned per URL; defaults to 3,000" }),
			),
		}),

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("web_fetch "));;
			text += theme.fg("accent", `${args.urls.length} url${args.urls.length > 1 ? "s" : ""}`);
			if (args.urls[0]) {
				const u = args.urls[0].length > 50 ? `${args.urls[0].slice(0, 47)}...` : args.urls[0];
				text += theme.fg("dim", ` ${u}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);

			const details = result.details as FetchDetails | undefined;
			const urlCount = details?.urlCount ?? 0;
			const truncated = details?.truncated ?? false;
			const summary = summaryLine(theme, "Exa", `fetched ${urlCount} url${urlCount > 1 ? "s" : ""}`, truncated);
			if (!expanded) return new Text(summary, 0, 0);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const lines = text.split("\n");
			let out = summary;
			for (const line of lines.slice(0, FETCH_PREVIEW_LINES)) {
				out += `\n${theme.fg("toolOutput", line)}`;
			}
			if (lines.length > FETCH_PREVIEW_LINES) {
				out += `\n${theme.fg("muted", `... ${lines.length - FETCH_PREVIEW_LINES} more lines`)}`;
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
				} satisfies FetchDetails,
			};
		},
	});
}
