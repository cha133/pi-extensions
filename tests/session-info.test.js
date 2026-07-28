import { describe, expect, test } from "bun:test";
import { formatSessionInfo, registerSessionInfo } from "../extensions/session-info.ts";

const initialModel = {
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
};

function createHarness({
	sessionId = "session-1",
	entries = [],
	model = initialModel,
	now = "2026-07-24T11:22:33.456Z",
} = {}) {
	const handlers = new Map();
	const appended = [];
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		appendEntry(customType, data) {
			appended.push({ type: "custom", customType, data });
		},
	};
	const ctx = {
		model: model ?? undefined,
		sessionManager: {
			getSessionId: () => sessionId,
			getHeader: () => ({
				type: "session",
				id: sessionId,
				timestamp: "2026-07-24T11:22:33.456Z",
			}),
			getEntries: () => entries,
		},
	};

	registerSessionInfo(pi, () => new Date(now), () => "Asia/Shanghai");
	return { handlers, appended, ctx };
}

describe("session info formatting", () => {
	test("formats the first-message instant and first-turn model", () => {
		const prompt = formatSessionInfo("2026-07-24T11:22:33.456Z", "Asia/Shanghai", initialModel);
		expect(prompt).toContain("2026-07-24 19:22:33 (Asia/Shanghai; 2026-07-24T11:22:33.456Z)");
		expect(prompt).toContain("anthropic/claude-sonnet-4-5 (Claude Sonnet 4.5)");
	});

	test("rejects an invalid session timestamp", () => {
		expect(formatSessionInfo("not-a-date", "UTC", initialModel)).toBeUndefined();
	});
});

describe("session info lifecycle", () => {
	test("waits until the first user turn, then persists one value", () => {
		const { handlers, appended, ctx } = createHarness();
		handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

		expect(appended).toHaveLength(0);
		ctx.model = { provider: "openai", id: "gpt-5", name: "GPT-5" };
		const first = handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
		expect(appended).toHaveLength(1);
		expect(appended[0].customType).toBe("session-info");
		const second = handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
		expect(second).toEqual(first);
		expect(first.systemPrompt).toContain("openai/gpt-5");
		expect(first.systemPrompt).not.toContain("anthropic/claude-sonnet-4-5");
		expect(first.systemPrompt).toContain("2026-07-24T11:22:33.456Z");
		expect(first.systemPrompt).not.toContain("This session started at");
	});

	test("captures the model only when the first agent turn can actually start", () => {
		const { handlers, appended, ctx } = createHarness({ model: null });
		handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		expect(appended).toHaveLength(0);

		ctx.model = initialModel;
		const result = handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
		expect(appended).toHaveLength(1);
		expect(result.systemPrompt).toContain("anthropic/claude-sonnet-4-5");
	});

	test("restores the persisted value when a session resumes", () => {
		const savedPrompt = "## Session info\n\nPreviously persisted";
		const entries = [
			{
				type: "custom",
				customType: "session-info",
				data: { sessionId: "session-1", prompt: savedPrompt },
			},
		];
		const { handlers, appended, ctx } = createHarness({ entries });
		handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);

		expect(appended).toHaveLength(0);
		expect(handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx)).toEqual({
			systemPrompt: `base\n\n${savedPrompt}`,
		});
	});

	test("does not reuse a parent session's value after a fork", () => {
		const entries = [
			{
				type: "custom",
				customType: "session-info",
				data: { sessionId: "parent-session", prompt: "parent prompt" },
			},
		];
		const { handlers, appended, ctx } = createHarness({ sessionId: "fork-session", entries });
		handlers.get("session_start")({ type: "session_start", reason: "fork" }, ctx);

		expect(appended).toHaveLength(0);
		handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
		expect(appended).toHaveLength(1);
		expect(appended[0].data.sessionId).toBe("fork-session");
		expect(appended[0].data.prompt).not.toBe("parent prompt");
	});
});
