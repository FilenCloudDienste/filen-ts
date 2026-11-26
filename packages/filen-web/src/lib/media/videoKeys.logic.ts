import { MEDIA_JUMP_ACTIONS, type MediaAction } from "@/lib/media/keymap"
import { jumpFraction, MEDIA_LONG_SEEK_STEP_SECONDS, MEDIA_SEEK_STEP_SECONDS, MEDIA_VOLUME_STEP } from "@/lib/media/mediaKeys.logic"

// The Videos player's keyboard: every media key (lib/media/keymap.ts) as the stage acts on it, plus Enter for the
// shown card's primary action and the app's shortcuts key for the shortcuts list.

export const SUBTITLE_DELAY_STEP_SECONDS = 0.1
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const

export type VideoKeyAction =
	| { type: "togglePlay" }
	| { type: "seekBy"; seconds: number }
	| { type: "seekToFraction"; fraction: number }
	| { type: "seekToStart" }
	| { type: "seekToEnd" }
	| { type: "chapter"; direction: 1 | -1 }
	| { type: "frameStep"; direction: 1 | -1 }
	| { type: "volumeBy"; delta: number }
	| { type: "toggleMute" }
	| { type: "toggleFullscreen" }
	| { type: "toggleSubtitles" }
	// The next subtitle track, after the last one off.
	| { type: "cycleSubtitles" }
	| { type: "cycleAudio" }
	| { type: "episodes" }
	| { type: "skip" }
	| { type: "next" }
	| { type: "previous" }
	| { type: "rate"; direction: 1 | -1 }
	| { type: "normalRate" }
	| { type: "subtitleDelay"; seconds: number }
	| { type: "resetSubtitleDelay" }
	| { type: "togglePictureInPicture" }
	| { type: "toggleRepeat" }
	| { type: "shortcuts" }
	// What is open over the picture first (a panel, Up Next), then the player itself.
	| { type: "dismiss" }
	// Enter: the shown card's primary action (Play now, Skip), else play/pause.
	| { type: "confirm" }

// Every media key the stage takes, in match order.
export const STAGE_MEDIA_ACTIONS: readonly MediaAction[] = [
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
	"media.fullscreen",
	"media.pictureInPicture",
	"media.repeat",
	"media.previous",
	"media.next",
	"media.chapterPrevious",
	"media.chapterNext",
	"media.skip",
	"media.subtitles",
	"media.subtitleTrack",
	"media.subtitleEarlier",
	"media.subtitleLater",
	"media.subtitleDelayReset",
	"media.audioTrack",
	"media.episodes",
	"media.close"
]

const STAGE_ACTIONS: Partial<Record<MediaAction, VideoKeyAction>> = {
	"media.playPause": { type: "togglePlay" },
	"media.seekBack": { type: "seekBy", seconds: -MEDIA_SEEK_STEP_SECONDS },
	"media.seekForward": { type: "seekBy", seconds: MEDIA_SEEK_STEP_SECONDS },
	"media.seekBackLong": { type: "seekBy", seconds: -MEDIA_LONG_SEEK_STEP_SECONDS },
	"media.seekForwardLong": { type: "seekBy", seconds: MEDIA_LONG_SEEK_STEP_SECONDS },
	"media.toStart": { type: "seekToStart" },
	"media.toEnd": { type: "seekToEnd" },
	"media.volumeUp": { type: "volumeBy", delta: MEDIA_VOLUME_STEP },
	"media.volumeDown": { type: "volumeBy", delta: -MEDIA_VOLUME_STEP },
	"media.mute": { type: "toggleMute" },
	"media.slower": { type: "rate", direction: -1 },
	"media.faster": { type: "rate", direction: 1 },
	"media.normalSpeed": { type: "normalRate" },
	"media.frameBack": { type: "frameStep", direction: -1 },
	"media.frameForward": { type: "frameStep", direction: 1 },
	"media.fullscreen": { type: "toggleFullscreen" },
	"media.pictureInPicture": { type: "togglePictureInPicture" },
	"media.repeat": { type: "toggleRepeat" },
	"media.previous": { type: "previous" },
	"media.next": { type: "next" },
	"media.chapterPrevious": { type: "chapter", direction: -1 },
	"media.chapterNext": { type: "chapter", direction: 1 },
	"media.skip": { type: "skip" },
	"media.subtitles": { type: "toggleSubtitles" },
	"media.subtitleTrack": { type: "cycleSubtitles" },
	"media.subtitleEarlier": { type: "subtitleDelay", seconds: -SUBTITLE_DELAY_STEP_SECONDS },
	"media.subtitleLater": { type: "subtitleDelay", seconds: SUBTITLE_DELAY_STEP_SECONDS },
	"media.subtitleDelayReset": { type: "resetSubtitleDelay" },
	"media.audioTrack": { type: "cycleAudio" },
	"media.episodes": { type: "episodes" },
	"media.close": { type: "dismiss" }
}

// What a media key does in the stage; null for one it does not take.
export function videoKeyAction(action: MediaAction): VideoKeyAction | null {
	const fraction = jumpFraction(action)

	return fraction === null ? (STAGE_ACTIONS[action] ?? null) : { type: "seekToFraction", fraction }
}

// The next playback rate up or down the list, from wherever the current one sits.
export function stepPlaybackRate(current: number, direction: 1 | -1): number {
	if (direction > 0) {
		return PLAYBACK_RATES.find(rate => rate > current + 1e-6) ?? PLAYBACK_RATES[PLAYBACK_RATES.length - 1] ?? current
	}

	let lower: number = PLAYBACK_RATES[0]

	for (const rate of PLAYBACK_RATES) {
		if (rate < current - 1e-6) {
			lower = rate
		}
	}

	return lower
}

// Chapter starts to step through with PageUp/PageDown. Going back from within the first seconds of a chapter
// lands on the one before it, like a track list.
export const CHAPTER_BACK_GRACE_SECONDS = 3

export function chapterTarget(starts: readonly number[], time: number, direction: 1 | -1): number | null {
	if (starts.length === 0) {
		return null
	}

	if (direction > 0) {
		return starts.find(start => start > time + 0.5) ?? null
	}

	let target: number | null = null

	for (const start of starts) {
		if (start <= time - CHAPTER_BACK_GRACE_SECONDS) {
			target = start
		}
	}

	return target ?? 0
}

// Seconds per frame: the measured frame interval when there is one, else a common 24 fps.
export function frameDuration(interval: number | null): number {
	return interval !== null && interval > 0 && Number.isFinite(interval) ? interval : 1 / 24
}

// A presented frame as requestVideoFrameCallback reports it.
export interface PresentedFrame {
	mediaTime: number
	presentedFrames: number
}

// Frame intervals one run of playback measures. The shortest wins, so a frame the display skipped doesn't double it.
export const FRAME_INTERVAL_SAMPLES = 4

// Frames one run looks at before it gives up (a display that keeps skipping frames).
export const FRAME_INTERVAL_MAX_FRAMES = 16

// Longest interval taken as a frame's (2 fps); a longer gap is a stall or a seek.
const MAX_FRAME_INTERVAL_SECONDS = 0.5

// The frame interval of what plays, from the media times of frames presented one after another at normal speed. Each
// run of playback (`restart`) measures afresh and replaces the last run's interval once it has a sample, so a variable
// frame rate is followed run by run.
export class FrameIntervalMeter {
	public interval: number | null = null
	private previous: PresentedFrame | null = null
	private samples = 0
	private frames = 0

	// Takes a presented frame; returns whether the run wants another. Off normal speed a frame's media time covers
	// several frames: the run ends.
	public add(frame: PresentedFrame, playbackRate: number): boolean {
		if (playbackRate !== 1) {
			return false
		}

		const previous = this.previous

		this.previous = frame
		this.frames++

		if (previous !== null && frame.presentedFrames === previous.presentedFrames + 1) {
			const delta = frame.mediaTime - previous.mediaTime

			if (delta > 0 && delta <= MAX_FRAME_INTERVAL_SECONDS) {
				this.interval = this.samples === 0 || this.interval === null ? delta : Math.min(this.interval, delta)
				this.samples++
			}
		}

		return this.samples < FRAME_INTERVAL_SAMPLES && this.frames < FRAME_INTERVAL_MAX_FRAMES
	}

	// A new run of playback: its first frame starts over, the last run's interval stays until it has a sample.
	public restart(): void {
		this.previous = null
		this.samples = 0
		this.frames = 0
	}

	// A new source: nothing is known.
	public reset(): void {
		this.restart()
		this.interval = null
	}
}
