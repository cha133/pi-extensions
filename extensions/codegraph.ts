/**
 * codegraph -- pi 没有内建 MCP，这个扩展充当一个 stdio MCP client，把 codegraph
 * 的 codegraph_explore 工具桥接成 pi 原生工具，让 LLM 像调用内置工具一样调用它。
 *
 * 工具始终可见（session_start 时无条件加入 activeTools），不再按 .codegraph/
 * 是否存在门控。即便会话目录无索引也暴露工具：spawn 的 codegraph server 在无
 * 默认项目时照常运行，靠每次调用的 projectPath 解析目标库（agent 传了就查对应
 * .codegraph，没传则 codegraph 抛 NotIndexedError 引导补上）。
 *
 * 实现：spawn `codegraph serve --mcp` 子进程（不传 --path，靠 spawn 的 cwd
 * 选项让 codegraph 从 process.cwd() 向上找 .codegraph/；这样唯一可能含空格的
 * 是 cwd，它不经过 shell 参数拼接，天然安全），走换行分隔的 JSON-RPC 2.0
 * （codegraph 的 StdioTransport 即此格式，见 src/mcp/transport.ts）。子进程懒启动
 * （首次工具调用时才 spawn + initialize 握手），session_shutdown 时 kill。
 * 单进程服务整个会话的所有工具调用，用 id 多路复用并发请求。
 *
 * 只暴露 codegraph_explore（作者测过 agent 行为后故意收窄到一个强工具：一次
 * explore 调用就返回相关符号源码 + 调用路径 + 影响范围，一排窄工具反而让模型
 * 选错）。codegraph 其余 7 个只读工具（search/callers/callees/impact/node/
 * status/files）不桥接--本扩展只服务我一个人，不需要。
 *
 * 参考：~/.pi/agent/extensions/view-image.ts（动态启停工具的 setActiveTools 模式）、
 * web-search.ts（手写 MCP client 的 lazy initialize 思路）。
 */

import { spawn, type ChildProcess } from "node:child_process";
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
 * codegraph_explore 工具的 label + description + 参数 schema。
 * 描述与 schema 忠实抄自 codegraph 源码 src/mcp/tools.ts（v1.5.0），保证与
 * 安装的 codegraph 行为一致。工具集稳定，故硬编码而非运行时 tools/list 反射。
 */
const PROJECT_PATH_DESC =
	"Absolute path to the project to query (or any directory inside it) - " +
	"codegraph uses the nearest .codegraph/ index at or above that path. " +
	"Omit to use this session's default project. Pass it to query a second " +
	"codebase, or when the server root has no index of its own (e.g. a " +
	"monorepo where only sub-projects are indexed, so there is no default project).";

const projectPath = () =>
	Type.Optional(Type.String({ description: PROJECT_PATH_DESC }));

/** 折叠态预览的前 N 行（全文已进 content 给 LLM，这里只是 TUI 显示层）。 */
const PREVIEW_LINES = 40;

/** 折叠态摘要行：`<主标签> · <统计> [· 已截断] (展开键提示)`。 */
function summaryLine(theme: any, main: string, stat: string, truncated: boolean): string {
	let line = theme.fg("success", `${main} · ${stat}`);
	if (truncated) line += theme.fg("warning", " · 已截断");
	line += theme.fg("dim", ` (${keyHint("app.tools.expand", "展开")})`);
	return line;
}

// ---------------------------------------------------------------------------
// stdio MCP client
// ---------------------------------------------------------------------------

interface PendingCall {
	resolve: (result: any) => void;
	reject: (error: Error) => void;
}

/**
 * 一个 codegraph MCP 子进程的 thin client：懒启动、initialize 握手、
 * tools/call 多路复用。会话级单例，session_shutdown 时 stop()。
 */
class CodeGraphMcpClient {
	private child: ChildProcess | null = null;
	private buf = "";
	private nextId = 1;
	private pending = new Map<number, PendingCall>();
	private initialized = false;
	private startingPromise: Promise<void> | null = null;
	private spawnCwd: string;
	private binary: string;

	constructor(spawnCwd: string) {
		this.spawnCwd = spawnCwd;
		this.binary = process.env.CODEGRAPH_BIN ?? "codegraph";
	}

	/** 懒启动：首次调用 spawn + initialize。并发调用只启动一次。 */
	private async ensureReady(signal?: AbortSignal): Promise<void> {
		if (this.child && !this.child.killed && this.initialized) return;
		if (this.startingPromise) {
			await this.startingPromise;
			return;
		}
		this.startingPromise = this.start(signal);
		try {
			await this.startingPromise;
		} finally {
			this.startingPromise = null;
		}
	}

	private start(signal?: AbortSignal, forceShell = false): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			// 不传 --path：唯一可能含空格的是 cwd，而 spawn 的 options.cwd 直接
			// 设子进程工作目录、不经过 shell 参数拼接，天然安全。codegraph
			// serve --mcp 会从 process.cwd() 向上找最近的 .codegraph/。
			const args = ["serve", "--mcp"];
			if (process.env.CODEGRAPH_NO_WATCH) args.push("--no-watch");

			// 优先 shell:false（scoop 的 codegraph.exe / unix 脚本可直接 spawn，
			// 避开 Node 的 DEP0190 shell 参数拼接警告）；ENOENT 才回落 shell:true
			// （npm 全局装的 .cmd shim 需要它）。两条路径固定、可信，无注入风险。
			const trySpawn = (useShell: boolean): ChildProcess =>
				spawn(this.binary, args, {
					cwd: this.spawnCwd,
					stdio: ["pipe", "pipe", "inherit"],
					shell: useShell,
				});
			let child: ChildProcess;
			try {
				child = trySpawn(forceShell);
			} catch {
				child = trySpawn(true);
			}

			// shell:false 找不到二进制会异步 emit 'error'(ENOENT)。回落 shell:true 重试一次。
			child.once("error", (enoentErr: Error & { code?: string }) => {
				if (enoentErr.code === "ENOENT" && !forceShell) {
					// shell:false 找不到二进制 -> 用 shell:true 重试一次（npm .cmd shim 需要）
					this.start(signal, true).then(resolve, reject);
					return;
				}
				this.cleanup();
				reject(
					new Error(
						`无法启动 codegraph（"${this.binary} serve --mcp"）：${enoentErr.message}。` +
							"确认 codegraph 已安装且在 PATH，或设置 CODEGRAPH_BIN 指向其路径。",
					),
				);
			});
			this.child = child;

			const fail = (err: Error) => {
				this.cleanup();
				reject(err);
			};

			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				this.buf += chunk;
				let idx: number;
				// 逐行 drain；尾部分片留在 buf 等下次 data。
				while ((idx = this.buf.indexOf("\n")) !== -1) {
					const line = this.buf.slice(0, idx).trim();
					this.buf = this.buf.slice(idx + 1);
					if (line) this.handleLine(line);
				}
			});

			// 子进程意外退出：拒绝所有在途调用，下次调用会重启。
			child.on("exit", (code: number | null, sig: NodeJS.Signals | null) => {
				const err = new Error(`codegraph 子进程退出（code=${code} signal=${sig}）`);
				for (const p of this.pending.values()) p.reject(err);
				this.pending.clear();
				this.initialized = false;
				this.child = null;
			});

			// 发 initialize，等响应。
			this.request(
				"initialize",
				{
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "pi-codegraph", version: "1.0" },
				},
				signal,
			)
				.then(() => {
					// 发 notifications/initialized（无 id，无需响应）
					this.notify("notifications/initialized");
					this.initialized = true;
					resolve();
				})
				.catch(fail);
		});
	}

	private handleLine(line: string): void {
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return; // 非 JSON 行忽略（不应发生，codegraph stdout 只发 JSON-RPC）
		}

		// 对我们 request 的响应（有 id，有 result 或 error，无 method）
		if (
			msg.jsonrpc === "2.0" &&
			typeof msg.method !== "string" &&
			(msg.id !== undefined || msg.id !== null) &&
			(msg.result !== undefined || msg.error !== undefined)
		) {
			const p = this.pending.get(msg.id);
			if (p) {
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error?.message ?? JSON.stringify(msg.error)));
				else p.resolve(msg.result);
			}
			return;
		}

		// 服务端主动请求（如 roots/list）或通知：用空结果回应请求，通知忽略。
		// 我们已通过 --path 显式传了项目根，roots/list 一般不会发；即便发，
		// 空 roots 也安全（codegraph 会回落到 --path）。
		if (msg.method && msg.id !== undefined && msg.id !== null) {
			this.write({ jsonrpc: "2.0", id: msg.id, result: {} });
		}
	}

	private write(obj: any): void {
		if (this.child?.stdin && !this.child.stdin.destroyed) {
			this.child.stdin.write(JSON.stringify(obj) + "\n");
		}
	}

	private notify(method: string, params?: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
		const id = this.nextId++;
		return new Promise<any>((resolve, reject) => {
			const entry: PendingCall = {
				resolve,
				reject: (err: Error) => {
					clearTimeout(timer);
					reject(err);
				},
			};
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					reject(new Error(`codegraph ${method} 超时（30s）`));
				}
			}, 30000);
			timer.unref?.();
			this.pending.set(id, entry);
			this.write({ jsonrpc: "2.0", id, method, params });

			// 中止：从 pending 移除并 reject。不杀子进程（其它并发调用还要用），
			// 迟到的响应会被忽略。
			if (signal) {
				if (signal.aborted) entry.reject(new Error("已取消"));
				else
					signal.addEventListener(
						"abort",
						() => {
							if (this.pending.delete(id)) entry.reject(new Error("已取消"));
						},
						{ once: true },
					);
			}
		});
	}

	/** 调用一个 codegraph 工具，返回 MCP tools/call 的 result。 */
	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
		await this.ensureReady(signal);
		return this.request("tools/call", { name, arguments: args }, signal);
	}

	private cleanup(): void {
		this.initialized = false;
		this.buf = "";
		if (this.child) {
			try {
				this.child.kill();
			} catch {}
			this.child = null;
		}
	}

	stop(): void {
		for (const p of this.pending.values()) p.reject(new Error("codegraph 扩展已关闭"));
		this.pending.clear();
		this.cleanup();
	}
}

// ---------------------------------------------------------------------------
// 会话级状态：当前会话的 client + 启动 cwd
// ---------------------------------------------------------------------------

let client: CodeGraphMcpClient | null = null;
let sessionCwd: string | null = null;

/** 本扩展唯一暴露的 codegraph 工具名。 */
const CODEGRAPH_TOOL = "codegraph_explore";

/**
 * 会话启动时确保 codegraph_explore 在 activeTools 里。总是可见，不再按
 * .codegraph/ 是否存在门控--即便会话目录无索引也暴露工具，靠 codegraph 的
 * projectPath 在调用时解析目标库（server 能在无默认项目下启动）。幂等。
 */
function activateCodeGraphTool(pi: ExtensionAPI, cwd: string): void {
	sessionCwd = cwd;
	const active = pi.getActiveTools();
	if (!active.includes(CODEGRAPH_TOOL)) {
		pi.setActiveTools([...active, CODEGRAPH_TOOL]);
	}
}

/**
 * 取当前会话的 client（懒创建）。始终返回 client--哪怕 sessionCwd 无
 * .codegraph 索引：codegraph server 在无默认项目时照常运行，靠每次调用的
 * projectPath 解析目标库；agent 漏传时由 codegraph 抛 NotIndexedError 引导。
 */
function getClient(): CodeGraphMcpClient {
	if (!client) client = new CodeGraphMcpClient(sessionCwd ?? process.cwd());
	return client;
}

/** 把 MCP tools/call 的 result 规整成 pi 的 ToolResult（截断 + details 统计）。 */
async function forwardToCodegraph(
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
) {
	const c = getClient();
	const result = await c.callTool(toolName, args, signal);
	const content: any[] = result?.content ?? [];
	const text = content
		.map((c) => (c?.type === "text" ? String(c.text ?? "") : ""))
		.join("\n");
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return {
		content: [{ type: "text" as const, text: t.content }],
		details: {
			truncated: t.truncated,
			totalLines: t.totalLines,
			isError: result?.isError === true,
		},
	};
}

/** 通用 renderResult：折叠摘要 + 展开预览前 N 行。 */
function renderCodegraphResult(
	result: any,
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: any,
	label: string,
) {
	if (isPartial) return new Text(theme.fg("warning", "Querying codegraph..."), 0, 0);

	const truncated: boolean = result.details?.truncated ?? false;
	const totalLines: number = result.details?.totalLines ?? 0;
	const isError: boolean = result.details?.isError ?? false;

	let stat = `${totalLines} 行`;
	if (isError) stat = `error · ${stat}`;
	const summary = summaryLine(theme, label, stat, truncated);
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
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// --- codegraph_explore ---
	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph Explore",
		description:
			"PRIMARY TOOL - call FIRST for almost any question OR before an edit: how does X work, architecture, a bug, where/what is X, surveying an area, or the symbols you are about to change. Returns the verbatim source of the relevant symbols grouped by file in ONE capped call (Read-equivalent - treat the shown source as already Read; do NOT re-open those files), plus the call path among them. " +
			"Give a BAG OF SYMBOL/FILE NAMES (e.g. 'AuthService loginUser session-manager') - NOT a natural-language sentence. " +
			"Under the hood query is whitespace-tokenized and each token is matched literally against symbol names (via SQLite FTS5 + bounded edit-distance fuzzy fallback); there is NO LLM/NLP, so free-form prose gets split into keywords and often misses. " +
			"Usually the ONLY call you need - more accurate context, in far fewer tokens and round-trips than a search/Read/Grep loop.",
		promptSnippet: "codegraph 主工具：一次调用返回相关符号源码 + 调用路径，替代 grep+Read 循环",
		promptGuidelines: [
			"对于结构性/流程问题（X 如何到达 Y、调用链、影响范围、某区域怎么运作），优先用 codegraph_explore 而不是 Read/Grep。",
			"codegraph_explore 返回的源码是逐字当前磁盘内容，视为已 Read，不要重复 Read 那些文件。",
			"查询的目标项目与会话默认项目（会话启动目录向上最近的 .codegraph）不同、或会话目录无 .codegraph 时，用 projectPath 传入目标项目绝对路径；漏传时 codegraph 会报 NotIndexedError 提示补上。",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					'A bag of symbol/file names or short code terms (e.g. "AuthService loginUser session-manager", "GraphTraverser BFS impact traversal.ts"). For a flow question, name the symbols spanning the flow (e.g. "mutateElement renderScene"). Prefer named symbols over prose: the query is whitespace-split into tokens and each is matched literally against symbol names (FTS5 + edit-distance fuzzy) - no LLM/NLP, so a natural-language sentence just becomes loose keywords and often misses. Qualified names like Class.method disambiguate best.',
			}),
			maxFiles: Type.Optional(
				Type.Number({
					description: "Maximum number of files to include source code from (default: 12)",
				}),
			),
			projectPath,
		}),
		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("codegraph_explore "));
			const q = args.query.length > 60 ? `${args.query.slice(0, 57)}...` : args.query;
			t += theme.fg("accent", `"${q}"`);
			if (args.maxFiles) t += theme.fg("dim", ` · maxFiles=${args.maxFiles}`);
			return new Text(t, 0, 0);
		},
		renderResult(r, o, theme) {
			return renderCodegraphResult(r, o, theme, "explore");
		},
		async execute(_id, params, signal) {
			return forwardToCodegraph("codegraph_explore", params, signal);
		},
	});

	// --- 会话生命周期：激活工具 + 子进程清理 ---
	pi.on("session_start", (_event, ctx) => {
		activateCodeGraphTool(pi, ctx.cwd);
	});

	pi.on("session_shutdown", () => {
		if (client) {
			client.stop();
			client = null;
		}
		sessionCwd = null;
	});
}
