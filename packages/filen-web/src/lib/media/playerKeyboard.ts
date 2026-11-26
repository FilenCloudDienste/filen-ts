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
	mediaKeyRepeats,
	type MediaKeyEvent
} from "@/lib/media/mediaKeys.logic"
import { playerKeyTarget } from "@/lib/media/playerKeys.logic"
import type { SeekCoalescer } from "@/lib/media/seekCoalescer.logic"
import { stepMediaVolume, toggleMediaMuted } from "@/lib/media/mediaVolume"
import { toggleVideoRepeat } from "@/lib/media/videoRepeat"
import { chapterTarget, frameDuration, FrameIntervalMeter, stepPlaybackRate } from "@/lib/media/videoKeys.logic"
import { mediaDuration, seekMedia, setPlaybackRate, toggleMediaPlayback } from "@/lib/media/useMediaState"

const IS_MAC = isMacPlatform()

// What the keys use of a seek coalescer, whatever its timer.
type PlayerSeeks = Pick<SeekCoalescer, "target" | "seekBy" | "cancel">

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
	"media.pictureInPicture",
	"media.repeat"
]

const PREVIEW_VIDEO_ACTIONS_FULLSCREEN: readonly MediaAction[] = [...PREVIEW_VIDEO_ACTIONS, "media.fullscreen"]
const CHAPTER_ACTIONS: readonly MediaAction[] = ["media.chapterPrevious", "media.chapterNext"]
const PREVIEW_VIDEO_ACTIONS_CHAPTERS: readonly MediaAction[] = [...PREVIEW_VIDEO_ACTIONS, ...CHAPTER_ACTIONS]
const PREVIEW_VIDEO_ACTIONS_FULLSCREEN_CHAPTERS: readonly MediaAction[] = [...PREVIEW_VIDEO_ACTIONS_FULLSCREEN, ...CHAPTER_ACTIONS]

// PageUp/PageDown are the player's only with two chapters or more; otherwise they page whatever is around it.
export function previewVideoActions(fullscreen: boolean, chapterCount: number): readonly MediaAction[] {
	if (chapterCount >= 2) {
		return fullscreen ? PREVIEW_VIDEO_ACTIONS_FULLSCREEN_CHAPTERS : PREVIEW_VIDEO_ACTIONS_CHAPTERS
	}

	return fullscreen ? PREVIEW_VIDEO_ACTIONS_FULLSCREEN : PREVIEW_VIDEO_ACTIONS
}

function togglePictureInPicture(video: HTMLVideoElement): void {
	if (document.pictureInPictureElement === video) {
		void document.exitPictureInPicture().catch(() => undefined)
	} else if (document.pictureInPictureEnabled) {
		void video.requestPictureInPicture().catch(() => undefined)
	}
}

const frameMeters = new WeakMap<HTMLVideoElement, FrameIntervalMeter>()

// Measures the frame interval of what `video` plays, for frame steps: a few presented frames each time playback starts
// (requestVideoFrameCallback), none while paused. A new source starts over. Once per element; the returned function
// stops it.
export function measureFrameInterval(video: HTMLVideoElement): () => void {
	if (frameMeters.has(video) || !("requestVideoFrameCallback" in video)) {
		return () => undefined
	}

	const meter = new FrameIntervalMeter()
	let request: number | null = null

	function cancel(): void {
		if (request !== null) {
			video.cancelVideoFrameCallback(request)
			request = null
		}
	}

	function onFrame(_now: number, metadata: VideoFrameCallbackMetadata): void {
		request = null

		if (meter.add(metadata, video.playbackRate) && !video.paused) {
			request = video.requestVideoFrameCallback(onFrame)
		}
	}

	// Idempotent: "seeked" and "playing" can both follow one seek, and a second call must not drop the run's frames.
	function start(): void {
		if (request !== null || video.playbackRate !== 1) {
			return
		}

		meter.restart()
		request = video.requestVideoFrameCallback(onFrame)
	}

	// A seek inside the buffer may fire no "playing": the run resumes once it lands, if playback goes on.
	function seeked(): void {
		if (!video.paused) {
			start()
		}
	}

	// A seek's frame is not the next one: a run ends with a pause or a seek, and "playing" or "seeked" starts the next.
	function stop(): void {
		cancel()
		meter.restart()
	}

	function reset(): void {
		cancel()
		meter.reset()
	}

	// Back at normal speed mid-playback starts a run; off it ends one.
	function rateChanged(): void {
		if (video.paused || video.playbackRate !== 1) {
			stop()
		} else {
			start()
		}
	}

	const listeners: [string, () => void][] = [
		["playing", start],
		["pause", stop],
		["seeking", stop],
		["seeked", seeked],
		["waiting", stop],
		["ratechange", rateChanged],
		["emptied", reset]
	]

	frameMeters.set(video, meter)

	for (const [type, listener] of listeners) {
		video.addEventListener(type, listener)
	}

	if (!video.paused && !video.seeking) {
		start()
	}

	return () => {
		cancel()
		frameMeters.delete(video)

		for (const [type, listener] of listeners) {
			video.removeEventListener(type, listener)
		}
	}
}

// Seconds one frame step moves on `video`: its measured frame interval, else 24 fps.
export function frameStepSeconds(video: HTMLVideoElement): number {
	return frameDuration(frameMeters.get(video)?.interval ?? null)
}

// A preview player's keydown handler, under `combos` (useBindings). Returns whether the key was the player's. A handled
// key stops here: past the player, the preview overlay would page on the same arrow and a single-letter app shortcut
// would fire. `fullscreenTarget` is the container F fullscreens; null until it has mounted. `chapterStarts` are the
// video's chapter starts in order, in seconds. `seeks` coalesces the relative seeks of a held key on `video`; an
// absolute seek drops what it still holds.
export function handlePlayerKeyDown(
	event: Pick<KeyboardEvent, "defaultPrevented" | "target" | "repeat" | "preventDefault" | "stopPropagation"> & MediaKeyEvent,
	video: HTMLVideoElement | null,
	fullscreenTarget: HTMLElement | null,
	combos: Readonly<Record<string, string>>,
	chapterStarts: readonly number[],
	seeks: PlayerSeeks
): boolean {
	if (video === null || event.defaultPrevented || isRecordingCombo()) {
		return false
	}

	const actions = previewVideoActions(fullscreenTarget !== null && fullscreenSupported(), chapterStarts.length)
	const action = mediaKeyAction(event, playerKeyTarget(event.target), actions, combos, IS_MAC)

	if (action === null) {
		return false
	}

	event.preventDefault()
	event.stopPropagation()

	if (event.repeat && !mediaKeyRepeats(action)) {
		return true
	}

	runPreviewAction(action, video, fullscreenTarget, chapterStarts, seeks)

	return true
}

// An absolute seek on a player whose relative seeks `seeks` coalesces (keys, its scrubber): a pending relative seek is
// superseded, not applied first, nor left to land after it.
export function seekPlayerTo(video: HTMLMediaElement, seeks: Pick<SeekCoalescer, "cancel">, seconds: number): void {
	seeks.cancel()
	seekMedia(video, seconds)
}

function runPreviewAction(
	action: MediaAction,
	video: HTMLVideoElement,
	fullscreenTarget: HTMLElement | null,
	chapterStarts: readonly number[],
	seeks: PlayerSeeks
): void {
	const fraction = jumpFraction(action)

	function seekTo(seconds: number): void {
		seekPlayerTo(video, seeks, seconds)
	}

	if (fraction !== null) {
		seekTo(mediaDuration(video) * fraction)

		return
	}

	switch (action) {
		case "media.playPause":
			toggleMediaPlayback(video)
			break
		case "media.seekBack":
			seeks.seekBy(-MEDIA_SEEK_STEP_SECONDS)
			break
		case "media.seekForward":
			seeks.seekBy(MEDIA_SEEK_STEP_SECONDS)
			break
		case "media.seekBackLong":
			seeks.seekBy(-MEDIA_LONG_SEEK_STEP_SECONDS)
			break
		case "media.seekForwardLong":
			seeks.seekBy(MEDIA_LONG_SEEK_STEP_SECONDS)
			break
		case "media.toStart":
			seekTo(0)
			break
		case "media.toEnd":
			seekTo(mediaDuration(video))
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

			// From where a held seek is headed, not from the position it left.
			seekTo(seeks.target() + (action === "media.frameBack" ? -1 : 1) * frameStepSeconds(video))
			break
		case "media.pictureInPicture":
			togglePictureInPicture(video)
			break
		case "media.repeat":
			toggleVideoRepeat("preview")
			break
		case "media.chapterPrevious":
		case "media.chapterNext": {
			const target = chapterTarget(chapterStarts, seeks.target(), action === "media.chapterPrevious" ? -1 : 1)

			if (target !== null) {
				seekTo(target)
			}

			break
		}
		case "media.fullscreen":
			if (fullscreenTarget !== null) {
				void toggleFullscreen(fullscreenTarget).catch(() => undefined)
			}

			break
		default:
			break
	}
}
