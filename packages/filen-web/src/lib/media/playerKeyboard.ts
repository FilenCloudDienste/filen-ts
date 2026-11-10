import type { KeyboardEvent } from "react"
import { pauseMedia } from "@filen/shared/heldPause"
import { isRecordingCombo } from "@/lib/keymap/registry"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { fullscreenSupported, toggleFullscreen } from "@/lib/media/fullscreen"
import { MEDIA_JUMP_ACTIONS, type MediaAction } from "@/lib/media/keymap"
import {
	MEDIA_LONG_SEEK_STEP_SECONDS,
	MEDIA_SEEK_STEP_SECONDS,
	MEDIA_VOLUME_STEP,
	jumpFraction,
	mediaKeyAction,
	mediaKeyRepeats
} from "@/lib/media/mediaKeys.logic"
import { playerKeyTarget } from "@/lib/media/playerKeys.logic"
import { stepMediaVolume, toggleMediaMuted } from "@/lib/media/mediaVolume"
import { frameDuration, stepPlaybackRate } from "@/lib/media/videoKeys.logic"
import { mediaDuration, seekMedia, setPlaybackRate, toggleMediaPlayback } from "@/lib/media/useMediaState"

const IS_MAC = isMacPlatform()

// The preview player's media keys: what a lone <video> can do. Fullscreen joins them where the browser has it.
const PREVIEW_VIDEO_ACTIONS: readonly MediaAction[] = [
	"media.playPause",
	"media.seekBack",
	"media.seekForward",
	"media.seekBackLong",
	"media.seekForwardLong",
	"media.toStart",
	"media.toEnd",
	...MEDIA_JUMP_ACTIONS,
	"media.volumeUp",
	"media.volumeDown",
	"media.mute",
	"media.slower",
	"media.faster",
	"media.normalSpeed",
	"media.frameBack",
	"media.frameForward",
	"media.pictureInPicture"
]

const PREVIEW_VIDEO_ACTIONS_FULLSCREEN: readonly MediaAction[] = [...PREVIEW_VIDEO_ACTIONS, "media.fullscreen"]

function togglePictureInPicture(video: HTMLVideoElement): void {
	if (document.pictureInPictureElement === video) {
		void document.exitPictureInPicture().catch(() => undefined)
	} else if (document.pictureInPictureEnabled) {
		void video.requestPictureInPicture().catch(() => undefined)
	}
}

// A preview player's keydown handler, under `combos` (useBindings). Returns whether the key was the player's. A handled
// key stops here: past the player, the preview overlay would page on the same arrow and a single-letter app shortcut
// would fire. `fullscreenTarget` is the container F fullscreens; null until it has mounted.
export function handlePlayerKeyDown(
	event: KeyboardEvent,
	video: HTMLVideoElement | null,
	fullscreenTarget: HTMLElement | null,
	combos: Readonly<Record<string, string>>
): boolean {
	if (video === null || event.defaultPrevented || isRecordingCombo()) {
		return false
	}

	const actions = fullscreenTarget !== null && fullscreenSupported() ? PREVIEW_VIDEO_ACTIONS_FULLSCREEN : PREVIEW_VIDEO_ACTIONS
	const action = mediaKeyAction(event, playerKeyTarget(event.target), actions, combos, IS_MAC)

	if (action === null) {
		return false
	}

	event.preventDefault()
	event.stopPropagation()

	if (event.repeat && !mediaKeyRepeats(action)) {
		return true
	}

	runPreviewAction(action, video, fullscreenTarget)

	return true
}

function runPreviewAction(action: MediaAction, video: HTMLVideoElement, fullscreenTarget: HTMLElement | null): void {
	const fraction = jumpFraction(action)

	if (fraction !== null) {
		seekMedia(video, mediaDuration(video) * fraction)

		return
	}

	switch (action) {
		case "media.playPause":
			toggleMediaPlayback(video)
			break
		case "media.seekBack":
			seekMedia(video, video.currentTime - MEDIA_SEEK_STEP_SECONDS)
			break
		case "media.seekForward":
			seekMedia(video, video.currentTime + MEDIA_SEEK_STEP_SECONDS)
			break
		case "media.seekBackLong":
			seekMedia(video, video.currentTime - MEDIA_LONG_SEEK_STEP_SECONDS)
			break
		case "media.seekForwardLong":
			seekMedia(video, video.currentTime + MEDIA_LONG_SEEK_STEP_SECONDS)
			break
		case "media.toStart":
			seekMedia(video, 0)
			break
		case "media.toEnd":
			seekMedia(video, mediaDuration(video))
			break
		case "media.volumeUp":
			stepMediaVolume(MEDIA_VOLUME_STEP)
			break
		case "media.volumeDown":
			stepMediaVolume(-MEDIA_VOLUME_STEP)
			break
		case "media.mute":
			toggleMediaMuted()
			break
		case "media.slower":
			setPlaybackRate(video, stepPlaybackRate(video.playbackRate, -1))
			break
		case "media.faster":
			setPlaybackRate(video, stepPlaybackRate(video.playbackRate, 1))
			break
		case "media.normalSpeed":
			setPlaybackRate(video, 1)
			break
		case "media.frameBack":
		case "media.frameForward":
			if (!video.paused) {
				pauseMedia(video)
			}

			seekMedia(video, video.currentTime + (action === "media.frameBack" ? -1 : 1) * frameDuration(null))
			break
		case "media.pictureInPicture":
			togglePictureInPicture(video)
			break
		case "media.fullscreen":
			if (fullscreenTarget !== null) {
				void toggleFullscreen(fullscreenTarget).catch(() => undefined)
			}

			break
		default:
			break
	}
}
