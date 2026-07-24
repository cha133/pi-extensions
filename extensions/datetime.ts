/**
 * Session datetime -- add the session's creation date and time to the system prompt.
 *
 * The formatted value is persisted as session metadata and reused on every turn and
 * resume, keeping the prompt prefix stable. Forks receive their own value because the
 * persisted metadata is keyed by session ID.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "session-datetime";

interface DatetimeState {
	sessionId: string;
	prompt: string;
}

interface CustomDatetimeEntry {
	type: "custom";
	customType: string;
	data?: DatetimeState;
}

function isDatetimeEntry(entry: unknown): entry is CustomDatetimeEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const candidate = entry as Partial<CustomDatetimeEntry>;
	return candidate.type === "custom" && candidate.customType === ENTRY_TYPE;
}

/** Format an instant in a fixed IANA time zone without depending on the user's locale. */
export function formatSessionDatetime(timestamp: string, timeZone: string): string | undefined {
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
	const localTimestamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;

	return [
		"## Session datetime",
		"",
		`This session started at ${localTimestamp} (${timeZone}; ${instant.toISOString()}).`,
		"Treat this as the fixed current date and time for this session. It intentionally does not update on later turns or after resume.",
	].join("\n");
}

function restorePrompt(ctx: ExtensionContext): string | undefined {
	const sessionId = ctx.sessionManager.getSessionId();
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isDatetimeEntry(entry)) continue;
		if (entry.data?.sessionId === sessionId && typeof entry.data.prompt === "string") {
			return entry.data.prompt;
		}
	}
	return undefined;
}

export function registerDatetime(pi: ExtensionAPI) {
	let prompt: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		prompt = restorePrompt(ctx);
		if (prompt) return;

		const header = ctx.sessionManager.getHeader();
		if (!header) return;

		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		prompt = formatSessionDatetime(header.timestamp, timeZone);
		if (!prompt) return;

		pi.appendEntry<DatetimeState>(ENTRY_TYPE, {
			sessionId: ctx.sessionManager.getSessionId(),
			prompt,
		});
	});

	pi.on("before_agent_start", (event) => {
		if (!prompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
}

export default function (pi: ExtensionAPI) {
	registerDatetime(pi);
}
