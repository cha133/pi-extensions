import { describe, expect, test } from "bun:test";
import { formatSessionDatetime, registerDatetime } from "../extensions/datetime.ts";

function createHarness({ sessionId = "session-1", entries = [] } = {}) {
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

	registerDatetime(pi);
	return { handlers, appended, ctx };
}

describe("session datetime formatting", () => {
	test("formats the session creation instant in the supplied system time zone", () => {
		expect(formatSessionDatetime("2026-07-24T11:22:33.456Z", "Asia/Shanghai")).toContain(
			"2026-07-24 19:22:33 (Asia/Shanghai; 2026-07-24T11:22:33.456Z)",
		);
	});

	test("rejects an invalid session timestamp", () => {
		expect(formatSessionDatetime("not-a-date", "UTC")).toBeUndefined();
	});
});

describe("session datetime lifecycle", () => {
	test("persists one value and reuses it for every turn", () => {
		const { handlers, appended, ctx } = createHarness();
		handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

		expect(appended).toHaveLength(1);
		const first = handlers.get("before_agent_start")({ systemPrompt: "base" });
		const second = handlers.get("before_agent_start")({ systemPrompt: "base" });
		expect(second).toEqual(first);
		expect(first.systemPrompt).toContain("## Session datetime");
	});

	test("restores the persisted value when a session resumes", () => {
		const savedPrompt = "## Session datetime\n\nPreviously persisted";
		const entries = [
			{
				type: "custom",
				customType: "session-datetime",
				data: { sessionId: "session-1", prompt: savedPrompt },
			},
		];
		const { handlers, appended, ctx } = createHarness({ entries });
		handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);

		expect(appended).toHaveLength(0);
		expect(handlers.get("before_agent_start")({ systemPrompt: "base" })).toEqual({
			systemPrompt: `base\n\n${savedPrompt}`,
		});
	});

	test("does not reuse a parent session's value after a fork", () => {
		const entries = [
			{
				type: "custom",
				customType: "session-datetime",
				data: { sessionId: "parent-session", prompt: "parent prompt" },
			},
		];
		const { handlers, appended, ctx } = createHarness({ sessionId: "fork-session", entries });
		handlers.get("session_start")({ type: "session_start", reason: "fork" }, ctx);

		expect(appended).toHaveLength(1);
		expect(appended[0].data.sessionId).toBe("fork-session");
		expect(appended[0].data.prompt).not.toBe("parent prompt");
	});
});
