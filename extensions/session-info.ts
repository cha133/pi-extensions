/**
 * Session info -- add fixed first-turn metadata to the system prompt.
 *
 * The datetime and model are captured together immediately before the first agent
 * turn, then persisted and reused on every later turn and resume. This keeps the
 * prompt prefix stable while allowing the user to wait or switch models before
 * sending the first message.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "session-info";

interface SessionInfoState {
	sessionId: string;
	prompt: string;
}

interface CustomSessionInfoEntry {
	type: "custom";
	customType: string;
	data?: SessionInfoState;
}

function isCustomEntry(entry: unknown, customType: string): entry is CustomSessionInfoEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const candidate = entry as Partial<CustomSessionInfoEntry>;
	return candidate.type === "custom" && candidate.customType === customType;
}

/** Format an instant in a fixed IANA time zone without depending on the user's locale. */
function formatDatetime(timestamp: string, timeZone: string): string | undefined {
	const instant = new Date(timestamp);
	if (Number.isNaN(instant.getTime())) return undefined;

	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	const parts = Object.fromEntries(
		formatter
			.formatToParts(instant)
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, part.value]),
	);

	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} (${timeZone}; ${instant.toISOString()})`;
}

/** Build the stable first-turn system-prompt block persisted for a session. */
export function formatSessionInfo(timestamp: string, timeZone: string, model: Model<any>): string | undefined {
	const datetime = formatDatetime(timestamp, timeZone);
	if (!datetime) return undefined;

	return [
		"## Session info",
		"",
		`The first user message in this session was submitted at ${datetime}.`,
		`The model selected for the first turn is ${model.provider}/${model.id} (${model.name}).`,
		"Treat the first-message datetime and first-turn model as fixed session metadata. They intentionally do not update on later turns, after model switches, or after resume.",
	].join("\n");
}

function restorePrompt(ctx: ExtensionContext): string | undefined {
	const sessionId = ctx.sessionManager.getSessionId();
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isCustomEntry(entry, ENTRY_TYPE)) continue;
		if (entry.data?.sessionId === sessionId && typeof entry.data.prompt === "string") {
			return entry.data.prompt;
		}
	}
	return undefined;
}

export function registerSessionInfo(
	pi: ExtensionAPI,
	now: () => Date = () => new Date(),
	getTimeZone: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
) {
	let prompt: string | undefined;
	let sessionId: string | undefined;

	const persistPrompt = (value: string) => {
		prompt = value;
		pi.appendEntry<SessionInfoState>(ENTRY_TYPE, {
			sessionId: sessionId!,
			prompt: value,
		});
	};

	const initializePrompt = (model: Model<any> | undefined) => {
		if (prompt || !model || !sessionId) return;

		const value = formatSessionInfo(now().toISOString(), getTimeZone(), model);
		if (value) persistPrompt(value);
	};

	pi.on("session_start", (_event, ctx) => {
		prompt = restorePrompt(ctx);
		sessionId = ctx.sessionManager.getSessionId();
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Capture both values here, not at session_start: the user may wait or switch
		// models before submitting the first message.
		initializePrompt(ctx.model);
		if (!prompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
}

export default function (pi: ExtensionAPI) {
	registerSessionInfo(pi);
}
