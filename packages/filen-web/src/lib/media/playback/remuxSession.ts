import { isAbortError } from "@filen/shared"
import { openRemuxSession, type MseFailure, type RemuxSession, type RemuxSessionOptions } from "@/lib/media/mseController"
import { isIdrUnreachable, isSourceReadError, isWarmGone, SourceReadError, type RemuxTextCue } from "@/lib/media/remuxTypes"
import type { ProbeIndex } from "@filen/shared/videos"
import type {
	PlaybackFailure,
	PlaybackSession,
	PlaybackTrigger,
	SessionAudio,
	SessionCallbacks,
	SessionPath
} from "@/lib/media/playback/types"

// A file the remux worker turns into fragmented MP4 for MediaSource, read from the SDK worker over a range
// port. A port whose serving worker dies is noticed through that worker's life lock (lib/media/rangePort),
// so a session fails at once rather than at a read timeout, and a dead remux worker through its own.

// The SDK worker's side of a remux session.
export interface RemuxSource {
	// A range port serving the file's decrypted bytes.
	openPort(): Promise<MessagePort>
	// Stops serving the file: every read in flight aborts.
	close(): void
	// The file was opened in the remux worker ahead of playback under this key (prewarm), through a port of
	// this source's: a session takes it over without opening another.
	warmKey?: string
	// Settles once the warm has reached the remux worker (or failed): a take-over sent before it would find
	// nothing to take and open the file a second time.
	warmed?: Promise<void>
	// Settles once the SDK worker answered the warm's port request (opened or refused).
	warmPort?: Promise<void>
}

// The SDK worker answers a port request at once; one that has not by then is gone (a dead worker never
// answers a call at all).
export const OPEN_PORT_TIMEOUT_MS = 10_000
// A warm still on its way by then is given up on: the take-over goes ahead, and the file is opened anew if
// the worker has not got it. One whose port the SDK worker has not answered by then fails as a lost source:
// another port request to the same worker would fare no better.
export const WARM_WAIT_MS = OPEN_PORT_TIMEOUT_MS

const FAILURE_TRIGGERS: Record<MseFailure, PlaybackTrigger> = {
	keyframeIntervalTooLarge: "keyframe-interval",
	stalled: "decode-stall",
	remux: "worker-error",
	media: "media-error",
	source: "network",
	openGopStart: "open-gop-start"
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// What a failure to open or attach says about the rung.
export function remuxOpenFailure(error: unknown): PlaybackFailure {
	const detail = errorDetail(error)

	if (isIdrUnreachable(error)) {
		return { trigger: "open-gop-start", detail }
	}

	if (isSourceReadError(error)) {
		return { trigger: "network", detail }
	}

	// addSourceBuffer refusing the output's codecs.
	if (error instanceof DOMException && error.name === "NotSupportedError") {
		return { trigger: "media-error", detail }
	}

	// The worker died, its pipeline threw, or no MediaSource exists.
	return { trigger: "worker-error", detail }
}

export interface RemuxSessionParams {
	path: Exclude<SessionPath, "direct">
	source: RemuxSource
	size: number
	index: ProbeIndex | null
	startTime: number
	// Null: video alone.
	audio: SessionAudio | null
	// Video starts only at IDR pictures (Firefox with HEVC).
	idrOnlyStart: boolean
	callbacks: SessionCallbacks
	// Embedded text subtitle cues as the remux reads them.
	onTextCues?: ((cues: RemuxTextCue[]) => void) | undefined
	open?: (options: RemuxSessionOptions) => Promise<RemuxSession>
}

export function openRemuxPlaybackSession(params: RemuxSessionParams): PlaybackSession {
	return new RemuxPlaybackSession(params)
}

class RemuxPlaybackSession implements PlaybackSession {
	public readonly path: Exclude<SessionPath, "direct">
	private readonly params: RemuxSessionParams
	private session: RemuxSession | null = null
	private audio: SessionAudio | null
	private failed = false
	private disposed = false
	private portOpen = false

	public constructor(params: RemuxSessionParams) {
		this.params = params
		this.path = params.path
		this.audio = params.audio
	}

	public async attach(video: HTMLVideoElement): Promise<void> {
		const warmKey = this.params.source.warmKey

		try {
			const session = warmKey === undefined ? await this.openWithPort() : await this.openWarm(warmKey)

			if (session === null) {
				return
			}

			if (this.isDisposed()) {
				session.dispose()

				return
			}

			this.session = session
			await session.attach(video)
		} catch (error) {
			// An AbortError is the worker ended at sign-out, not a failure of the rung.
			if (!isAbortError(error)) {
				this.fail(remuxOpenFailure(error))
			}
		}
	}

	// The remux worker takes over the file it warmed, with the port it was warmed through, so the start waits
	// on no SDK worker round trip; a warmed file the worker no longer has is opened anew.
	private async openWarm(warmKey: string): Promise<RemuxSession | null> {
		// The warm port is the source's, closed with it.
		this.portOpen = true

		const { warmed, warmPort } = this.params.source

		if (warmed !== undefined) {
			const port = { answered: warmPort === undefined }
			let timer: ReturnType<typeof setTimeout> | undefined

			const answered = (): void => {
				port.answered = true
			}

			void warmPort?.then(answered, answered)

			const landed = await Promise.race([
				warmed.then(() => true),
				new Promise<false>(resolve => {
					timer = setTimeout(() => {
						resolve(false)
					}, WARM_WAIT_MS)
				})
			]).finally(() => {
				clearTimeout(timer)
			})

			if (this.isDisposed()) {
				return null
			}

			if (!landed && !port.answered) {
				this.closeSource()

				throw new SourceReadError(new Error("the file's byte source did not answer"))
			}
		}

		try {
			return await this.open({ warmKey })
		} catch (error) {
			if (!isWarmGone(error) || this.isDisposed()) {
				throw error
			}

			return this.openWithPort()
		}
	}

	// Null when the session was disposed while the port opened.
	private async openWithPort(): Promise<RemuxSession | null> {
		const source = this.params.source
		let timer: ReturnType<typeof setTimeout> | undefined
		const port = await Promise.race([
			source.openPort(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					// A port that opens after all would otherwise keep its client and file entry until its own
					// idle timeout; a cancel ahead of the registration is honoured when it lands.
					source.close()
					reject(new SourceReadError(new Error("the file's byte source did not answer")))
				}, OPEN_PORT_TIMEOUT_MS)
			})
		]).finally(() => {
			clearTimeout(timer)
		})

		this.portOpen = true

		if (this.isDisposed()) {
			port.close()
			this.closeSource()

			return null
		}

		return this.open({ port })
	}

	private open(file: { port: MessagePort } | { warmKey: string }): Promise<RemuxSession> {
		const { source, size, index, startTime, idrOnlyStart } = this.params
		const open = this.params.open ?? openRemuxSession

		return open({
			...file,
			size,
			startTime,
			idrOnlyStart,
			...(index === null ? {} : { index }),
			audio: this.audio === null ? { trackId: -1, mode: "none" } : { trackId: this.audio.trackId, mode: this.audio.mode },
			onFailure: (reason, detail) => {
				this.fail({ trigger: FAILURE_TRIGGERS[reason], detail })
			},
			...(this.params.onTextCues === undefined ? {} : { onTextCues: this.params.onTextCues }),
			...(source.warmKey === undefined ? {} : { warmKey: source.warmKey })
		})
	}

	public firstTime(): number {
		return this.session?.firstTime() ?? 0
	}

	public async selectAudio(audio: SessionAudio): Promise<boolean> {
		const session = this.session

		if (session === null || audio.mode === "none" || this.audio === null) {
			return false
		}

		await session.selectAudio(audio.trackId, audio.mode)
		this.audio = audio

		return true
	}

	// A method rather than a field read: it changes across awaits.
	private isDisposed(): boolean {
		return this.disposed
	}

	public dispose(): void {
		if (this.disposed) {
			return
		}

		this.disposed = true
		this.session?.dispose()
		this.session = null
		this.closeSource()
	}

	private closeSource(): void {
		if (this.portOpen) {
			this.portOpen = false
			this.params.source.close()
		}
	}

	private fail(failure: PlaybackFailure): void {
		if (this.failed || this.disposed) {
			return
		}

		this.failed = true
		this.params.callbacks.onFailure(failure)
	}
}
