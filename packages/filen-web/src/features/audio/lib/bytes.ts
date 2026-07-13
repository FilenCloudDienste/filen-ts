import { isMediaStreamAvailable, previewStreamUrl } from "@/features/preview/lib/previewStream"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import type { QueueTrack } from "@/features/audio/store/audioQueue"
import type { AudioElementAdapter, AudioElementEvents, TrackSource } from "@/features/audio/lib/engine"
import type { ElementSample } from "@/features/audio/store/audioQueue"

// The browser-only half of the audio engine: the concrete media-element adapter and the track→source
// resolver. Kept out of engine.ts (which stays node-testable) so the singleton can inject these while
// the engine's own logic imports nothing that constructs a Worker/DOM element. Mirrors mediaViewer.tsx's
// own byte-source choice — SW inline stream when available, whole-buffer blob fallback otherwise.

// Resolve a track to a playable src. The audio module owns only authed, drive-hosted audio (the anon
// public-link page keeps its own surface), so this never branches on an anon access mode. The SW route
// is preferred when a service worker controls the tab AND the file has an allowlisted inline
// content-type (Range/206-seekable, decrypt-in-SW); otherwise a whole-buffer decrypted download is
// played back from an object URL the engine revokes on the next track switch.
export async function resolveTrackSource(track: QueueTrack): Promise<TrackSource> {
	if (isMediaStreamAvailable() && track.contentType !== null) {
		const url = await previewStreamUrl(track.file, track.name, track.contentType)

		return { kind: "stream", url }
	}

	const token = crypto.randomUUID()
	const bytes = await runOp(sdkApi.downloadFileBytes(track.file, token))
	const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: track.mime || "application/octet-stream" }))

	return { kind: "blob", url }
}

// The shared element builder. `events` is mutable (via `rebind`) rather than captured once in the
// listener closures: the prefetch element is created with inert events while it warms silently in the
// background, then rebound to the real playback events at the instant the engine promotes it — without
// tearing down and recreating the underlying element, which would lose whatever the browser already
// buffered/decoded.
function createDomAudioAdapterWithPreload(initialEvents: AudioElementEvents, preload: "metadata" | "auto"): AudioElementAdapter {
	const element = document.createElement("audio")
	let events = initialEvents

	element.preload = preload
	element.addEventListener("timeupdate", () => {
		events.onTimeUpdate()
	})
	element.addEventListener("durationchange", () => {
		events.onDurationChange()
	})
	element.addEventListener("ended", () => {
		events.onEnded()
	})
	element.addEventListener("error", () => {
		events.onError()
	})

	function sample(): ElementSample {
		return {
			currentTimeMs: element.currentTime * 1000,
			durationMs: Number.isFinite(element.duration) ? element.duration * 1000 : 0,
			paused: element.paused,
			ended: element.ended
		}
	}

	return {
		load: src => {
			element.src = src
			element.load()
		},
		play: () => element.play(),
		pause: () => {
			element.pause()
		},
		seek: seconds => {
			element.currentTime = seconds
		},
		clear: () => {
			element.removeAttribute("src")
			element.load()
		},
		setVolume: volume => {
			element.volume = volume
		},
		setMuted: muted => {
			element.muted = muted
		},
		sample,
		rebind: nextEvents => {
			events = nextEvents
		},
		dispose: () => {
			element.pause()
			element.removeAttribute("src")
		}
	}
}

// The main playback element — created lazily by the engine, never mounted in JSX, so it survives every
// route change. `preload="metadata"` avoids eagerly streaming the whole file; both the SW route
// (Range/206) and a blob URL (in-memory random access) still seek past that point.
export function createDomAudioAdapter(events: AudioElementEvents): AudioElementAdapter {
	return createDomAudioAdapterWithPreload(events, "metadata")
}

// The one-track-ahead warm-up element. `preload="auto"` tells the browser to actively buffer/decode as
// soon as a src is set — the whole point of prefetching (engine.ts's promotePrefetch rebinds this same
// element into the main slot instead of recreating it, preserving that warm buffer).
export function createDomPrefetchAdapter(events: AudioElementEvents): AudioElementAdapter {
	return createDomAudioAdapterWithPreload(events, "auto")
}
