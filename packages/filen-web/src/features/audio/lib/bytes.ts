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

// The real <audio> adapter — created lazily by the engine on first play, never mounted in JSX, so it
// survives every route change. `preload="metadata"` avoids eagerly streaming the whole file; both the
// SW route (Range/206) and a blob URL (in-memory random access) still seek past that point.
export function createDomAudioAdapter(events: AudioElementEvents): AudioElementAdapter {
	const element = document.createElement("audio")

	element.preload = "metadata"
	element.addEventListener("timeupdate", events.onTimeUpdate)
	element.addEventListener("durationchange", events.onDurationChange)
	element.addEventListener("ended", events.onEnded)
	element.addEventListener("error", events.onError)

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
		dispose: () => {
			element.removeEventListener("timeupdate", events.onTimeUpdate)
			element.removeEventListener("durationchange", events.onDurationChange)
			element.removeEventListener("ended", events.onEnded)
			element.removeEventListener("error", events.onError)
			element.pause()
			element.removeAttribute("src")
		}
	}
}
