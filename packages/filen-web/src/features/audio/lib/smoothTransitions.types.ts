import type { QueueTrack } from "@/features/audio/store/audioQueue"

// The shared contract of smooth transitions (a crossfade between tracks, smart edges and loudness matching): the
// prefs, the analysis records and the seams between the engine, the Web Audio output and the edge analysis.

// iOS and iPadOS stay off until the locked-iPhone hardware gate passes: background Web Audio there is the risk.
export const SMOOTH_TRANSITIONS_APPLE_MOBILE = false

export const SMOOTH_TRANSITIONS_PREFS_KEY = "audio.v1.smoothTransitions"

export const FADE_SECONDS_MIN = 1
export const FADE_SECONDS_MAX = 12
export const FADE_SECONDS_DEFAULT = 6
// The phone control's segments; any other whole second is a custom length.
export const FADE_SECONDS_PRESETS = [3, 6, 9, 12] as const

// What a skip the user asked for does: switch at once, or a short fade into the target.
export const MANUAL_TRANSITIONS = ["cut", "fade"] as const

export type ManualTransition = (typeof MANUAL_TRANSITIONS)[number]

export interface SmoothTransitionsPrefs {
	enabled: boolean
	fadeSeconds: number
	manualTransition: ManualTransition
	matchLoudness: boolean
}

export const DEFAULT_SMOOTH_TRANSITIONS_PREFS: SmoothTransitionsPrefs = {
	enabled: false,
	fadeSeconds: FADE_SECONDS_DEFAULT,
	manualTransition: "cut",
	matchLoudness: true
}

// Why the feature cannot run right now: the device is gated, the device stopped the mixer this session, or the
// browser cannot route the playing source through Web Audio.
export type SmoothTransitionsUnavailable = "appleMobileGated" | "degraded" | "sourceIneligible"

// How a track's source reached the element: the file as it is through the service worker, its audio decoded into a
// WAV stream the service worker serves, or a MediaSource session (no service worker).
export type SourceRoute = "direct" | "transcode" | "session"

// Per-uuid edge analysis, persisted under this prefix (one row per track).
export const TRACK_EDGES_KV_PREFIX = "audio.v1.edges."

// `ok`: analysed. `skipped`: the windows were past the byte budget (only `boundary` is known). `failed`: undecodable.
export type TrackEdgesStatus = "ok" | "skipped" | "failed"

// RMS of the first and last second, in dBFS.
export interface EdgeBoundary {
	headDb: number
	tailDb: number
}

// Times are ms. `inStartMs` is where audio starts past leading silence; `outEndFromEndMs` how far before the end the
// audio stops (null when the tail could not be seen); `fadeOutFromEndMs` how far before the end a long fade-out
// starts (null without one).
export interface TrackEdges {
	status: TrackEdgesStatus
	durationSec: number | null
	inStartMs: number | null
	outEndFromEndMs: number | null
	fadeOutFromEndMs: number | null
	boundary: EdgeBoundary | null
}

export interface TrackEdgesRequestOptions {
	// Only the memory and kv caches: a track that was never the incoming one is not analysed.
	cachedOnly?: boolean
}

// The engine's analysis seam. Null when nothing is known (not analysed, a read failed, the route is skipped, or the
// request was aborted). Never rejects.
export type GetTrackEdges = (
	track: QueueTrack,
	route: SourceRoute,
	signal: AbortSignal,
	options?: TrackEdgesRequestOptions
) => Promise<TrackEdges | null>
