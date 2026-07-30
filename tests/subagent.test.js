import { describe, expect, test } from "bun:test";
import registerSubagent, {
	createSubagentParameters,
	getPiInvocation,
	isAdvisorAvailable,
	isSameModel,
	resolveSubagentSettings,
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

describe("pi child invocation", () => {
	test("does not pass a Windows Bun virtual script path as a prompt argument", () => {
		const args = ["--mode", "json"];
		const invocation = getPiInvocation(args, {
			currentScript: "B:/~BUN/root/pi.exe",
			execPath: "C:\\Scoop\\shims\\pi.exe",
			fileExists: () => false,
		});

		expect(invocation).toEqual({
			command: "C:\\Scoop\\shims\\pi.exe",
			args,
		});
		expect(invocation.args).not.toContain("B:/~BUN/root/pi.exe");
	});

	test("keeps a real runtime script when pi is launched through Bun", () => {
		const args = ["--mode", "json"];
		const invocation = getPiInvocation(args, {
			currentScript: "C:\\tools\\pi\\src\\main.ts",
			execPath: "C:\\tools\\bun.exe",
			fileExists: () => true,
		});

		expect(invocation).toEqual({
			command: "C:\\tools\\bun.exe",
			args: ["C:\\tools\\pi\\src\\main.ts", ...args],
		});
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
