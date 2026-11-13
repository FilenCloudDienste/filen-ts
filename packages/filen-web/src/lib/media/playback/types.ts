import type { AudioMode } from "@/lib/media/remuxTypes"

// The playable rungs of the playback ladder, each served by one session kind: the service worker's range
// route ("direct") or the remux worker into MediaSource (the rest).
export type SessionPath = "direct" | "remux" | "remux+transcode" | "video-only"

// Why a session gave up on its rung.
// - media-error: MediaError 3 (decode) or 4 (source not supported) the session could not recover from.
// - no-metadata: a direct stream produced no loadedmetadata in time.
// - no-first-frame: no frame was presented in time after canplay while playing.
// - decode-stall: data buffered ahead, yet the element stays below HAVE_FUTURE_DATA.
// - silent-audio: audio was expected, none was decoded.
// - worker-error: the remux worker, a decoder or the encoder failed.
// - stream-unavailable: the service worker could not take the stream (none controls the page, the
//   registration failed); the next rung reads through the SDK worker instead.
// - network: the file's bytes could not be read, and recovery did not help.
// - keyframe-interval: one keyframe interval holds more than a SourceBuffer can.
// - open-gop-start: video must start at an IDR picture (Firefox with HEVC) and none lies within reach.
export type PlaybackTrigger =
	| "media-error"
	| "no-metadata"
	| "no-first-frame"
	| "decode-stall"
	| "silent-audio"
	| "worker-error"
	| "stream-unavailable"
	| "network"
	| "keyframe-interval"
	| "open-gop-start"

export interface PlaybackFailure {
	trigger: PlaybackTrigger
	detail: string
	// False when the failure cannot be told from a fault of the moment (a watchdog that ran while the tab
	// was hidden), so nothing about the browser is learned from it.
	learnable?: boolean
}

// What a session reports to the playback that owns it.
export interface SessionCallbacks {
	onFailure(failure: PlaybackFailure): void
	// A lost stream is being re-established; the session's own watchdogs say nothing meanwhile.
	onReconnecting(reconnecting: boolean): void
}

// The audio a session plays: the probe's track (index into its audio list, and the remux engine's id for it)
// and how it reaches the element.
export interface SessionAudio {
	index: number
	trackId: number
	mode: AudioMode
}

// One rung's playback of one file into one element. The player drives the element itself (play, pause,
// seek through currentTime); a session supplies its source and keeps it flowing.
export interface PlaybackSession {
	readonly path: SessionPath
	// Sets the element's source and starts loading from the session's start time.
	attach(video: HTMLVideoElement): Promise<void>
	// Switches audio in place; false when this session cannot, and a new session has to.
	selectAudio(audio: SessionAudio): Promise<boolean>
	// Empties the element and releases everything held for the stream.
	dispose(): void
}
