import {
	directErrorAction,
	ERROR_PAUSE_GRACE_MS,
	KEEPALIVE_IDLE_PAUSE_MS,
	mayRecover,
	RECOVERY_TIMEOUT_MS,
	STREAM_STALL_MS,
	STREAM_STALL_POLL_MS,
	stallAction,
	expectsProgress
} from "@/lib/media/playback/directSession.logic"
import { audioTracksOf, enableAudioTrack } from "@/lib/media/playback/audioTrackList"
import type { PlaybackSession, SessionAudio, SessionCallbacks } from "@/lib/media/playback/types"
import type { PreviewStreamStatus } from "@/lib/sw/protocol"

// A natively playable file streamed by the service worker's range route straight into the element.

// The service worker's side of a direct stream.
export interface DirectSource {
	// Registers the file under `id` (again, after the worker lost it) and resolves its URL.
	register(id: string): Promise<string>
	// The element is done with `id`.
	release(id: string): void
	// Keeps the worker alive until the returned release is called.
	holdAlive(): () => void
	// Whether the worker still serves `id`, from its registry alone (no request through the stream): one it
	// serves makes an error the element reported the file's.
	status(id: string): Promise<PreviewStreamStatus>
	// A registration made ahead of playback (prewarm), taken over instead of a new one.
	presetId?: string
	// Calls `listener` when the worker answers a request for `id` with 404 (it lost the registration);
	// returns the unsubscribe. WebKit reports such a stream to the element by retrying it for ever.
	onGone?: (id: string, listener: () => void) => () => void
}

export function openDirectSession(params: {
	source: DirectSource
	startTime: number
	audioIndex: number
	callbacks: SessionCallbacks
	now?: () => number
	// Whether the page is hidden, where timers are throttled and a still playhead says nothing.
	hidden?: () => boolean
}): PlaybackSession {
	return new DirectSession(params)
}

class DirectSession implements PlaybackSession {
	public readonly path = "direct"
	private readonly source: DirectSource
	private readonly callbacks: SessionCallbacks
	private readonly now: () => number
	private readonly hidden: () => boolean
	private readonly listeners: [string, () => void][] = []
	private video: HTMLVideoElement | null = null
	private id: string | null = null
	private audioIndex: number
	// Where the element goes once it has metadata: the start position, or the position a recovery saved.
	private pendingSeek: number | null
	private resumeAfterLoad = false
	private hadMetadata = false
	private reconnecting = false
	private lastRecoveryAt: number | null = null
	// What the user last asked for, which a reload's own pause does not change.
	private wantsPlay = false
	// The pause a reload of a playing element fires on its own, not the user's.
	private reloadPause = false
	// The last pause and the intent before it: a pause that came with a broken stream is not the user's.
	private lastPause: { at: number; wantedPlay: boolean } | null = null
	// The stall watchdog: when the playhead last moved (or the element last had what it needs), and where.
	private stallTimer: ReturnType<typeof setInterval> | undefined
	private progressAt = 0
	private progressTime = -1
	private stallChecking = false
	private stopGone: (() => void) | null = null
	// A recovery under way has reloaded the element: an error from before that is the break it recovers from.
	private recoveryLoaded = false
	private releaseAlive: (() => void) | null = null
	private idleTimer: ReturnType<typeof setTimeout> | undefined
	private recoveryTimer: ReturnType<typeof setTimeout> | undefined
	private disposed = false

	public constructor(params: {
		source: DirectSource
		startTime: number
		audioIndex: number
		callbacks: SessionCallbacks
		now?: () => number
		hidden?: () => boolean
	}) {
		this.source = params.source
		this.callbacks = params.callbacks
		this.now = params.now ?? (() => performance.now())
		this.hidden = params.hidden ?? (() => typeof document !== "undefined" && document.hidden)
		this.audioIndex = params.audioIndex
		this.pendingSeek = params.startTime > 0 ? params.startTime : null
	}

	public async attach(video: HTMLVideoElement): Promise<void> {
		const id = this.source.presetId ?? crypto.randomUUID()
		let url: string

		try {
			url = await this.source.register(id)
		} catch (error) {
			if (!this.disposed) {
				this.callbacks.onFailure({ trigger: "stream-unavailable", detail: error instanceof Error ? error.message : String(error) })
			}

			return
		}

		if (this.disposed) {
			this.source.release(id)

			return
		}

		this.id = id
		this.video = video
		// A remote player could reach neither the service worker's URL nor its decryption.
		video.disableRemotePlayback = true
		this.listen("loadedmetadata", () => {
			this.onMetadata()
		})
		this.listen("canplay", () => {
			// After a recovery's reload and seek: playing again once it can, if that is what the user wants
			// (a pause during the reconnect included).
			if (this.resumeAfterLoad && this.pendingSeek === null) {
				this.resumeAfterLoad = false

				if (this.wantsPlay && video.paused) {
					void video.play().catch(() => undefined)
				}
			}

			if (this.reconnecting) {
				this.reconnecting = false
				clearTimeout(this.recoveryTimer)
				this.callbacks.onReconnecting(false)

				// Paused while it reconnected: the hold goes after the idle pause again.
				if (video.paused) {
					this.armIdleRelease()
				}
			}
		})
		this.listen("error", () => {
			this.onError()
		})
		this.listen("play", () => {
			this.wantsPlay = true
			this.holdAlive()
		})
		this.listen("pause", () => {
			if (this.reloadPause) {
				this.reloadPause = false

				return
			}

			// Chrome pauses an element as its stream breaks, the pause queued just after the error: the
			// browser's, not the user's.
			if (video.error !== null) {
				return
			}

			this.lastPause = { at: this.now(), wantedPlay: this.wantsPlay }
			this.wantsPlay = false
			this.armIdleRelease()
		})
		this.holdAlive()
		this.watchStalls(video)
		this.stopGone =
			this.source.onGone?.(id, () => {
				this.onGone(video)
			}) ?? null

		if (video.paused) {
			this.armIdleRelease()
		}

		video.src = url
	}

	public firstTime(): number {
		return 0
	}

	public selectAudio(audio: SessionAudio): Promise<boolean> {
		const tracks = audioTracksOf(this.video)

		if (audio.index === this.audioIndex) {
			return Promise.resolve(true)
		}

		if (tracks === undefined || audio.index >= tracks.length) {
			return Promise.resolve(false)
		}

		this.audioIndex = audio.index
		this.applyAudioTrack()

		return Promise.resolve(true)
	}

	public dispose(): void {
		if (this.disposed) {
			return
		}

		this.disposed = true
		clearTimeout(this.idleTimer)
		clearTimeout(this.recoveryTimer)
		clearInterval(this.stallTimer)
		this.stopGone?.()
		this.stopGone = null
		this.releaseAlive?.()
		this.releaseAlive = null

		const video = this.video

		for (const [type, listener] of this.listeners) {
			video?.removeEventListener(type, listener)
		}

		// Emptied before the registration goes, so no range request of this element can still reach it.
		if (video !== null) {
			video.removeAttribute("src")
			video.load()
		}

		if (this.id !== null) {
			this.source.release(this.id)
		}
	}

	private listen(type: string, listener: () => void): void {
		this.video?.addEventListener(type, listener)
		this.listeners.push([type, listener])
	}

	private holdAlive(): void {
		clearTimeout(this.idleTimer)
		this.idleTimer = undefined
		this.releaseAlive ??= this.source.holdAlive()
	}

	// A long pause lets the worker go; playing again re-holds it, and a stream it lost meanwhile recovers.
	private armIdleRelease(): void {
		clearTimeout(this.idleTimer)
		this.idleTimer = setTimeout(() => {
			this.releaseAlive?.()
			this.releaseAlive = null
		}, KEEPALIVE_IDLE_PAUSE_MS)
	}

	private onMetadata(): void {
		const video = this.video

		if (video === null) {
			return
		}

		this.hadMetadata = true
		this.applyAudioTrack()

		if (this.pendingSeek !== null) {
			video.currentTime = this.pendingSeek
			this.pendingSeek = null
		}
	}

	// Polls the playhead while the element waits on the stream; a stall that outlasts STREAM_STALL_MS asks the
	// worker whether it still serves the stream. A hidden page's throttled timers and still playhead say nothing, so its
	// stall clock starts over once it is visible again.
	private watchStalls(video: HTMLVideoElement): void {
		this.progressAt = this.now()
		this.stallTimer = setInterval(() => {
			const now = this.now()

			if (this.hidden() || !expectsProgress(video) || video.currentTime !== this.progressTime || this.reconnecting) {
				this.progressAt = now
				this.progressTime = video.currentTime

				return
			}

			if (now - this.progressAt >= STREAM_STALL_MS && !this.stallChecking) {
				void this.checkStall(video)
			}
		}, STREAM_STALL_POLL_MS)
	}

	// The worker said it no longer has the stream: the same verdict a lost stream gives a stall.
	private onGone(video: HTMLVideoElement): void {
		if (this.disposed || this.reconnecting) {
			return
		}

		this.act(video, stallAction({ status: "missing", now: this.now(), lastRecoveryAt: this.lastRecoveryAt }))
	}

	private act(video: HTMLVideoElement, action: ReturnType<typeof stallAction>): void {
		if (action === "recover") {
			void this.recover(video)
		} else if (action === "demote") {
			// The service worker's route is gone, not the browser's ability to play the file.
			this.callbacks.onFailure({ trigger: "stream-unavailable", detail: "the stream stalled", learnable: false })
		}
	}

	private async checkStall(video: HTMLVideoElement): Promise<void> {
		const id = this.id

		if (id === null) {
			return
		}

		const recoveryAt = this.lastRecoveryAt

		this.stallChecking = true

		const status = await this.askStatus(id)

		this.stallChecking = false
		this.progressAt = this.now()

		if (this.raced(recoveryAt)) {
			return
		}

		this.act(video, stallAction({ status, now: this.now(), lastRecoveryAt: this.lastRecoveryAt }))
	}

	private askStatus(id: string): Promise<PreviewStreamStatus> {
		return this.source.status(id).catch((): PreviewStreamStatus => "missing")
	}

	// An answer asked for before a recovery that has since started (or started and finished) speaks of the
	// stream that recovery replaced.
	private raced(recoveryAt: number | null): boolean {
		return this.disposed || this.reconnecting || this.lastRecoveryAt !== recoveryAt
	}

	private applyAudioTrack(): void {
		enableAudioTrack(this.video, this.audioIndex)
	}

	private onError(): void {
		const video = this.video
		const error = video?.error

		if (video === null || error === null || error === undefined || this.disposed) {
			return
		}

		// The old stream's own error, landing after the worker already reported it gone: being recovered.
		if (this.reconnecting && !this.recoveryLoaded) {
			return
		}

		const action = directErrorAction({
			code: error.code,
			hadMetadata: this.hadMetadata,
			recovering: this.reconnecting,
			now: this.now(),
			lastRecoveryAt: this.lastRecoveryAt
		})
		const detail = `MediaError ${String(error.code)}${error.message === "" ? "" : `: ${error.message}`}`

		if (action === "recover") {
			void this.recover(video)
		} else if (action === "verify") {
			void this.verify(video, detail)
		} else if (action === "demote") {
			this.callbacks.onFailure({ trigger: "media-error", detail })
		} else if (action === "fail") {
			clearTimeout(this.recoveryTimer)
			this.callbacks.onFailure({ trigger: "network", detail })
		}
	}

	// A source refused before any metadata: the file when the worker still serves the stream, the stream
	// otherwise. An answer that a recovery overtook is dropped: never a format verdict on a stream it replaced.
	private async verify(video: HTMLVideoElement, detail: string): Promise<void> {
		const id = this.id

		if (id === null) {
			return
		}

		const recoveryAt = this.lastRecoveryAt
		const status = await this.askStatus(id)

		if (this.raced(recoveryAt)) {
			return
		}

		// A worker that could not be asked says nothing against the stream: the file is what failed.
		if (status === "present" || status === "unknown") {
			this.callbacks.onFailure({ trigger: "media-error", detail })
		} else if (mayRecover(this.now(), this.lastRecoveryAt)) {
			void this.recover(video)
		} else {
			this.callbacks.onFailure({ trigger: "network", detail })
		}
	}

	// The worker lost the registration (terminated while idle) or the stream broke: register the same id
	// again, reload, and go back to the saved position and play state.
	private async recover(video: HTMLVideoElement): Promise<void> {
		const id = this.id

		if (id === null) {
			return
		}

		const startedAt = this.now()

		this.lastRecoveryAt = startedAt
		this.reconnecting = true
		this.recoveryLoaded = false
		this.callbacks.onReconnecting(true)
		// Not the bytes themselves: the service worker's route did not come back, which the next rung (reading
		// through the SDK worker) does not need.
		this.recoveryTimer = setTimeout(() => {
			if (this.reconnecting && !this.disposed) {
				this.callbacks.onFailure({ trigger: "stream-unavailable", detail: "the stream did not come back", learnable: false })
			}
		}, RECOVERY_TIMEOUT_MS)

		const time = video.currentTime
		const pause = this.lastPause

		// A pause that came with the break was the browser's: the intent before it stands.
		if (!this.wantsPlay && pause !== null && startedAt - pause.at <= ERROR_PAUSE_GRACE_MS) {
			this.wantsPlay = pause.wantedPlay
		}

		try {
			await this.source.register(id)
		} catch (error) {
			clearTimeout(this.recoveryTimer)

			if (!this.disposed) {
				this.callbacks.onFailure({ trigger: "network", detail: error instanceof Error ? error.message : String(error) })
			}

			return
		}

		if (this.disposed) {
			return
		}

		this.holdAlive()
		this.pendingSeek = time > 0 ? time : this.pendingSeek
		this.resumeAfterLoad = true
		this.reloadPause = !video.paused
		this.recoveryLoaded = true
		video.load()
	}
}
