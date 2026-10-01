import { useEffect, useState } from "react"
import type { BlockSource } from "@/lib/media/blockSource"
import { browserCanPlay, readContainerTracks, unplayableTracks, type CodecId, type TrackKind } from "@/features/preview/lib/containerTracks"

// Playback a browser must have decoded something of by now if it can decode the track at all.
const PLAYED_SECONDS_BEFORE_CHECK = 1.5

// Whether a playing element decoded any audio, from whichever non-standard counter this engine has;
// null where it has none.
function decodedAudio(video: HTMLVideoElement): boolean | null {
	if ("webkitAudioDecodedByteCount" in video && typeof video.webkitAudioDecodedByteCount === "number") {
		return video.webkitAudioDecodedByteCount > 0
	}

	if ("mozHasAudio" in video && typeof video.mozHasAudio === "boolean") {
		return video.mozHasAudio
	}

	if ("audioTracks" in video && typeof video.audioTracks === "object" && video.audioTracks !== null && "length" in video.audioTracks) {
		return video.audioTracks.length !== 0
	}

	return null
}

// The track kinds a playing element shows no sign of decoding. Only a suspicion: a file without an
// audio track decodes no audio either, which is what the container read settles.
export function undecodedKinds(video: HTMLVideoElement): TrackKind[] {
	const kinds: TrackKind[] = []

	if (video.videoWidth === 0 || video.getVideoPlaybackQuality().totalVideoFrames === 0) {
		kinds.push("video")
	}

	if (decodedAudio(video) === false) {
		kinds.push("audio")
	}

	return kinds
}

// A codec of a video that plays without its sound or its picture, because the browser cannot decode
// that track. Costs one listener until ~1.5s of playback; the container is read only when the element
// decoded nothing of a kind, and the gap is reported only for a track the browser itself says it cannot
// decode, so a file without that track, or one the browser merely has not got to, stays quiet.
export function usePlaybackGap(video: HTMLVideoElement | null, source: BlockSource): CodecId | null {
	const [gap, setGap] = useState<CodecId | null>(null)

	useEffect(() => {
		if (video === null) {
			return
		}

		const element = video
		let live = true
		let played = 0
		let last = element.currentTime

		function handleTimeUpdate(): void {
			const delta = element.currentTime - last

			last = element.currentTime

			// A seek or a loop back is not playback.
			if (element.seeking || delta <= 0 || delta > 1) {
				return
			}

			played += delta

			if (played < PLAYED_SECONDS_BEFORE_CHECK) {
				return
			}

			element.removeEventListener("timeupdate", handleTimeUpdate)

			const kinds = undecodedKinds(element)

			if (kinds.length === 0) {
				return
			}

			void readContainerTracks(source).then(
				tracks => {
					const codec = tracks === null ? undefined : unplayableTracks(tracks, kinds, browserCanPlay(element))[0]

					if (live && codec !== undefined) {
						setGap(codec)
					}
				},
				() => undefined
			)
		}

		element.addEventListener("timeupdate", handleTimeUpdate)

		return () => {
			live = false
			element.removeEventListener("timeupdate", handleTimeUpdate)
		}
	}, [video, source])

	return gap
}
