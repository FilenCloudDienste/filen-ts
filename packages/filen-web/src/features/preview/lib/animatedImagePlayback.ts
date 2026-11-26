import { frameDelayMs, nextFramePosition, stepFrameIndex, type FramePosition } from "@/features/preview/lib/animatedImage.logic"
import { createListenerSet } from "@/lib/listenerSet"
import { log } from "@/lib/log"

// The animated image player's clock: decodes frames one at a time as they come due (and at most the next one ahead),
// draws each to the canvas and closes it at once, so no decoded frame outlives its turn on screen. Seeking backwards
// is ImageDecoder's to resolve (it decodes from the nearest keyframe). The decoder belongs to whoever opened it.

// What the clock uses of an ImageDecoder.
export interface PlaybackDecoder {
	readonly complete: boolean
	readonly completed: Promise<void>
	readonly tracks: { readonly selectedTrack: { readonly frameCount: number; readonly repetitionCount: number } | null }
	decode(options: { frameIndex: number }): Promise<{ image: VideoFrame }>
}

export interface PlaybackSnapshot {
	readonly index: number
	// The frames known so far: it grows while the file still downloads.
	readonly frameCount: number
	readonly complete: boolean
	readonly playing: boolean
	readonly rate: number
}

// Why the clock stands still while playing: the tab is hidden, the picture is off screen, a scrub is under way.
export type PlaybackHold = "hidden" | "offscreen" | "scrubbing"

export class AnimatedImagePlayback {
	public readonly width: number
	public readonly height: number
	private readonly decoder: PlaybackDecoder
	private readonly listeners = new Set<() => void>()
	private readonly loopEnds = createListenerSet("preview")
	private readonly holds = new Set<PlaybackHold>()
	private snapshot: PlaybackSnapshot
	private context: CanvasRenderingContext2D | null = null
	// Frame 0 until a canvas takes it; its opener closes it too.
	private undrawn: VideoFrame | null
	private position: FramePosition = { index: 0, plays: 0 }
	private shownDuration: number | null
	private presentedAt = 0
	private timer: ReturnType<typeof setTimeout> | null = null
	// Bumped by every seek, pause and stop: a decode it overtook is closed, never drawn.
	private generation = 0
	private prefetch: { readonly position: FramePosition; readonly frame: Promise<VideoFrame> } | null = null
	private seekInFlight = false
	private pendingSeek: number | null = null
	private ended = false
	private running = false

	public constructor(decoder: PlaybackDecoder, first: VideoFrame, autoplay: boolean) {
		this.decoder = decoder
		this.undrawn = first
		this.width = first.displayWidth
		this.height = first.displayHeight
		this.shownDuration = first.duration
		this.snapshot = { index: 0, frameCount: this.frameCount(), complete: decoder.complete, playing: autoplay, rate: 1 }

		// The final count arrives with the last byte.
		decoder.completed.then(
			() => {
				this.notify()
			},
			() => undefined
		)
	}

	public readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	public readonly getSnapshot = (): PlaybackSnapshot => this.snapshot

	// Calls `listener` each time a loop's last frame has shown its duration (the file's last loop included), and when a
	// frame cannot be decoded, which ends the loop where it stands; returns the unsubscribe.
	public onLoopEnded(listener: () => void): () => void {
		return this.loopEnds.subscribe(listener)
	}

	// The canvas frames are drawn to; null when it goes.
	public attach(context: CanvasRenderingContext2D | null): void {
		this.context = context

		const first = this.undrawn

		if (context !== null && first !== null) {
			this.undrawn = null
			this.draw(first)
		}
	}

	// Mounted: the clock runs (if playing). Undone by stop(), and again after it.
	public start(): void {
		this.running = true
		this.presentedAt = performance.now()

		// A seek that landed while stopped was not drawn.
		if (this.snapshot.index !== this.position.index && !this.seekInFlight) {
			this.seek(this.snapshot.index)

			return
		}

		this.resume()
	}

	public stop(): void {
		this.running = false
		this.halt()
	}

	public setHold(hold: PlaybackHold, on: boolean): void {
		const had = this.holds.has(hold)

		if (on === had) {
			return
		}

		if (on) {
			this.holds.add(hold)
			this.clearTimer()
		} else {
			this.holds.delete(hold)
			this.presentedAt = performance.now()
			this.resume()
		}
	}

	public play(): void {
		if (this.snapshot.playing) {
			return
		}

		this.update({ playing: true })

		if (this.ended) {
			this.ended = false
			this.position = { index: this.position.index, plays: 0 }
			this.seek(0)

			return
		}

		this.presentedAt = performance.now()
		this.resume()
	}

	public pause(): void {
		if (!this.snapshot.playing) {
			return
		}

		this.halt()
		this.update({ playing: false })
	}

	public toggle(): void {
		if (this.snapshot.playing) {
			this.pause()
		} else {
			this.play()
		}
	}

	public setRate(rate: number): void {
		this.update({ rate })

		if (this.timer !== null) {
			this.clearTimer()
			this.schedule()
		}
	}

	// One frame either way, from where a seek is headed; a step pauses.
	public step(direction: 1 | -1): void {
		this.pause()

		const from = this.pendingSeek ?? this.snapshot.index

		this.seek(stepFrameIndex(from, direction, this.frameCount(), this.decoder.complete))
	}

	// Shows frame `index`; playback, if on, goes on from there. Seeks while one decodes collapse into the last.
	public seek(index: number): void {
		this.ended = false
		this.generation++
		this.clearTimer()
		this.dropPrefetch()

		if (this.seekInFlight) {
			this.pendingSeek = index
			this.update({ index })

			return
		}

		this.seekInFlight = true
		this.update({ index })

		const plays = this.position.plays

		// A pause does not drop it: the frame asked for is drawn whatever the clock does meanwhile.
		this.decodeAt(index).then(
			frame => {
				this.seekInFlight = false

				const next = this.pendingSeek

				this.pendingSeek = null

				if (!this.running) {
					frame.close()

					return
				}

				this.present({ index, plays }, frame)

				if (next !== null && next !== index) {
					this.seek(next)

					return
				}

				this.resume()
			},
			(error: unknown) => {
				this.seekInFlight = false

				const next = this.pendingSeek

				this.pendingSeek = null

				if (next !== null && this.running) {
					this.seek(next)

					return
				}

				this.failed(error)
			}
		)
	}

	private frameCount(): number {
		return this.decoder.tracks.selectedTrack?.frameCount ?? 0
	}

	private repetitionCount(): number {
		return this.decoder.tracks.selectedTrack?.repetitionCount ?? 0
	}

	private notify(): void {
		this.update({})
	}

	private update(change: Partial<PlaybackSnapshot>): void {
		const next: PlaybackSnapshot = { ...this.snapshot, ...change, frameCount: this.frameCount(), complete: this.decoder.complete }
		const current = this.snapshot

		if (
			next.index === current.index &&
			next.frameCount === current.frameCount &&
			next.complete === current.complete &&
			next.playing === current.playing &&
			next.rate === current.rate
		) {
			return
		}

		this.snapshot = next

		for (const listener of this.listeners) {
			listener()
		}
	}

	private async decodeAt(index: number): Promise<VideoFrame> {
		const { image } = await this.decoder.decode({ frameIndex: index })

		return image
	}

	private draw(frame: VideoFrame): void {
		const context = this.context

		if (context !== null) {
			// Frames come composited; a transparent one must not blend over the last.
			context.clearRect(0, 0, this.width, this.height)
			context.drawImage(frame, 0, 0, this.width, this.height)
		}

		frame.close()
	}

	private present(position: FramePosition, frame: VideoFrame): void {
		this.position = position
		this.shownDuration = frame.duration
		this.presentedAt = performance.now()

		if (this.context === null) {
			this.undrawn?.close()
			this.undrawn = frame
		} else {
			this.draw(frame)
		}

		this.update({ index: position.index })
	}

	private canRun(): boolean {
		return this.running && this.snapshot.playing && this.holds.size === 0 && !this.seekInFlight
	}

	private resume(): void {
		if (!this.canRun()) {
			return
		}

		this.schedule()
		this.startPrefetch()
	}

	private halt(): void {
		this.generation++
		this.clearTimer()
		this.dropPrefetch()
	}

	private schedule(): void {
		if (this.timer !== null || !this.canRun()) {
			return
		}

		const delay = frameDelayMs(this.shownDuration, this.snapshot.rate)
		const wait = Math.max(0, this.presentedAt + delay - performance.now())

		this.timer = setTimeout(() => {
			this.timer = null
			this.tick()
		}, wait)
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer)
			this.timer = null
		}
	}

	private nextPosition(): FramePosition | null {
		return nextFramePosition(this.position, this.frameCount(), this.decoder.complete, this.repetitionCount())
	}

	private startPrefetch(): void {
		if (this.prefetch !== null) {
			return
		}

		const position = this.nextPosition()

		if (position === null) {
			return
		}

		const frame = this.decodeAt(position.index)

		// Settled here too, so a prefetch dropped before its turn is never an unhandled rejection.
		frame.catch(() => undefined)
		this.prefetch = { position, frame }
	}

	private dropPrefetch(): void {
		const dropped = this.prefetch

		this.prefetch = null

		void dropped?.frame.then(
			frame => {
				frame.close()
			},
			() => undefined
		)
	}

	private tick(): void {
		if (!this.canRun()) {
			return
		}

		const due = this.prefetch ?? this.claim()

		this.prefetch = null

		if (due === null) {
			this.ended = true
			this.update({ playing: false })
			this.loopEnds.emit()

			return
		}

		if (due.position.plays > this.position.plays) {
			this.loopEnds.emit()
		}

		const generation = this.generation

		due.frame.then(
			frame => {
				if (generation !== this.generation || !this.running) {
					frame.close()

					return
				}

				this.present(due.position, frame)
				this.resume()
			},
			(error: unknown) => {
				if (generation !== this.generation || !this.running) {
					return
				}

				// The file ended short of the frame asked for: the one shown was the last, and the loop rules decide.
				if (this.decoder.complete && due.position.index >= this.frameCount() && this.position.index < due.position.index) {
					this.notify()
					this.tick()

					return
				}

				this.failed(error)
			}
		)
	}

	private claim(): { readonly position: FramePosition; readonly frame: Promise<VideoFrame> } | null {
		const position = this.nextPosition()

		return position === null ? null : { position, frame: this.decodeAt(position.index) }
	}

	private failed(error: unknown): void {
		if (!this.running) {
			return
		}

		log.warn("preview", "decoding an animation frame failed", error)
		this.halt()
		this.update({ playing: false })
		this.loopEnds.emit()
	}
}
