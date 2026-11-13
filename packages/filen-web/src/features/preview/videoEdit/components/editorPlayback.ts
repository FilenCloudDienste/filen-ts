import { pauseMedia } from "@filen/shared/heldPause"
import { playMedia } from "@/lib/media/useMediaState"
import type { TimeRange } from "@/features/preview/videoEdit/types"
import { playableTime, previewVolume } from "@/features/preview/videoEdit/lib/recipe"

// A paused playhead moved here reaches the element this long after it last moved (once a scrub or a run of steps
// rests), or at once on play: the paused picture is the client's exact frame, and the element decoding every step too
// would be a second decoder (iOS runs one at a time).
const ELEMENT_SEEK_DELAY_MS = 400

// The editor's playback over the preview's own <video>: plays only what is kept (jumping over removed sections and
// looping a selection), at the recipe's speed with the pitch kept, and tells the playhead where it is once per
// displayed frame through listeners, so nothing in React renders per frame. While paused the playhead lives here and
// the element follows it lazily (see ELEMENT_SEEK_DELAY_MS); settle listeners hear where it came to rest.
export class EditorPlayback {
	private video: HTMLVideoElement | null = null
	private keep: readonly TimeRange[] = []
	private loop: TimeRange | null = null
	private speed = 1
	private mute = false
	private gainDb = 0
	// The L key's multiplier on top of the recipe's speed.
	private shuttle = 1
	private frame = 0
	// The paused playhead, while the element has not been moved there yet.
	private pausedAt: number | null = null
	private seekTimer: ReturnType<typeof setTimeout> | null = null
	private readonly listeners = new Set<(time: number) => void>()
	private readonly settleListeners = new Set<(time: number) => void>()
	private readonly detachers: (() => void)[] = []

	attach(video: HTMLVideoElement | null): void {
		this.detach()
		this.video = video

		if (video === null) {
			return
		}

		const tick = (): void => {
			this.emit()
		}
		// The element moved by itself (a restored position) or reached what was asked of it.
		const seeked = (): void => {
			this.emit()

			if (video.paused && this.pausedAt === null) {
				this.emitSettle()
			}
		}
		const loaded = (): void => {
			if (video.paused && this.pausedAt === null) {
				this.emitSettle()
			}
		}
		const play = (): void => {
			this.startLoop()
		}
		const stop = (): void => {
			this.stopLoop()
			this.emit()
			this.emitSettle()
		}

		video.addEventListener("seeked", seeked)
		video.addEventListener("loadedmetadata", tick)
		video.addEventListener("loadeddata", loaded)
		video.addEventListener("play", play)
		video.addEventListener("pause", stop)
		video.addEventListener("ended", stop)
		this.detachers.push(() => {
			video.removeEventListener("seeked", seeked)
			video.removeEventListener("loadedmetadata", tick)
			video.removeEventListener("loadeddata", loaded)
			video.removeEventListener("play", play)
			video.removeEventListener("pause", stop)
			video.removeEventListener("ended", stop)
		})
		this.applyRate()
		this.applySound()

		if (!video.paused) {
			this.startLoop()
		}
	}

	detach(): void {
		this.stopLoop()
		this.flushSeek()

		for (const detach of this.detachers.splice(0)) {
			detach()
		}

		this.video = null
	}

	setKeep(keep: readonly TimeRange[]): void {
		this.keep = keep
	}

	setLoop(loop: TimeRange | null): void {
		this.loop = loop
	}

	setSpeed(speed: number): void {
		this.speed = speed
		this.applyRate()
	}

	// The sound as it will be saved, as near as an element plays it (it cannot play louder than the file).
	setSound(mute: boolean, gainDb: number): void {
		this.mute = mute
		this.gainDb = gainDb
		this.applySound()
	}

	get time(): number {
		return this.pausedAt ?? this.video?.currentTime ?? 0
	}

	get paused(): boolean {
		return this.video?.paused ?? true
	}

	// Listens to the playhead: every displayed frame while playing, and after each seek. Returns the unsubscribe.
	subscribe(listener: (time: number) => void): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	// Listens to where the playhead comes to rest: a pause, a seek while paused (unless asked not to), the element's
	// first frame. Returns the unsubscribe.
	onSettle(listener: (time: number) => void): () => void {
		this.settleListeners.add(listener)

		return () => {
			this.settleListeners.delete(listener)
		}
	}

	// Tells the settle listeners where the playhead is now (a scrub that seeked without settling ended).
	settle(): void {
		this.emitSettle()
	}

	// `settle` false: a drag in progress, whose frames the caller draws itself; settle() once it ends.
	seek(time: number, settle = true): void {
		const video = this.video

		if (video === null) {
			return
		}

		const duration = Number.isFinite(video.duration) ? video.duration : time
		const target = Math.max(0, Math.min(duration, time))

		if (!video.paused) {
			video.currentTime = target
			this.emit()

			return
		}

		this.pausedAt = target
		this.emit()

		if (settle) {
			this.emitSettle()
		}

		if (this.seekTimer !== null) {
			clearTimeout(this.seekTimer)
		}

		this.seekTimer = setTimeout(() => {
			this.seekTimer = null
			this.flushSeek()
		}, ELEMENT_SEEK_DELAY_MS)
	}

	play(): void {
		const video = this.video

		if (video === null) {
			return
		}

		this.flushSeek()

		const at = playableTime(this.keep, video.currentTime, this.loop)

		if (at.jumped) {
			video.currentTime = at.time
		}

		playMedia(video)
	}

	pause(): void {
		if (this.video !== null) {
			this.shuttle = 1
			this.applyRate()
			pauseMedia(this.video)
		}
	}

	toggle(): void {
		if (this.paused) {
			this.play()
		} else {
			this.pause()
		}
	}

	// L: plays, and each further press while playing doubles the pace (up to 4× the recipe's speed).
	shuttleForward(): void {
		if (this.paused) {
			this.shuttle = 1
			this.applyRate()
			this.play()

			return
		}

		this.shuttle = Math.min(4, this.shuttle * 2)
		this.applyRate()
	}

	// Moves the element to the paused playhead now.
	private flushSeek(): void {
		if (this.seekTimer !== null) {
			clearTimeout(this.seekTimer)
			this.seekTimer = null
		}

		const at = this.pausedAt

		this.pausedAt = null

		if (at !== null && this.video !== null && this.video.currentTime !== at) {
			this.video.currentTime = at
		}
	}

	private applyRate(): void {
		const video = this.video

		if (video === null) {
			return
		}

		video.preservesPitch = true
		video.playbackRate = Math.min(16, this.speed * this.shuttle)
	}

	private applySound(): void {
		if (this.video !== null) {
			this.video.muted = this.mute
			this.video.volume = previewVolume(this.gainDb)
		}
	}

	private emit(): void {
		const time = this.time

		for (const listener of this.listeners) {
			listener(time)
		}
	}

	private emitSettle(): void {
		const time = this.time

		for (const listener of this.settleListeners) {
			listener(time)
		}
	}

	private startLoop(): void {
		if (this.frame !== 0) {
			return
		}

		const step = (): void => {
			const video = this.video

			if (video === null || video.paused) {
				this.frame = 0

				return
			}

			const at = playableTime(this.keep, video.currentTime, this.loop)

			if (at.jumped) {
				video.currentTime = at.time
			}

			this.emit()
			this.frame = requestAnimationFrame(step)
		}

		this.frame = requestAnimationFrame(step)
	}

	private stopLoop(): void {
		if (this.frame !== 0) {
			cancelAnimationFrame(this.frame)
			this.frame = 0
		}
	}
}
