/**
 * Session-local grounding state shared by the hashline read, edit, and write tools.
 *
 * Each file revision records the exact source-line intervals shown to the model.
 * Successful full-file writes record the complete resulting content because the model
 * supplied it directly. State is intentionally in-memory and is discarded on process
 * exit; a resumed session must read again before editing.
 */

import { resolve } from "node:path";

export const HASHLINE_TAG_LENGTH = 16;
export const HASHLINE_TAG_PATTERN = `[0-9A-Fa-f]{${HASHLINE_TAG_LENGTH}}`;

interface Interval {
	start: number;
	end: number;
}

interface RevisionCoverage {
	lineCount: number;
	intervals: Interval[];
}

const sessions = new Map<string, Map<string, Map<string, RevisionCoverage>>>();

function pathKey(path: string): string {
	const absolute = resolve(path);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function revisionFor(
	sessionId: string,
	path: string,
	tag: string,
	lineCount: number,
): RevisionCoverage {
	let files = sessions.get(sessionId);
	if (!files) {
		files = new Map();
		sessions.set(sessionId, files);
	}
	const key = pathKey(path);
	let revisions = files.get(key);
	if (!revisions) {
		revisions = new Map();
		files.set(key, revisions);
	}
	let coverage = revisions.get(tag);
	if (!coverage || coverage.lineCount !== lineCount) {
		coverage = { lineCount, intervals: [] };
		revisions.set(tag, coverage);
	}
	return coverage;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
	const sorted = [...intervals].sort((left, right) => left.start - right.start);
	const merged: Interval[] = [];
	for (const interval of sorted) {
		const previous = merged.at(-1);
		if (!previous || interval.start > previous.end + 1) {
			merged.push({ ...interval });
		} else {
			previous.end = Math.max(previous.end, interval.end);
		}
	}
	return merged;
}

export function recordHashlineRange(
	sessionId: string,
	path: string,
	tag: string,
	lineCount: number,
	start: number,
	end: number,
): void {
	if (start < 1 || end < start || end > lineCount) return;
	const coverage = revisionFor(sessionId, path, tag, lineCount);
	coverage.intervals = mergeIntervals([...coverage.intervals, { start, end }]);
}

export function recordCompleteHashlineContent(
	sessionId: string,
	path: string,
	tag: string,
	lineCount: number,
): void {
	const coverage = revisionFor(sessionId, path, tag, lineCount);
	coverage.intervals = lineCount === 0 ? [] : [{ start: 1, end: lineCount }];
}

export function getHashlineCoverage(
	sessionId: string,
	path: string,
	tag: string,
): RevisionCoverage | undefined {
	return sessions.get(sessionId)?.get(pathKey(path))?.get(tag);
}

export function coversHashlineRange(
	coverage: RevisionCoverage,
	start: number,
	end: number,
): boolean {
	return coverage.intervals.some(
		(interval) => interval.start <= start && interval.end >= end,
	);
}

export function clearHashlineSession(sessionId: string): void {
	sessions.delete(sessionId);
}
