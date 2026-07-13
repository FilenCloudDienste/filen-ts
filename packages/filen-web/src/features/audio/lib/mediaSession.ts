import type { ElementSample, QueueTrack } from "@/features/audio/store/audioQueue"

// The Media Session bridge — wires OS media keys / lock-screen controls (navigator.mediaSession) to the
// audio engine, both directions, entirely feature-detected so Safari/Firefox gaps degrade to no-ops.
// Split into pure, node-testable pieces (the action dispatch table + the metadata builder) and thin
// browser adapters (the publisher that writes metadata/playbackState/positionState, the action binder
// that installs handlers). Nothing here imports a DOM element or the engine module — the engine holds a
// MediaSessionPublisher (engine → OS), and the action binder is handed a plain action target
// (OS → engine); both are injected from audioEngine.ts, so the two modules never import each other.

// Resolved title/artist/album for the OS metadata surface — a structural subset of metadata.ts's
// TrackTags (this module deliberately has no import from metadata.ts; the engine passes a TrackTags
// value in directly, which satisfies this shape without conversion).
export interface TrackDisplayTags {
	title: string | null
	artist: string | null
	album: string | null
}

// A resolved cover-art blob URL plus its real mime type (from the embedded picture), so the OS artwork
// entry carries an accurate `type` hint.
export interface TrackArtwork {
	url: string
	type: string
}

// What the engine pushes OUT to the OS. A no-op implementation is a valid one (no Media Session
// support), so every caller invokes these unconditionally. `tags`/`artwork` are omitted for the
// as-soon-as-known publish (before metadata resolves) and supplied once extraction finishes.
export interface MediaSessionPublisher {
	setMetadata: (track: QueueTrack | null, tags?: TrackDisplayTags | null, artwork?: TrackArtwork | null) => void
	setPlaybackState: (state: MediaSessionPlaybackState) => void
	setPositionState: (sample: ElementSample) => void
}

export type MediaSessionPlaybackState = "none" | "paused" | "playing"

// The transport surface the OS action handlers dispatch INTO — a structural subset of the engine, so a
// test can drive the dispatch table with a plain fake and the real binder passes the engine itself.
export interface MediaSessionActionTarget {
	resume: () => void
	pause: () => void
	skipNext: () => void
	skipPrevious: () => void
	seek: (seconds: number) => void
}

// The four standard media actions plus seeking. `seekto` carries an absolute `seekTime` (seconds);
// `seekbackward`/`seekforward` carry an optional `seekOffset` (seconds, defaulting to a 10s nudge).
// Kept as our own minimal shape rather than lib.dom's MediaSessionActionDetails so the dispatch table
// is testable without a DOM lib and callable with a plain object.
export interface MediaSessionActionInfo {
	action: string
	seekTime?: number
	seekOffset?: number
}

// Default jump for seekbackward/seekforward when the OS supplies no explicit offset — the widely-used
// 10-second nudge.
const SEEK_NUDGE_SECONDS = 10

// The pure OS-action → target dispatch table. Returned as ordered [action, handler] pairs so the binder
// can install each and a test can assert the mapping without touching navigator. seekto/seekbackward/
// seekforward derive the target position from the supplied details plus the current position the caller
// threads in via `positionSeconds` (so a relative nudge lands on the live playhead). A handler for an
// action we don't implement is simply absent, so the binder clears it (passing null) rather than
// leaving a stale one from a previous track.
export function buildMediaSessionActionHandlers(
	target: MediaSessionActionTarget,
	positionSeconds: () => number
): [string, (info: MediaSessionActionInfo) => void][] {
	return [
		[
			"play",
			() => {
				target.resume()
			}
		],
		[
			"pause",
			() => {
				target.pause()
			}
		],
		[
			"previoustrack",
			() => {
				target.skipPrevious()
			}
		],
		[
			"nexttrack",
			() => {
				target.skipNext()
			}
		],
		[
			"seekto",
			info => {
				if (typeof info.seekTime === "number" && Number.isFinite(info.seekTime)) {
					target.seek(Math.max(0, info.seekTime))
				}
			}
		],
		[
			"seekbackward",
			info => {
				const offset = typeof info.seekOffset === "number" ? info.seekOffset : SEEK_NUDGE_SECONDS
				target.seek(Math.max(0, positionSeconds() - offset))
			}
		],
		[
			"seekforward",
			info => {
				const offset = typeof info.seekOffset === "number" ? info.seekOffset : SEEK_NUDGE_SECONDS
				target.seek(Math.max(0, positionSeconds() + offset))
			}
		]
	]
}

// Pure metadata projection for the current track. `tags` is the resolved (or not-yet-resolved) tag
// read: a resolved title wins over the filename (a tag read that came back with no title at all is
// `null`, not an empty string — see metadata.ts's tagsFromParsed); artist/album fall back to empty
// strings (the OS surface has no concept of "unknown", only absent). null for no current track (the
// binder clears the OS metadata).
export function mediaSessionMetadataFor(
	track: QueueTrack | null,
	tags?: TrackDisplayTags | null
): { title: string; artist: string; album: string } | null {
	if (!track) {
		return null
	}

	return { title: tags?.title ?? track.name, artist: tags?.artist ?? "", album: tags?.album ?? "" }
}

// The subset of navigator.mediaSession this module touches — declared structurally so a test can pass a
// fake and this module never depends on lib.dom's MediaSession type being present.
interface MediaSessionLike {
	metadata: unknown
	playbackState: string
	setActionHandler: (action: string, handler: ((info: MediaSessionActionInfo) => void) | null) => void
	setPositionState?: (state: { duration: number; position: number; playbackRate: number }) => void
}

// Resolves the live navigator.mediaSession, or null when unsupported (Firefox lacks some handlers,
// older Safari lacks it entirely). An explicit argument (tests) short-circuits the global lookup;
// `null` explicitly means "unsupported" so a test can exercise the degraded path.
function resolveMediaSession(explicit?: MediaSessionLike | null): MediaSessionLike | null {
	if (explicit !== undefined) {
		return explicit
	}

	if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
		return navigator.mediaSession as unknown as MediaSessionLike
	}

	return null
}

// Constructs a MediaMetadata when the global is available, else returns undefined so the publisher
// assigns nothing (never throws under a partial implementation). `sizes` is deliberately omitted from
// the artwork entry — the real pixel dimensions of an embedded picture are unknown without decoding it,
// and the field is optional in the MediaImage contract; browsers render fine without it.
function makeMetadata(fields: { title: string; artist: string; album: string }, artwork: TrackArtwork | null): unknown {
	if (typeof MediaMetadata === "undefined") {
		return undefined
	}

	return new MediaMetadata(artwork ? { ...fields, artwork: [{ src: artwork.url, type: artwork.type }] } : fields)
}

// The browser publisher (engine → OS). Every method no-ops when Media Session is unsupported. Position
// state is guarded against the non-finite/zero durations setPositionState rejects (it throws on those),
// and clamped so position never exceeds duration.
export function createMediaSessionPublisher(explicit?: MediaSessionLike | null): MediaSessionPublisher {
	const session = resolveMediaSession(explicit)

	if (!session) {
		return {
			setMetadata: () => undefined,
			setPlaybackState: () => undefined,
			setPositionState: () => undefined
		}
	}

	return {
		setMetadata: (track, tags, artwork) => {
			const fields = mediaSessionMetadataFor(track, tags)

			session.metadata = fields ? (makeMetadata(fields, artwork ?? null) ?? null) : null
		},
		setPlaybackState: state => {
			session.playbackState = state
		},
		setPositionState: sample => {
			if (typeof session.setPositionState !== "function") {
				return
			}

			const duration = sample.durationMs / 1000

			if (!Number.isFinite(duration) || duration <= 0) {
				return
			}

			const position = Math.max(0, Math.min(duration, sample.currentTimeMs / 1000))

			session.setPositionState({ duration, position, playbackRate: 1 })
		}
	}
}

// Installs the OS-action handlers (OS → engine), feature-detected. Each handler is wrapped so a throw
// inside setActionHandler for an action the browser doesn't support is swallowed (Chrome throws a
// NotSupportedError for unimplemented actions rather than ignoring them). Called once at startup — the
// handlers close over the live target, so they stay correct across every track.
export function bindMediaSessionActions(
	target: MediaSessionActionTarget,
	positionSeconds: () => number,
	explicit?: MediaSessionLike | null
): void {
	const session = resolveMediaSession(explicit)

	if (!session) {
		return
	}

	for (const [action, handler] of buildMediaSessionActionHandlers(target, positionSeconds)) {
		try {
			session.setActionHandler(action, handler)
		} catch {
			// Action unsupported by this browser — leave it unbound rather than failing the whole wiring.
		}
	}
}
