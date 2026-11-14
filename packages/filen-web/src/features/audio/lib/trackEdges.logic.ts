import { type } from "arktype"
import { TRACK_EDGES_KV_PREFIX, type TrackEdges } from "@/features/audio/lib/smoothTransitions.types"
import {
	EDGE_WINDOWS,
	ENVELOPE_WINDOW_MS,
	FADE_DROP_DB,
	FADE_MIN_TAIL_OFFSET_MS,
	FADE_REFERENCE_PERCENTILE,
	FADE_RISE_TOLERANCE_DB,
	FADE_SMOOTHING_MS,
	MAX_IN_START_MS,
	SILENCE_DB
} from "@/workers/remux/edges.logic"
import { TAIL_PADDING } from "@/workers/remux/tailWindow.logic"

// A track's edge analysis as persisted per file uuid (one kv row each, read one at a time, never hydrated in
// bulk). A uuid rotates with the file's content, so uuid keying is the whole invalidation story for the file;
// the analyzer's version covers the analysis itself.

// Every parameter an analysis depends on, the byte budget included: changing any of them re-analyses every
// stored row, `skipped` ones too.
export const EDGE_ANALYZER_VERSION = [
	1,
	ENVELOPE_WINDOW_MS,
	SILENCE_DB,
	MAX_IN_START_MS,
	FADE_DROP_DB,
	FADE_RISE_TOLERANCE_DB,
	FADE_REFERENCE_PERCENTILE,
	FADE_SMOOTHING_MS,
	FADE_MIN_TAIL_OFFSET_MS,
	TAIL_PADDING,
	EDGE_WINDOWS.headSeconds,
	EDGE_WINDOWS.tailSeconds,
	EDGE_WINDOWS.boundarySeconds,
	EDGE_WINDOWS.maxWindowBytes
].join(":")

// The element's duration and the analysed one may differ this much before the edges count as another file's.
export const EDGE_DURATION_TOLERANCE_MS = 1500

const msOrNull = "number >= 0 | null"

export const trackEdgesRecordSchema = type({
	v: "string",
	status: "'ok' | 'skipped' | 'failed'",
	durationSec: "number > 0 | null",
	inStartMs: msOrNull,
	outEndFromEndMs: msOrNull,
	fadeOutFromEndMs: msOrNull,
	boundary: type({ headDb: "number", tailDb: "number" }).or("null"),
	at: "number"
})

export type TrackEdgesRecord = typeof trackEdgesRecordSchema.infer

export function trackEdgesKey(uuid: string): string {
	return `${TRACK_EDGES_KV_PREFIX}${uuid}`
}

export function toEdgesRecord(edges: TrackEdges, at: number): TrackEdgesRecord {
	return { v: EDGE_ANALYZER_VERSION, ...edges, at }
}

// The edges a stored record holds; null for one an older analyzer wrote (as good as missing).
export function edgesFromRecord(record: TrackEdgesRecord): TrackEdges | null {
	if (record.v !== EDGE_ANALYZER_VERSION) {
		return null
	}

	return {
		status: record.status,
		durationSec: record.durationSec,
		inStartMs: record.inStartMs,
		outEndFromEndMs: record.outEndFromEndMs,
		fadeOutFromEndMs: record.fadeOutFromEndMs,
		boundary: record.boundary
	}
}

// Whether `edges` were measured on what the element plays: a duration further off says another decode (or a VBR
// estimate gone wrong), whose edge times would land in the wrong place.
export function edgesMatchDuration(edges: TrackEdges, elementDurationMs: number): boolean {
	return (
		edges.durationSec !== null &&
		Number.isFinite(elementDurationMs) &&
		Math.abs(edges.durationSec * 1000 - elementDurationMs) <= EDGE_DURATION_TOLERANCE_MS
	)
}

// Where an analysis queues for a background range-read permit: behind everything else (tags, covers at any rank,
// thumbnails and probes), since it must never delay something the user sees.
export const EDGE_ANALYSIS_RANK = Number.MAX_SAFE_INTEGER
