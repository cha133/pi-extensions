import { describe, expect, test } from "bun:test";
import { registerBash } from "../extensions/bash.ts";

describe("bash platform registration", () => {
	test("does not register on macOS or Linux", () => {
		const events = [];
		const pi = {
			on(event) {
				events.push(event);
			},
		};

		registerBash(pi, "darwin");
		registerBash(pi, "linux");

		expect(events).toEqual([]);
	});

	test("registers the session hook on Windows", () => {
		const events = [];
		const pi = {
			on(event) {
				events.push(event);
			},
		};

		registerBash(pi, "win32");

		expect(events).toEqual(["session_start"]);
	});
});
