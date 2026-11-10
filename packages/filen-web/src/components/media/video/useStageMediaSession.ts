import { useEffect, useRef, useState } from "react"
import { mediaSessionOwners, type MediaSessionOwner } from "@/lib/media/mediaSessionOwner"
import { pauseMedia } from "@filen/shared/heldPause"
import { playMedia, seekMedia } from "@/lib/media/useMediaState"
import { MEDIA_SEEK_STEP_SECONDS } from "@/lib/media/mediaKeys.logic"

// The video stage's share of the Media Session: taken from the audio engine (which pauses) for as long as the
// stage is open, given back on close. Position state is published on discrete events only (play, pause,
// seek, rate, a new item), never per timeupdate: the OS extrapolates from the rate.

const SEEK_NUDGE_SECONDS = MEDIA_SEEK_STEP_SECONDS

export interface StageMediaInfo {
	title: string
	artist: string
	artworkUrl: string | null
}

function publishPosition(owner: MediaSessionOwner, video: HTMLVideoElement): void {
	const duration = video.duration

	if (!Number.isFinite(duration) || duration <= 0) {
		owner.setPositionState()

		return
	}

	owner.setPositionState({
		duration,
		position: Math.max(0, Math.min(duration, video.currentTime)),
		playbackRate: video.playbackRate > 0 ? video.playbackRate : 1
	})
}

export function useStageMediaSession(params: {
	video: HTMLVideoElement | null
	info: StageMediaInfo
	onNext: (() => void) | null
	onPrevious: (() => void) | null
	// Any OS media control used counts as the user touching the player (still watching).
	onInteraction?: () => void
}): void {
	const { video, info, onNext, onPrevious, onInteraction } = params
	const [owner] = useState(() => mediaSessionOwners.create("video"))
	const interaction = useRef(onInteraction)

	useEffect(() => {
		interaction.current = onInteraction
	})

	useEffect(() => {
		owner.acquire()

		return () => {
			owner.release()
		}
	}, [owner])

	useEffect(() => {
		if (typeof MediaMetadata === "undefined") {
			return
		}

		owner.setMetadata(
			new MediaMetadata({
				title: info.title,
				artist: info.artist,
				artwork:
					info.artworkUrl === null
						? [{ src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
						: [{ src: info.artworkUrl }]
			})
		)
	}, [owner, info.title, info.artist, info.artworkUrl])

	useEffect(() => {
		if (video === null) {
			return
		}

		const element = video

		function state(): void {
			owner.setPlaybackState(element.paused ? "paused" : "playing")
			publishPosition(owner, element)
		}

		function position(): void {
			publishPosition(owner, element)
		}

		const touched = (): void => {
			interaction.current?.()
		}

		owner.setActionHandler("play", () => {
			touched()
			playMedia(element)
		})
		owner.setActionHandler("pause", () => {
			touched()
			pauseMedia(element)
		})
		// The OS's Stop halts the picture where it is, as Pause.
		owner.setActionHandler("stop", () => {
			touched()
			pauseMedia(element)
		})
		owner.setActionHandler("seekto", details => {
			touched()

			if (typeof details.seekTime === "number" && Number.isFinite(details.seekTime)) {
				seekMedia(element, details.seekTime)
			}
		})
		owner.setActionHandler("seekbackward", details => {
			touched()
			seekMedia(element, element.currentTime - (details.seekOffset ?? SEEK_NUDGE_SECONDS))
		})
		owner.setActionHandler("seekforward", details => {
			touched()
			seekMedia(element, element.currentTime + (details.seekOffset ?? SEEK_NUDGE_SECONDS))
		})
		owner.setActionHandler("enterpictureinpicture", () => {
			touched()
			void element.requestPictureInPicture().catch(() => undefined)
		})

		state()

		const stateEvents = ["play", "pause", "ended", "emptied"]
		const positionEvents = ["seeked", "ratechange", "loadedmetadata", "durationchange"]

		for (const event of stateEvents) {
			element.addEventListener(event, state)
		}

		for (const event of positionEvents) {
			element.addEventListener(event, position)
		}

		return () => {
			for (const event of stateEvents) {
				element.removeEventListener(event, state)
			}

			for (const event of positionEvents) {
				element.removeEventListener(event, position)
			}
		}
	}, [owner, video])

	useEffect(() => {
		owner.setActionHandler(
			"nexttrack",
			onNext === null
				? null
				: () => {
						interaction.current?.()
						onNext()
					}
		)
		owner.setActionHandler(
			"previoustrack",
			onPrevious === null
				? null
				: () => {
						interaction.current?.()
						onPrevious()
					}
		)
	}, [owner, onNext, onPrevious])
}
