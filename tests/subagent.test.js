import { describe, expect, test } from "bun:test";
import registerSubagent, {
	createSubagentTool,
	createSubagentParameters,
	formatStatusLine,
	formatToolActivity,
	isAdvisorAvailable,
	isSameModel,
	resolveSubagentSettings,
	runSubagent,
	SUBAGENT_TOOLS,
	SubagentProgressTracker,
	taskSubject,
} from "../extensions/subagent.ts";

describe("subagent settings", () => {
	test("uses the current model for peer and hides advisor when no settings exist", () => {
		expect(resolveSubagentSettings(undefined, undefined)).toEqual({
			peer: undefined,
			advisor: undefined,
		});
	});

	test("reads both tiers and merges trusted project overrides per tier", () => {
		expect(
			resolveSubagentSettings(
				{
					peer: { provider: "openai", model: "gpt-peer" },
					advisor: { provider: "anthropic", model: "global-advisor" },
				},
				{
					advisor: { model: "project-advisor" },
				},
			),
		).toEqual({
			peer: { provider: "openai", model: "gpt-peer" },
			advisor: { provider: "anthropic", model: "project-advisor" },
		});
	});

	test("rejects malformed roots and incomplete tier models", () => {
		expect(() => resolveSubagentSettings("anthropic/opus", undefined)).toThrow(
			'must be a JSON object',
		);
		expect(() => resolveSubagentSettings({ advisor: "anthropic/opus" }, undefined)).toThrow(
			'"subagent.advisor"',
		);
		expect(() => resolveSubagentSettings({ peer: { model: "peer" } }, undefined)).toThrow(
			'must contain a non-empty string "provider"',
		);
		expect(() => resolveSubagentSettings({ advisor: { provider: "anthropic" } }, undefined)).toThrow(
			'must contain a non-empty string "model"',
		);
	});
});

describe("subagent tier availability", () => {
	const current = { provider: "openai", id: "gpt-main" };

	test("compares both provider and model id", () => {
		expect(isSameModel(current, { provider: "openai", id: "gpt-main" })).toBe(true);
		expect(isSameModel(current, { provider: "openrouter", id: "gpt-main" })).toBe(false);
	});

	test("shows advisor only when a different model resolves", () => {
		expect(isAdvisorAvailable(current, undefined)).toBe(false);
		expect(isAdvisorAvailable(current, { provider: "openai", id: "gpt-main" })).toBe(false);
		expect(isAdvisorAvailable(current, { provider: "anthropic", id: "claude-advisor" })).toBe(true);
	});
});

describe("subagent parameters", () => {
	test("exposes only task when advisor is unavailable", () => {
		const schema = createSubagentParameters(false);
		expect(schema.properties).toHaveProperty("task");
		expect(schema.properties).not.toHaveProperty("tier");
		expect(schema.required).toEqual(["task"]);
	});

	test("adds an optional peer/advisor tier when advisor is available", () => {
		const schema = createSubagentParameters(true);
		expect(schema.properties).toHaveProperty("task");
		expect(schema.properties).toHaveProperty("tier");
		expect(schema.required).toEqual(["task"]);
		expect(schema.properties.tier.default).toBe("peer");
		expect(schema.properties.tier.anyOf.map((item) => item.const)).toEqual(["peer", "advisor"]);
	});
});

describe("subagent tools", () => {
	test("matches the main pi tool surface without legacy grep, find, or ls tools", () => {
		expect(SUBAGENT_TOOLS).toEqual([
			"read",
			"bash",
			"edit",
			"codegraph_explore",
			"web_search",
			"web_fetch",
		]);
	});
});

describe("subagent progress", () => {
	test("reduces tool, reasoning, and reply events to one status line", () => {
		const tracker = new SubagentProgressTracker();

		expect(
			tracker.handle({
				type: "message_start",
				message: { role: "assistant" },
			}),
		).toEqual({ phase: "starting", summary: "Thinking..." });
		expect(
			tracker.handle({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "Checking authentication paths" },
			}),
		).toEqual({ phase: "reasoning", summary: "Checking authentication paths" });
		expect(
			tracker.handle({
				type: "tool_execution_start",
				toolCallId: "1",
				toolName: "bash",
				args: { command: 'rg -n "getAuth" packages' },
			}),
		).toEqual({ phase: "tool", summary: 'bash: rg -n "getAuth" packages' });
		expect(
			tracker.handle({
				type: "tool_execution_end",
				toolCallId: "1",
				toolName: "bash",
			}),
		).toEqual({ phase: "starting", summary: "Continuing..." });
		expect(
			tracker.handle({
				type: "message_end",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "500 lines of internal tool output" }],
				},
			}),
		).toBeUndefined();
		expect(
			tracker.handle({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "One finding.\n\nThe fallback can race.",
				},
			}),
		).toEqual({ phase: "replying", summary: "The fallback can race." });
	});

	test("formats compact subjects, tool activities, and phase markers", () => {
		expect(taskSubject("  Review auth\nwith supporting tests  ")).toBe("Review auth");
		expect(formatToolActivity("web_search", { query: "current OAuth guidance" })).toBe(
			"web search: current OAuth guidance",
		);
		expect(formatToolActivity("read", { path: "src/auth.ts" })).toBe("read: src/auth.ts");
		expect(formatToolActivity("edit", { path: "src/auth.ts" })).toBe("edit: src/auth.ts");
		expect(formatStatusLine({ phase: "tool", summary: "read: src/auth.ts" })).toBe(
			"▸ read: src/auth.ts",
		);
		expect(formatStatusLine({ phase: "finished", summary: "Finished · 3 turns" })).toBe(
			"✓ Finished · 3 turns",
		);
	});
});

describe("subagent SDK session", () => {
	const model = { provider: "openai", id: "peer" };

	function assistant(text, stopReason = "stop") {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
			usage: {
				input: 120,
				output: 30,
				cacheRead: 10,
				cacheWrite: 5,
				cost: { total: 0.02 },
			},
		};
	}

	test("collects direct SDK events and gracefully shuts down the in-memory session", async () => {
		const actions = [];
		const statuses = [];
		let listener;
		let receivedOptions;
		const session = {
			subscribe(value) {
				listener = value;
				return () => actions.push("unsubscribe");
			},
			async prompt(task) {
				actions.push(`prompt:${task}`);
				listener({ type: "message_start", message: assistant("") });
				listener({
					type: "tool_execution_start",
					toolCallId: "tool-1",
					toolName: "read",
					args: { path: "src/auth.ts" },
				});
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: "read",
				});
				listener({ type: "message_end", message: assistant("Direct SDK report") });
			},
			async abort() {
				actions.push("abort");
			},
			extensionRunner: {
				async emit(event) {
					actions.push(`${event.type}:${event.reason}`);
				},
			},
			dispose() {
				actions.push("dispose");
			},
		};

		const result = await runSubagent(
			"C:\\repo",
			model,
			"high",
			false,
			"Review auth",
			undefined,
			(status) => statuses.push(status),
			async (options) => {
				receivedOptions = options;
				return session;
			},
		);

		expect(receivedOptions).toEqual({
			cwd: "C:\\repo",
			model,
			thinkingLevel: "high",
			projectTrusted: false,
		});
		expect(result).toEqual({
			finalOutput: "Direct SDK report",
			stopReason: "stop",
			errorMessage: undefined,
			usage: {
				input: 120,
				output: 30,
				cacheRead: 10,
				cacheWrite: 5,
				cost: 0.02,
				turns: 1,
			},
		});
		expect(statuses).toContainEqual({ phase: "tool", summary: "read: src/auth.ts" });
		expect(actions).toEqual([
			"prompt:Review auth",
			"unsubscribe",
			"abort",
			"session_shutdown:quit",
			"dispose",
		]);
	});

	test("propagates cancellation through session.abort and still performs cleanup", async () => {
		const controller = new AbortController();
		const actions = [];
		let startPrompt;
		let releasePrompt;
		const started = new Promise((resolve) => {
			startPrompt = resolve;
		});
		const blocked = new Promise((resolve) => {
			releasePrompt = resolve;
		});
		const session = {
			subscribe() {
				return () => actions.push("unsubscribe");
			},
			async prompt() {
				actions.push("prompt");
				startPrompt();
				await blocked;
			},
			async abort() {
				actions.push("abort");
				releasePrompt();
			},
			extensionRunner: {
				async emit() {
					actions.push("shutdown");
				},
			},
			dispose() {
				actions.push("dispose");
			},
		};

		const running = runSubagent(
			"C:\\repo",
			model,
			"medium",
			true,
			"Long review",
			controller.signal,
			undefined,
			async () => session,
		);
		await started;
		controller.abort();
		const result = await running;

		expect(result.stopReason).toBe("aborted");
		expect(actions.filter((action) => action === "abort")).toHaveLength(2);
		expect(actions.slice(-3)).toEqual(["abort", "shutdown", "dispose"]);
	});

	test("returns prompt failures after gracefully shutting down the session", async () => {
		const actions = [];
		const session = {
			subscribe() {
				return () => actions.push("unsubscribe");
			},
			async prompt() {
				throw new Error("authentication expired");
			},
			async abort() {
				actions.push("abort");
			},
			extensionRunner: {
				async emit() {
					actions.push("shutdown");
				},
			},
			dispose() {
				actions.push("dispose");
			},
		};

		const result = await runSubagent(
			"C:\\repo",
			model,
			"medium",
			true,
			"Review",
			undefined,
			undefined,
			async () => session,
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("authentication expired");
		expect(actions).toEqual(["unsubscribe", "abort", "shutdown", "dispose"]);
	});
});

describe("subagent rendering", () => {
	const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
	const theme = {
		bold(text) {
			return text;
		},
		fg(_color, text) {
			return text;
		},
	};

	test("uses one truncated topic line and one truncated status line", () => {
		const tool = createSubagentTool(true);
		const call = tool.renderCall(
			{
				task: "Review authentication error handling and compare every implementation path",
				tier: "advisor",
			},
			theme,
		);
		const result = tool.renderResult(
			{
				content: [],
				details: {
					tier: "advisor",
					provider: "anthropic",
					model: "advisor",
					status: { phase: "tool", summary: "bash: rg -n authentication packages" },
				},
			},
			{ expanded: false, isPartial: true },
			theme,
			{ isError: false },
		);

		expect(call.render(40)).toHaveLength(1);
		expect(plain(call.render(40)[0]).trimEnd()).toBe("advisor · Review authentication error...");
		expect(result.render(40)).toHaveLength(1);
		expect(plain(result.render(40)[0]).trimEnd()).toBe("▸ bash: rg -n authentication packages");
		expect(tool.executionMode).toBe("parallel");
	});
});

describe("subagent registration", () => {
	test("refreshes its dynamic tool on session start and model selection", () => {
		const events = new Map();
		const tools = [];
		const pi = {
			on(event, handler) {
				events.set(event, handler);
			},
			registerTool(tool) {
				tools.push(tool);
			},
		};

		registerSubagent(pi);

		expect(tools).toHaveLength(0);
		expect(events.has("session_start")).toBe(true);
		expect(events.has("model_select")).toBe(true);
	});
});
