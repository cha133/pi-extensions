/**
 * Hashline text tools -- register the read, edit, and write overrides together.
 *
 * Pi evaluates each discovered extension in an isolated Jiti module graph, so related
 * tools cannot safely communicate through module-level state imported by separate
 * extension files. This single entry point creates one explicit session-grounding
 * state and injects it into all three tool implementations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEdit } from "./lib/edit.js";
import { HashlineState } from "./lib/hashline-state.js";
import { registerRead } from "./lib/read.js";
import { registerWrite } from "./lib/write.js";

export default function (pi: ExtensionAPI): void {
	const state = new HashlineState();
	registerRead(pi, state);
	registerEdit(pi, state);
	registerWrite(pi, state);
}
