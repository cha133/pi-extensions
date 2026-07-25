import { describe, expect, test } from "bun:test";
import registerAdvisor, {
	buildAdvisorSystemPrompt,
	buildAdvisorUserPrompt,
	isSameModel,
	resolveAdvisorSettings,
} from "../extensions/advisor.ts";

describe("advisor settings", () => {
	test("defaults to the current model when no advisor object exists", () => {
		expect(resolveAdvisorSettings(undefined, undefined)).toBeUndefined();
	});

	test("reads and merges configured advisor models", () => {
		expect(resolveAdvisorSettings({ provider: "anthropic", model: "global" }, undefined)).toEqual({
			provider: "anthropic",
			model: "global",
		});
		expect(
			resolveAdvisorSettings(
				{ provider: "anthropic", model: "global" },
				{ model: "project" },
			),
		).toEqual({
			provider: "anthropic",
			model: "project",
		});
	});

	test("rejects malformed or incomplete advisor settings", () => {
		expect(() => resolveAdvisorSettings("anthropic/opus", undefined)).toThrow("must be a JSON object");
		expect(() => resolveAdvisorSettings({ model: "opus" }, undefined)).toThrow(
			'must contain a non-empty string "provider"',
		);
		expect(() => resolveAdvisorSettings({ provider: "anthropic" }, undefined)).toThrow(
			'must contain a non-empty string "model"',
		);
	});
});

describe("advisor model modes", () => {
	test("compares both provider and model id", () => {
		expect(
			isSameModel(
				{ provider: "anthropic", id: "shared-id" },
				{ provider: "anthropic", id: "shared-id" },
			),
		).toBe(true);
		expect(
			isSameModel(
				{ provider: "anthropic", id: "shared-id" },
				{ provider: "openrouter", id: "shared-id" },
			),
		).toBe(false);
	});

	test("uses independent-review guidance for the same model", () => {
		const prompt = buildAdvisorSystemPrompt(true);
		expect(prompt).toContain("same underlying model");
		expect(prompt).toContain("fresh review, not greater authority");
		expect(prompt).not.toContain("higher-capability advisor selected by the user");
	});

	test("uses higher-capability guidance for a different model", () => {
		const prompt = buildAdvisorSystemPrompt(false);
		expect(prompt).toContain("higher-capability advisor selected by the user");
		expect(prompt).not.toContain("same underlying model");
	});

	test("both modes require the answer-or-information protocol and prohibit tools", () => {
		for (const sameModel of [true, false]) {
			const prompt = buildAdvisorSystemPrompt(sameModel);
			expect(prompt).toContain("ANSWER");
			expect(prompt).toContain("NEED_MORE_INFO");
			expect(prompt).toContain("You have no tools");
			expect(prompt).toContain("conclusion or most important recommendation first");
		}
	});
});

describe("advisor request prompt", () => {
	test("labels the question and focused context", () => {
		const prompt = buildAdvisorUserPrompt({
			question: " Which design is safer? ",
			context: " Option A mutates global state. ",
		});
		expect(prompt).toContain("<question>\nWhich design is safer?\n</question>");
		expect(prompt).toContain("<relevant_context>\nOption A mutates global state.\n</relevant_context>");
		expect(prompt).not.toContain("<proposed_answer>");
	});

	test("includes a proposed answer only when provided", () => {
		const prompt = buildAdvisorUserPrompt({
			question: "Review this.",
			context: "The API is public.",
			proposedAnswer: " Ship it. ",
		});
		expect(prompt).toContain("<proposed_answer>\nShip it.\n</proposed_answer>");
	});
});

describe("advisor registration", () => {
	test("registers one explicit advisory tool with focused context fields", () => {
		let registered;
		const pi = {
			registerTool(tool) {
				registered = tool;
			},
		};

		registerAdvisor(pi);

		expect(registered.name).toBe("advisor");
		expect(registered.promptSnippet).toContain("independent second opinion");
		expect(registered.promptGuidelines.join("\n")).toContain("never copy the full conversation");
		expect(registered.promptGuidelines.join("\n")).toContain("material new information");
		expect(registered.parameters.properties).toHaveProperty("question");
		expect(registered.parameters.properties).toHaveProperty("context");
		expect(registered.parameters.properties).toHaveProperty("proposedAnswer");
		expect(registered.parameters.required).toEqual(["question", "context"]);
	});
});
