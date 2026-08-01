import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerHashline from "../extensions/hashline.ts";

describe("unified hashline extension", () => {
	test("shares read coverage with edit through the public entry point", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-hashline-integration-"));
		const path = join(directory, "example.txt");
		await writeFile(path, "alpha\nbeta\n", "utf8");

		const sessionId = "hashline-integration-session";
		const sessionStartHandlers = [];
		const tools = new Map();
		registerHashline({
			on(event, handler) {
				if (event === "session_start") sessionStartHandlers.push(handler);
			},
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
		});

		const sessionManager = {
			getBranch: () => [],
			getSessionId: () => sessionId,
		};
		try {
			for (const handler of sessionStartHandlers) {
				await handler({}, {
					cwd: directory,
					isProjectTrusted: () => false,
					sessionManager,
				});
			}

			const readResult = await tools.get("read").execute(
				"read-call",
				{ path: "example.txt" },
				undefined,
				undefined,
				{
					cwd: directory,
					model: { input: ["text"] },
					sessionManager,
				},
			);
			const header = readResult.content[0].text.split("\n", 1)[0];

			await tools.get("edit").execute(
				"edit-call",
				{ input: `${header}\nSWAP 2:\n+updated` },
				undefined,
				undefined,
				{ cwd: directory, sessionManager },
			);

			expect(await readFile(path, "utf8")).toBe("alpha\nupdated\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
