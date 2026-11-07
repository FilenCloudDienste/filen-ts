import {
	holdPreviewStreamAlive,
	isMediaStreamAvailable,
	previewStreamUrl,
	releasePreviewStream
} from "@/features/preview/lib/previewStream"
import { fileTypeExtension } from "@/features/drive/lib/preview.logic"
import { ErrorWithDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { classifyMediaError, mediaFailureDTO, type MediaFailureKind } from "@/lib/media/mediaFailure"
import { BlockSource } from "@filen/shared/videos"
import { urlReadRange } from "@/lib/media/urlReadRange"
import { cancelHeldPause, pauseMedia } from "@/lib/media/heldPause"
import { audioDemotions, audioRoute } from "@/lib/media/audioRoute.logic"
import { audioMediaSource, openDecodedAudioStream } from "@/lib/media/playback/audioStream"
import { isAudioUnsupported } from "@/lib/media/remuxTypes"
import type { QueueTrack } from "@/features/audio/store/audioQueue"
import type { AudioElementAdapter, AudioElementEvents, TrackSource } from "@/features/audio/lib/engine"
import type { ElementSample } from "@/features/audio/store/audioQueue"

// The browser-only half of the audio engine: the concrete media-element adapter and the track→source
// resolver. Kept out of engine.ts (which stays node-testable) so the singleton can inject these while
// the engine's own logic imports nothing that constructs a Worker/DOM element.

function aborted(signal: AbortSignal): never {
	throw signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError")
}

// Resolve a track to a streamed source; nothing is ever held whole. With a service worker controlling the
// tab, a file the browser plays as it is streams through its range route, and one it cannot (Matroska audio,
// bare AC-3/DTS, a codec the browser lacks, learned from a failure of the file as it is) is decoded in the
// remux worker into a WAV stream the same route serves, so the element still plays a URL; the service worker
// is kept from idling out (and losing the registration) for as long as the source lives, paused included.
// Without one, the remux worker feeds the element through MediaSource. The audio module owns only authed, drive-hosted audio
// (the anon public-link page keeps its own surface).
export async function resolveTrackSource(track: QueueTrack, signal: AbortSignal): Promise<TrackSource> {
	signal.throwIfAborted()

	if (isMediaStreamAvailable()) {
		const route = audioRoute({
			extension: fileTypeExtension(track.name, track.mime, track.uuid),
			contentType: track.contentType,
			demoted: audioDemotions.has(track.uuid)
		})

		if (route === "direct" && track.contentType !== null) {
			const id = crypto.randomUUID()
			const url = await previewStreamUrl(track.file, track.name, track.contentType, id)

			if (signal.aborted) {
				releasePreviewStream(id)
				aborted(signal)
			}

			const bytes = new BlockSource(Number(track.file.size), urlReadRange(url))
			const alive = holdPreviewStreamAlive()

			return {
				media: { kind: "url", url },
				classify: code => classifyMediaError(code, bytes),
				release: () => {
					releasePreviewStream(id)
					alive()
				},
				demote: () => {
					audioDemotions.add(track.uuid)
				}
			}
		}

		try {
			const stream = await openDecodedAudioStream({ file: track.file, access: "authed" })

			if (signal.aborted) {
				stream.release()
				aborted(signal)
			}

			const alive = holdPreviewStreamAlive()

			return {
				media: { kind: "url", url: stream.url },
				// The stream is decodable by construction: a failure of it is the stream's, not the format's.
				classify: () => Promise.resolve("other"),
				release: () => {
					stream.release()
					alive()
				}
			}
		} catch (error) {
			if (isAudioUnsupported(error)) {
				throw new ErrorWithDTO(mediaFailureDTO("format"))
			}

			signal.throwIfAborted()
			// The service worker could not take the stream: MediaSource below.
		}
	}

	const media = audioMediaSource({ file: track.file, access: "authed" })

	return {
		media: {
			kind: "session",
			attach: (element, onFailure) => media.attach(element, { onFailure })
		},
		classify: () => Promise.resolve("other"),
		release: () => {
			media.dispose()
		}
	}
}

// The shared element builder. `events` is mutable (via `rebind`) rather than captured once in the
// listener closures: the prefetch element is created with inert events while it warms silently in the
// background, then rebound to the real playback events at the instant the engine promotes it — without
// tearing down and recreating the underlying element, which would lose whatever the browser already
// buffered/decoded.
function createDomAudioAdapterWithPreload(initialEvents: AudioElementEvents, preload: "metadata" | "auto"): AudioElementAdapter {
	const element = document.createElement("audio")
	let events = initialEvents
	let source: TrackSource | null = null
	// A MediaSource session still attaching: playing waits for it, there is nothing to play before.
	let attaching: Promise<void> | null = null
	let failure: { error: MediaError; dto: Promise<ErrorDTO> } | null = null

	// One classification per failure of the loaded source, shared by the error event and the play() the
	// failure rejects, so whichever reaches the engine first carries the kind and the other is superseded.
	function classifyFailure(): Promise<ErrorDTO> | null {
		const error = element.error

		if (error === null || source === null) {
			return null
		}

		if (failure?.error !== error) {
			failure = { error, dto: source.classify(error.code).then(mediaFailureDTO) }
		}

		return failure.dto
	}

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
		const error = element.error

		events.onError(async () => {
			const dto = await classifyFailure()

			// Null once the element has been handed another source: the failure is of bytes nothing plays.
			return element.error === error ? dto : null
		})
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
		load: next => {
			source = next
			failure = null

			if (next.media.kind === "url") {
				attaching = null
				element.src = next.media.url
				element.load()

				return
			}

			element.removeAttribute("src")
			// A failure the session detects itself, while it is still the element's source.
			attaching = next.media.attach(element, (kind: MediaFailureKind) => {
				if (source === next) {
					events.onError(() => Promise.resolve(source === next ? mediaFailureDTO(kind) : null))
				}
			})
		},
		// A rejection carries the element's own classified failure where there is one, so a source the
		// browser cannot play reports its format, whichever of this and the error event comes first.
		play: async () => {
			await attaching

			// Playing is asked for after a pause still held for a seek (heldPause.ts): the pause is dropped.
			cancelHeldPause(element)

			await element.play().catch(async () => {
				throw new ErrorWithDTO((await classifyFailure()) ?? mediaFailureDTO("other"))
			})
		},
		pause: () => {
			pauseMedia(element)
		},
		seek: seconds => {
			element.currentTime = seconds
		},
		clear: () => {
			cancelHeldPause(element)
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
			cancelHeldPause(element)
			element.pause()
			element.removeAttribute("src")
		}
	}
}

// The main playback element — created lazily by the engine, never mounted in JSX, so it survives every
// route change. `preload="metadata"` avoids eagerly streaming the whole file; the SW route (Range/206) and a
// MediaSource session both seek past that point.
export function createDomAudioAdapter(events: AudioElementEvents): AudioElementAdapter {
	return createDomAudioAdapterWithPreload(events, "metadata")
}

// The one-track-ahead warm-up element. `preload="auto"` tells the browser to actively buffer/decode as
// soon as a src is set — the whole point of prefetching (engine.ts's promotePrefetch rebinds this same
// element into the main slot instead of recreating it, preserving that warm buffer).
export function createDomPrefetchAdapter(events: AudioElementEvents): AudioElementAdapter {
	return createDomAudioAdapterWithPreload(events, "auto")
}
