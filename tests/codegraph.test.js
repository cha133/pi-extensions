import { describe, expect, test } from "bun:test";
import { registerCodeGraph } from "../extensions/codegraph.ts";

describe("codegraph session isolation", () => {
	function createPi() {
		const events = new Map();
		const tools = [];
		let activeTools = [];
		return {
			events,
			tools,
			api: {
				on(event, handler) {
					events.set(event, handler);
				},
				registerTool(tool) {
					tools.push(tool);
				},
				getActiveTools() {
					return activeTools;
				},
				setActiveTools(value) {
					activeTools = value;
				},
			},
		};
	}

	test("owns one MCP client per registered session and only stops its own client", async () => {
		const clients = [];
		const createClient = (cwd) => {
			const client = {
				cwd,
				stopped: false,
				async callTool() {
					return { content: [{ type: "text", text: cwd }] };
				},
				stop() {
					this.stopped = true;
				},
			};
			clients.push(client);
			return client;
		};
		const first = createPi();
		const second = createPi();
		registerCodeGraph(first.api, createClient);
		registerCodeGraph(second.api, createClient);

		first.events.get("session_start")({}, { cwd: "C:\\repo-one" });
		second.events.get("session_start")({}, { cwd: "C:\\repo-two" });
		await first.tools.at(-1).execute("first", { query: "one" });
		await second.tools.at(-1).execute("second", { query: "two" });

		expect(clients.map((client) => client.cwd)).toEqual(["C:\\repo-one", "C:\\repo-two"]);
		first.events.get("session_shutdown")();
		expect(clients.map((client) => client.stopped)).toEqual([true, false]);
		second.events.get("session_shutdown")();
		expect(clients.map((client) => client.stopped)).toEqual([true, true]);
	});
});
