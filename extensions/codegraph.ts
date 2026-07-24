/**
 * codegraph -- Pi has no built-in MCP client, so this extension acts as a stdio MCP
 * client and bridges codegraph_explore into a native Pi tool.
 *
 * The tool is always visible: session_start adds it to activeTools unconditionally
 * rather than gating it on .codegraph/ existence. It remains available when the session
 * directory has no index because the spawned server can run without a default project.
 * Each call resolves its target from projectPath; if omitted, codegraph raises
 * NotIndexedError to prompt the agent to provide one.
 *
 * Implementation: spawn `codegraph serve --mcp` without --path and set options.cwd so
 * codegraph searches upward from process.cwd() for .codegraph/. The only value that may
 * contain spaces is cwd, which never passes through shell argument concatenation.
 * Communication uses newline-delimited JSON-RPC 2.0, matching codegraph's StdioTransport
 * in src/mcp/transport.ts. The child starts lazily on the first call, performs the
 * initialize handshake, serves all session calls with request-ID multiplexing, and is
 * terminated on session_shutdown.
 *
 * Only codegraph_explore is exposed. Testing showed that one capable tool, returning
 * relevant symbol source, call paths, and impact scope in a single call, guides agents
 * better than a collection of narrow tools. The other read-only codegraph tools
 * (search/callers/callees/impact/node/status/files) are intentionally not bridged.
 *
 * Reference: web-search.ts for the hand-written MCP client's lazy-initialization pattern.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
 * Label, description, and parameter schema for codegraph_explore.
 * The description and schema mirror codegraph v1.5.0's src/mcp/tools.ts so they match
 * the installed behavior. The stable tool contract is hard-coded rather than discovered
 * through tools/list at runtime.
 */
const PROJECT_PATH_DESC =
	"Absolute path to the project to query (or any directory inside it) - " +
	"codegraph uses the nearest .codegraph/ index at or above that path. " +
	"Omit to use this session's default project. Pass it to query a second " +
	"codebase, or when the server root has no index of its own (e.g. a " +
	"monorepo where only sub-projects are indexed, so there is no default project).";

/** Number of leading lines shown when the collapsed TUI result is expanded. */
const PREVIEW_LINES = 40;

/** Collapsed summary: `<label> · <stats> [· truncated] (expand key hint)`. */
function summaryLine(theme: any, main: string, stat: string, truncated: boolean): string {
	let line = theme.fg("success", `${main} · ${stat}`);
	if (truncated) line += theme.fg("warning", " · truncated");
	line += theme.fg("dim", ` (${keyHint("app.tools.expand", "expand")})`);
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
 * Thin client for one codegraph MCP child process. It starts lazily, performs the
 * initialize handshake, and multiplexes tools/call requests. One instance serves the
 * session and is stopped on session_shutdown.
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

	/** Spawn and initialize lazily on the first call; concurrent calls share one startup. */
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
			// Omit --path. The only value that may contain spaces is cwd, and options.cwd
			// sets it directly without shell argument concatenation. codegraph serve --mcp
			// searches upward from process.cwd() for the nearest .codegraph/ index.
			const args = ["serve", "--mcp"];
			if (process.env.CODEGRAPH_NO_WATCH) args.push("--no-watch");

			// Prefer shell:false: Scoop's codegraph.exe and Unix scripts can spawn directly,
			// avoiding Node's DEP0190 warning about shell argument concatenation. Fall back
			// to shell:true only on ENOENT for globally installed npm .cmd shims. Both the
			// executable and argument list are fixed and trusted.
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

			// A missing binary with shell:false emits ENOENT asynchronously; retry once with a shell.
			child.once("error", (enoentErr: Error & { code?: string }) => {
				if (enoentErr.code === "ENOENT" && !forceShell) {
					// Globally installed npm .cmd shims require shell:true.
					this.start(signal, true).then(resolve, reject);
					return;
				}
				this.cleanup();
				reject(
					new Error(
						`Could not start codegraph ("${this.binary} serve --mcp"): ${enoentErr.message}. ` +
							"Make sure codegraph is installed and on PATH, or set CODEGRAPH_BIN to its executable.",
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
				// Drain complete lines and keep a trailing fragment in buf for the next chunk.
				while ((idx = this.buf.indexOf("\n")) !== -1) {
					const line = this.buf.slice(0, idx).trim();
					this.buf = this.buf.slice(idx + 1);
					if (line) this.handleLine(line);
				}
			});

			// Reject in-flight calls after an unexpected exit; the next call restarts the child.
			child.on("exit", (code: number | null, sig: NodeJS.Signals | null) => {
				const err = new Error(`codegraph child process exited (code=${code} signal=${sig})`);
				for (const p of this.pending.values()) p.reject(err);
				this.pending.clear();
				this.initialized = false;
				this.child = null;
			});

			// Send initialize and wait for its response.
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
					// Send notifications/initialized without an ID or expected response.
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
			return; // Ignore non-JSON lines; codegraph should emit only JSON-RPC on stdout.
		}

		// Response to one of our requests: ID plus result/error, without method.
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

		// For server-initiated requests such as roots/list, reply with an empty result;
		// ignore notifications. Empty roots are safe because codegraph falls back to its
		// configured project path.
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
					reject(new Error(`codegraph ${method} timed out after 30 seconds`));
				}
			}, 30000);
			timer.unref?.();
			this.pending.set(id, entry);
			this.write({ jsonrpc: "2.0", id, method, params });

			// On abort, remove and reject this request without killing the child, which may
			// still serve concurrent calls. A late response is ignored.
			if (signal) {
				if (signal.aborted) entry.reject(new Error("Cancelled"));
				else
					signal.addEventListener(
						"abort",
						() => {
							if (this.pending.delete(id)) entry.reject(new Error("Cancelled"));
						},
						{ once: true },
					);
			}
		});
	}

	/** Call one codegraph tool and return its MCP tools/call result. */
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
		for (const p of this.pending.values()) p.reject(new Error("codegraph extension has shut down"));
		this.pending.clear();
		this.cleanup();
	}
}

// ---------------------------------------------------------------------------
// Session-level state: current client and startup cwd
// ---------------------------------------------------------------------------

let client: CodeGraphMcpClient | null = null;
let sessionCwd: string | null = null;

/** The only codegraph tool exposed by this extension. */
const CODEGRAPH_TOOL = "codegraph_explore";

/**
 * Return the codegraph data-directory name. CODEGRAPH_DIR mirrors codegraph's
 * directory.ts codeGraphDirName override, allowing Windows and WSL to keep separate
 * indexes in a shared worktree. Reject anything other than a plain directory name,
 * including separators, "..", and absolute paths, and fall back to .codegraph.
 */
function codegraphDirName(): string {
	const raw = process.env.CODEGRAPH_DIR?.trim();
	if (!raw || raw === "." || raw.includes("..") || raw.includes("/") || raw.includes("\\")) {
		return ".codegraph";
	}
	return raw;
}

/**
 * Check upward from cwd for a usable codegraph index, matching codegraph's
 * isInitialized behavior. Require `<dir>/<codegraphDirName>/codegraph.db`, not merely
 * the directory, so a home-level .codegraph containing only global configuration such
 * as telemetry.json is not mistaken for an initialized project.
 */
function hasDefaultCodegraphProject(cwd: string): boolean {
	const dirName = codegraphDirName();
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, dirName, "codegraph.db"))) return true;
		const parent = dirname(dir);
		if (parent === dir) break; // Reached the filesystem root.
		dir = parent;
	}
	return false;
}

/**
 * Ensure codegraph_explore is active at session start. Keep it visible even without a
 * local index because projectPath resolves the target at call time and the server can
 * start without a default project. Idempotent.
 */
function activateCodeGraphTool(pi: ExtensionAPI, cwd: string): void {
	sessionCwd = cwd;
	const active = pi.getActiveTools();
	if (!active.includes(CODEGRAPH_TOOL)) {
		pi.setActiveTools([...active, CODEGRAPH_TOOL]);
	}
}

/**
 * Return the current session's lazily created client, even when sessionCwd has no index.
 * The server can run without a default project and resolve each target through
 * projectPath; if the agent omits it, codegraph raises NotIndexedError.
 */
function getClient(): CodeGraphMcpClient {
	if (!client) client = new CodeGraphMcpClient(sessionCwd ?? process.cwd());
	return client;
}

/** Convert an MCP tools/call result into a truncated Pi ToolResult with summary details. */
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

/** Shared result renderer with a collapsed summary and first-N-lines expanded preview. */
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

	let stat = `${totalLines} lines`;
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
		out += `\n${theme.fg("muted", `... ${lines.length - PREVIEW_LINES} more lines`)}`;
	}
	return new Text(out, 0, 0);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * Register codegraph_explore. projectPathRequired controls whether projectPath is
 * mandatory. Pass true when no usable index exists at or above the session directory,
 * matching codegraph's withRequiredProjectPath behavior when there is no default project.
 * A required schema field is more salient to the model than a prose guideline.
 */
function registerExploreTool(pi: ExtensionAPI, projectPathRequired: boolean): void {
	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph Explore",
		description:
			"STRUCTURAL EXPLORATION TOOL - use after you know relevant symbol or file names to inspect call paths, dependencies, impact scope, or how an area works. Returns the verbatim source of relevant symbols grouped by file in one capped call (Read-equivalent - treat shown source as already read and do not reopen those files), plus the call path among them. " +
			"Give a BAG OF SYMBOL/FILE NAMES (e.g. 'AuthService loginUser session-manager') - NOT a natural-language sentence. " +
			"Under the hood query is whitespace-tokenized and each token is matched literally against symbol names (via SQLite FTS5 + bounded edit-distance fuzzy fallback); there is NO LLM/NLP, so free-form prose gets split into keywords and often misses. " +
			"Use rg first when you do not yet know the identifiers, need exhaustive lexical matches, or need to establish that something is absent. A CodeGraph miss is not evidence that matching code does not exist.",
		promptSnippet:
			"Use rg to discover or exhaustively search; use codegraph_explore with known symbol/file names for structural relationships",
		promptGuidelines: [
			"Use rg first to discover symbol/file anchors, enumerate all textual matches, or check whether something is absent. Do not treat an empty or incomplete CodeGraph result as proof that matching code does not exist.",
			"Once relevant symbol or file names are known, use codegraph_explore for structural or flow questions such as how X reaches Y, call chains, dependencies, impact scope, or how an area works.",
			"Source returned by codegraph_explore is verbatim current disk content. Treat it as already read and do not reopen those files.",
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
			projectPath: projectPathRequired
				? Type.String({ description: PROJECT_PATH_DESC })
				: Type.Optional(Type.String({ description: PROJECT_PATH_DESC })),
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
}

export default function (pi: ExtensionAPI) {
	registerExploreTool(pi, /*projectPathRequired*/ false);

	// --- Session lifecycle: tool activation and child-process cleanup ---
	pi.on("session_start", (_event, ctx) => {
		sessionCwd = ctx.cwd;
		// If no usable index exists at or above the session directory, re-register with
		// projectPath required. Check codegraph.db rather than the directory alone to avoid
		// mistaking a home-level global configuration directory for a project index.
		if (!hasDefaultCodegraphProject(ctx.cwd)) {
			registerExploreTool(pi, /*projectPathRequired*/ true);
		}
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
