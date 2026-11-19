import * as Comlink from "comlink"
import { isAbortError } from "@filen/shared"
import { holdRemuxWorker, type RemuxWorkerHold } from "@/lib/media/remuxClient"
import { splitForAppend } from "@/lib/media/fmp4Split"
import {
	audioMp4Mime,
	BACK_BUFFER_SECONDS,
	backBufferEviction,
	browserEngine,
	bufferedAhead,
	bufferLimits,
	estimatedBytes,
	evictedAhead,
	forwardBuffered,
	initialAudio,
	isAudioOnlySession,
	MAX_BUFFER_HOLE,
	MAX_EVICTION_REFETCHES,
	needsMore,
	playableRanges,
	QUOTA_SHRINK,
	quotaAction,
	rangesOutside,
	recentEvictions,
	seekPlan,
	sessionAhead,
	shouldEndStream,
	STALL_DETECTION_MS,
	startTarget,
	stallAction,
	supportedCopyCodec,
	TimelineOps,
	trackBitrate,
	unionRanges,
	type BufferLimits,
	type TimeRange
} from "@/lib/media/mseController.logic"
import type { ProbeIndex } from "@filen/shared/videos"
import { holdReadsWhilePlaying } from "@/lib/media/playbackReads"
import { rangePortReader } from "@/lib/media/rangePort"
import {
	AUDIO_TARGET_CODECS,
	IdrUnreachableError,
	isIdrUnreachable,
	isSourceReadError,
	isSuperseded,
	type AudioMode,
	type AudioTarget,
	type RemuxAudioInfo,
	type RemuxEvent,
	type RemuxTextCue,
	type RemuxMediaInfo,
	type RemuxSeekResult,
	type RemuxStats,
	type TrackKind
} from "@/lib/media/remuxTypes"

// Playback of a file the remux worker turns into fragmented MP4, through MediaSource on this thread
// (Firefox exposes MediaSource to windows only). One SourceBuffer per track so an audio switch never
// touches buffered video. On an <audio> element, or for a file without a video track, audio plays alone
// through a single SourceBuffer.

// "source": the file's bytes could not be read. "openGopStart": video must start at an IDR picture and
// none lies within reach of the position.
export type MseFailure = "keyframeIntervalTooLarge" | "stalled" | "remux" | "media" | "source" | "openGopStart"

export interface RemuxSessionOptions {
	// Absent only with `warmKey`: the warmed file is taken over with the port it was warmed with, or the open
	// fails with WarmGoneError (isWarmGone) when the worker no longer has it.
	port?: MessagePort
	size: number
	index?: ProbeIndex
	startTime?: number
	// The audio track and how it plays from the start ("none": video alone, ignored when audio plays alone);
	// otherwise the default track, copied where the MediaSource takes it.
	audio?: { trackId: number; mode: AudioMode }
	// Video starts only at IDR pictures (Firefox with HEVC).
	idrOnlyStart?: boolean
	onFailure(reason: MseFailure, detail: string): void
	// Embedded text subtitle cues as the remux reads them (Matroska).
	onTextCues?: (cues: RemuxTextCue[]) => void
	// The file was warmed under this key (warmRemuxFile): the worker takes it over, a `port` given closes unused.
	warmKey?: string
}

export interface RemuxSessionDiagnostics {
	video: TimeRange[]
	audio: TimeRange[]
	keyTime: number
	audioStartTime: number | null
	ahead: number
	// Appends the browser refused for lack of room.
	quotaErrors: number
	// MediaSources set up (1 + rebuilds for an audio change the SourceBuffers could not follow).
	mediaSources: number
	restarts: number
	endOfStream: boolean
	stats: RemuxStats | null
}

export interface RemuxSession {
	readonly info: RemuxMediaInfo
	readonly audioTracks: readonly RemuxAudioInfo[]
	attach(element: HTMLMediaElement): Promise<void>
	play(): Promise<void>
	seek(time: number): void
	// `mode` overrides the choice between copying and re-encoding the track.
	selectAudio(trackId: number, mode?: AudioMode): Promise<void>
	// Where the stream's first picture is: a loop goes back there. 0 until a start before it found it later.
	firstTime(): number
	diagnostics(): Promise<RemuxSessionDiagnostics>
	dispose(): void
}

type MediaSourceClass = typeof MediaSource

interface ManagedMediaSourceWindow {
	ManagedMediaSource?: MediaSourceClass
}

// MediaSource wherever it exists; ManagedMediaSource only where it does not (iPhone).
function mediaSourceClass(): { type: MediaSourceClass; managed: boolean } | null {
	if (typeof MediaSource !== "undefined") {
		return { type: MediaSource, managed: false }
	}

	const managed = (globalThis as ManagedMediaSourceWindow).ManagedMediaSource

	return managed === undefined ? null : { type: managed, managed: true }
}

function toRanges(ranges: TimeRanges): TimeRange[] {
	const out: TimeRange[] = []

	for (let index = 0; index < ranges.length; index++) {
		out.push([ranges.start(index), ranges.end(index)])
	}

	return out
}

function totalSeconds(ranges: readonly TimeRange[]): number {
	let seconds = 0

	for (const [start, end] of ranges) {
		seconds += end - start
	}

	return seconds
}

// A function, not a property read: the flag changes under the caller between two reads.
function isUpdating(buffer: SourceBuffer): boolean {
	return buffer.updating
}

function isQuotaError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "QuotaExceededError"
}

function once(target: EventTarget, type: string): Promise<void> {
	return new Promise(resolve => {
		target.addEventListener(
			type,
			() => {
				resolve()
			},
			{ once: true }
		)
	})
}

class DisposedError extends Error {
	public constructor() {
		super("playback session disposed")
		this.name = "DisposedError"
	}
}

const STALL_POLL_MS = 250
// Playback seeks the session makes itself (a clamp, a gap skip) land within this of the target.
const INTERNAL_SEEK_TOLERANCE = 0.01
// Older iPhone WebKit has no SourceBuffer.changeType; an audio codec change then takes a new MediaSource.
const CHANGE_TYPE_SUPPORTED =
	typeof SourceBuffer !== "undefined" && typeof (SourceBuffer.prototype as Partial<SourceBuffer>).changeType === "function"

// Before a track has had enough appended to measure, an audio track is assumed at this bitrate.
const AUDIO_BITRATE_GUESS = 192_000

interface Piece {
	generation: number
	bytes: Uint8Array<ArrayBuffer>
	// Total bytes of the segment this piece belongs to, for the quota decision.
	segmentBytes: number
}

type HoldReason = "setup" | "switch" | "quota"

interface TrackHooks {
	// Returns whether to retry the append right away; the hook may instead hold the track.
	onQuota(track: TrackBuffer, piece: Piece): Promise<boolean>
	onAppended(track: TrackBuffer): void
	// After every SourceBuffer operation and whenever the append queue runs dry.
	onSettled(): void
	onError(error: unknown): void
}

// Serialises every operation on one SourceBuffer: appends, removals, abort and changeType all need the
// previous one finished. Appends are queued per generation; anything of an older one is dropped.
class TrackBuffer {
	public readonly kind: TrackKind
	public generation = 0
	public ended = false
	public buffer: SourceBuffer | null = null
	// Every range observed buffered after this generation's appends, for telling eviction from a gap.
	public seen: TimeRange[] = []
	public lastEvictionAt = 0
	// A removal of the session's own is in progress: what a ManagedSourceBuffer reports removed meanwhile is
	// not the browser's eviction.
	public removing = false
	private readonly holds = new Set<HoldReason>()
	private pieces: Piece[] = []
	private running = false
	private appending = false
	// The generation whose segments the SourceBuffer's parser is in.
	private appendedGeneration = -1
	private queue: Promise<void> = Promise.resolve()
	private appendedBytes = 0
	private appendedSeconds = 0
	private readonly hooks: TrackHooks

	public constructor(kind: TrackKind, hooks: TrackHooks) {
		this.kind = kind
		this.hooks = hooks
	}

	public get ranges(): TimeRange[] {
		if (this.buffer === null) {
			return []
		}

		try {
			return toRanges(this.buffer.buffered)
		} catch {
			// A SourceBuffer its MediaSource dropped (the element failed) throws instead of reporting nothing.
			return []
		}
	}

	public get idle(): boolean {
		return this.pieces.length === 0 && !this.running
	}

	public get updating(): boolean {
		return this.buffer?.updating === true
	}

	public bitrate(fallback: number): number {
		return trackBitrate({ bytes: this.appendedBytes, seconds: this.appendedSeconds, fallback })
	}

	public hold(reason: HoldReason): void {
		this.holds.add(reason)
	}

	public release(reason: HoldReason): void {
		this.holds.delete(reason)
		this.resume()
	}

	public isHeld(reason: HoldReason): boolean {
		return this.holds.has(reason)
	}

	public push(generation: number, bytes: Uint8Array<ArrayBuffer>): void {
		for (const piece of splitForAppend(bytes)) {
			this.pieces.push({ generation, bytes: piece, segmentBytes: bytes.length })
		}

		this.resume()
	}

	public resume(): void {
		this.drain().catch((error: unknown) => {
			this.hooks.onError(error)
		})
	}

	// Starts a new generation: queued pieces and a quota hold go, an append in flight is cut short, and
	// the next append starts with the new generation's init segment.
	public reset(generation: number, mediaSource: MediaSource | null): void {
		this.generation = generation
		this.ended = false
		this.pieces = []
		this.seen = []
		this.holds.delete("quota")

		// Only an append can be aborted; a remove in progress is left to finish.
		if (this.appending && this.buffer?.updating === true && mediaSource?.readyState === "open") {
			this.buffer.abort()
		}
	}

	// Replaces the SourceBuffer (a new MediaSource); everything queued belonged to the old one.
	public attachBuffer(buffer: SourceBuffer | null): void {
		this.buffer = buffer
		this.appendedGeneration = -1
		this.queue = Promise.resolve()
	}

	public dispose(): void {
		this.pieces = []
		this.holds.clear()
		this.buffer = null
	}

	public remove(start: number, end: number): Promise<void> {
		return this.run(buffer => {
			this.removing = true
			buffer.remove(start, end)
		}).finally(() => {
			this.removing = false
		})
	}

	// Queued behind every operation already asked for: two callers both seeing `updating` false and
	// both starting one would make the second throw. The operation may decide not to start one.
	public run(operation: (buffer: SourceBuffer) => void): Promise<void> {
		const next = this.queue.then(() => this.execute(operation))

		this.queue = next.catch(() => undefined)

		return next
	}

	private async execute(operation: (buffer: SourceBuffer) => void): Promise<void> {
		const buffer = this.buffer

		if (buffer === null) {
			return
		}

		while (buffer.updating) {
			await once(buffer, "updateend")
		}

		if (this.buffer !== buffer) {
			return
		}

		operation(buffer)

		// appendBuffer and remove update asynchronously; abort and changeType do not.
		if (isUpdating(buffer)) {
			await once(buffer, "updateend")
		}

		this.hooks.onSettled()
	}

	private paused(): boolean {
		return this.holds.size > 0 || this.buffer === null
	}

	private async drain(): Promise<void> {
		if (this.running || this.paused()) {
			return
		}

		this.running = true

		try {
			for (let piece = this.pieces[0]; piece !== undefined && !this.paused(); piece = this.pieces[0]) {
				if (piece.generation !== this.generation) {
					this.pieces.shift()

					continue
				}

				const current = piece
				const before = totalSeconds(this.ranges)
				const outcome = { appended: false }

				try {
					await this.run(buffer => {
						// Superseded while it waited its turn.
						if (current.generation !== this.generation) {
							return
						}

						// A new generation starts with an init segment, while the parser may still be inside the
						// old generation's last media segment (cut off between two pieces): reset it first.
						if (current.generation !== this.appendedGeneration) {
							buffer.abort()
						}

						this.appending = true
						buffer.appendBuffer(current.bytes)
						outcome.appended = true
					})
				} catch (error) {
					// The append never started: what the quota hook runs on the SourceBuffer (a removal) is no
					// append a reset may abort.
					this.appending = false

					if (!isQuotaError(error)) {
						throw error
					}

					if (!(await this.hooks.onQuota(this, current))) {
						return
					}

					continue
				} finally {
					this.appending = false
				}

				// Only this piece: a reset meanwhile replaced the queue with the next generation's.
				const index = this.pieces.indexOf(current)

				if (index !== -1) {
					this.pieces.splice(index, 1)
				}

				if (outcome.appended && current.generation === this.generation) {
					const ranges = this.ranges

					this.appendedGeneration = current.generation
					this.appendedBytes += current.bytes.length
					this.appendedSeconds += Math.max(0, totalSeconds(ranges) - before)
					this.seen = unionRanges(this.seen, ranges)
					this.hooks.onAppended(this)
				}
			}
		} finally {
			this.running = false
			this.hooks.onSettled()
		}
	}
}

function transcodeTargetsOf(source: { type: MediaSourceClass }): AudioTarget[] {
	return (Object.keys(AUDIO_TARGET_CODECS) as AudioTarget[]).filter(target =>
		source.type.isTypeSupported(`audio/mp4; codecs="${AUDIO_TARGET_CODECS[target]}"`)
	)
}

export interface RemuxWarmth {
	// Nobody will take it: the worker closes the file.
	cancel(): void
	// A session is about to take it over (its open names the key): the worker is no longer held for it.
	handOver(): void
}

// The worker is held this long after a hand-over, so it can't idle out between the hand-over and the
// session's own hold.
const HAND_OVER_HOLD_MS = 30_000

// Opens a file in the remux worker ahead of playback (its head and index go into the worker's cache, and where
// video starts only at IDR pictures, the first one is found) under `key`, for an openRemuxSession with the
// same warmKey to take over.
export async function warmRemuxFile(options: {
	port: MessagePort
	size: number
	index?: ProbeIndex
	idrOnlyStart?: boolean
	key: string
}): Promise<RemuxWarmth> {
	const source = mediaSourceClass()

	if (source === null) {
		options.port.close()

		return { cancel: () => undefined, handOver: () => undefined }
	}

	const hold = await holdRemuxWorker()
	let released = false
	const release = (): void => {
		if (!released) {
			released = true
			void hold.remote.unwarm(options.key).catch(() => undefined)
			hold.release()
		}
	}
	const handOver = (): void => {
		if (!released) {
			released = true
			setTimeout(() => {
				hold.release()
			}, HAND_OVER_HOLD_MS)
		}
	}

	try {
		await Promise.race([
			hold.remote.warm(
				Comlink.transfer(
					{
						port: options.port,
						size: options.size,
						transcodeTargets: transcodeTargetsOf(source),
						maxFragmentBytes: deviceBufferLimits(),
						...(options.index === undefined ? {} : { index: options.index }),
						...(options.idrOnlyStart === true ? { idrOnlyStart: true } : {})
					},
					[options.port]
				),
				options.key
			),
			hold.dead
		])
	} catch {
		release()
	}

	return { cancel: release, handOver }
}

export async function openRemuxSession(options: RemuxSessionOptions): Promise<RemuxSession> {
	const source = mediaSourceClass()
	const port = { transferred: false }

	try {
		if (source === null) {
			throw new Error("MediaSource is not available")
		}

		if (options.port === undefined && options.warmKey === undefined) {
			throw new Error("no port to read the file through")
		}

		const transcodeTargets = transcodeTargetsOf(source)
		const limits = deviceBufferLimits()
		const hold: RemuxWorkerHold = await holdRemuxWorker()
		const events: ((event: RemuxEvent) => void)[] = []
		const onEvent = Comlink.proxy((event: RemuxEvent) => {
			for (const listener of events) {
				listener(event)
			}

			return Promise.resolve()
		})

		try {
			port.transferred = true

			const filePort = options.port
			const params =
				filePort === undefined
					? { warmKey: options.warmKey ?? "" }
					: Comlink.transfer(
							{
								port: filePort,
								size: options.size,
								transcodeTargets,
								maxFragmentBytes: limits,
								...(options.index === undefined ? {} : { index: options.index }),
								...(options.idrOnlyStart === true ? { idrOnlyStart: true } : {}),
								...(options.warmKey === undefined ? {} : { warmKey: options.warmKey })
							},
							[filePort]
						)
			const { id, info } = await Promise.race([hold.remote.open(params, onEvent), hold.dead])

			return new MseRemuxSession({ hold, id, info, source, options, events, limits })
		} catch (error) {
			hold.release()

			throw error
		}
	} catch (error) {
		// The serving side would otherwise keep the file's port open until its idle timeout.
		if (!port.transferred && options.port !== undefined) {
			rangePortReader(options.port).close()
		}

		throw error
	}
}

function deviceBufferLimits(): BufferLimits {
	return bufferLimits({
		engine: browserEngine(navigator.userAgent),
		mobile: /Android|iPhone|iPad|Mobile/.test(navigator.userAgent),
		deviceMemoryGiB: "deviceMemory" in navigator && typeof navigator.deviceMemory === "number" ? navigator.deviceMemory : null
	})
}

// The spelling of a copied track's codec string this MediaSource takes; null when it takes none.
function copyCodecFor(track: RemuxAudioInfo, MediaSourceType: MediaSourceClass): string | null {
	return track.copyCodec === null ? null : supportedCopyCodec(track.copyCodec, mime => MediaSourceType.isTypeSupported(mime))
}

async function audioModeFor(track: RemuxAudioInfo, MediaSourceType: MediaSourceClass, canTranscode: boolean): Promise<AudioMode> {
	const copyCodec = copyCodecFor(track, MediaSourceType)

	if (copyCodec !== null) {
		// A static codec table answers isTypeSupported for Dolby audio in some engines; decodingInfo asks
		// the platform decoder.
		if (track.codec !== "ac3" && track.codec !== "eac3") {
			return "copy"
		}

		try {
			const result = await navigator.mediaCapabilities.decodingInfo({
				type: "media-source",
				audio: { contentType: audioMp4Mime(copyCodec), channels: String(track.channels), samplerate: track.sampleRate }
			})

			if (result.supported) {
				return "copy"
			}
		} catch {
			// Unanswerable: transcode.
		}
	}

	return canTranscode ? "transcode" : "none"
}

class MseRemuxSession implements RemuxSession {
	public readonly info: RemuxMediaInfo
	public readonly audioTracks: readonly RemuxAudioInfo[]
	private readonly hold: RemuxWorkerHold
	private readonly id: number
	private readonly MediaSourceType: MediaSourceClass
	private readonly managed: boolean
	private readonly options: RemuxSessionOptions
	private readonly limits: BufferLimits
	private readonly events: ((event: RemuxEvent) => void)[]
	private readonly listener = (event: RemuxEvent) => {
		this.onEvent(event)
	}
	private readonly hooks: TrackHooks = {
		onQuota: (track, piece) => this.handleQuota(track, piece),
		onAppended: track => {
			this.quotaAttempts.delete(track)
			this.maintain()
		},
		onSettled: () => {
			this.maybeEndOfStream()
		},
		onError: error => {
			this.fail("media", error)
		}
	}
	private readonly video = new TrackBuffer("video", this.hooks)
	private readonly audio = new TrackBuffer("audio", this.hooks)
	private readonly ops = new TimelineOps({
		restart: time => this.restart(time),
		onRestartError: (error, superseded) => {
			this.opFailed(error, superseded)
		}
	})
	private readonly disposedSignal = Promise.withResolvers<never>()
	private element: HTMLMediaElement | null = null
	// No video SourceBuffer and no video pump: an <audio> element, or a file without a video track.
	private audioOnly = false
	private mediaSource: MediaSource | null = null
	private objectUrl: string | null = null
	private nextGeneration = 1
	private keyTime = 0
	private audioStartTime: number | null = null
	private audioTrackId: number | null = null
	private audioMode: AudioMode = "none"
	// What the audio SourceBuffer was created with or last changed to.
	private audioMime: string | null = null
	private aheadScale = 1
	private horizon = 0
	// Per track: the two SourceBuffers fill up and drain on their own.
	private readonly quotaAttempts = new Map<TrackBuffer, number>()
	private quotaErrors = 0
	// How to undo each track's quota hold and its wait; cleared by any restart. Ending one track's wait never
	// releases the other: nothing was freed in that SourceBuffer, and the two would re-hold each other without end.
	private readonly quotaWaits = new Map<TrackBuffer, () => void>()
	// When refetches after browser eviction happened, recent ones only.
	private evictions: number[] = []
	private internalSeekTo: number | null = null
	// Where the stream's first picture is, once a start before it found it (startTarget). A seek more than a buffer
	// hole before it lands on it: there is nothing to play earlier, and WebKit's GStreamer build seeking into that gap
	// waits forever. A smaller lead is left to the engine, as moving a seek it is still making can crash that build.
	private streamStart: number | null = null
	// A start position waiting for the element's metadata; until then the playhead is not where it will be.
	private pendingStart: number | null = null
	private stallTimer: ReturnType<typeof setInterval> | undefined
	private lastProgressTime = -1
	private lastProgressAt = 0
	// When the playhead last moved, seeking or not; a quota hold that outlasts it is a dead end.
	private lastAdvanceAt = 0
	private nudges = 0
	// The latest restart asked for is the user's seek, not one of this controller's own (an eviction refetch).
	private userSeek = false
	// Video starts only at IDR pictures and an internal restart found none within reach: what is buffered
	// plays out, and nothing is refetched until the user seeks somewhere reachable.
	private openGopBlocked = false
	private mediaSources = 0
	private restarts = 0
	private endedStream = false
	private disposed = false
	// The worker was ended on purpose (sign-out): nothing after it is a playback failure.
	private workerEnded = false
	private releaseReads: (() => void) | null = null
	private readonly elementListeners: [string, () => void][] = []

	public constructor(params: {
		hold: RemuxWorkerHold
		id: number
		info: RemuxMediaInfo
		source: { type: MediaSourceClass; managed: boolean }
		options: RemuxSessionOptions
		events: ((event: RemuxEvent) => void)[]
		limits: BufferLimits
	}) {
		this.hold = params.hold
		this.id = params.id
		this.info = params.info
		this.audioTracks = params.info.audio
		this.MediaSourceType = params.source.type
		this.managed = params.source.managed
		this.options = params.options
		this.limits = params.limits
		this.events = params.events
		this.events.push(this.listener)
		this.disposedSignal.promise.catch(() => undefined)
		this.hold.dead.catch((error: unknown) => {
			if (isAbortError(error)) {
				this.workerEnded = true

				return
			}

			this.fail("remux", error)
		})
	}

	private get ahead(): number {
		return sessionAhead({
			audioOnly: this.audioOnly,
			limits: this.limits,
			fileBitrate: this.info.bitrate,
			audioBitrate: this.audio.bitrate(this.audioBitrateGuess()),
			scale: this.aheadScale
		})
	}

	public async attach(element: HTMLMediaElement): Promise<void> {
		this.audioOnly = isAudioOnlySession({ elementShowsVideo: element.localName === "video", hasVideoTrack: this.info.hasVideoTrack })

		if (!this.audioOnly && this.info.video === null) {
			throw new Error("no playable video track")
		}

		this.element = element
		// Playback's claim on range reads while the element plays or waits to: a paused session (a paused
		// player, a prefetched next track) leaves background reads their full share.
		if (!this.disposed) {
			this.releaseReads ??= holdReadsWhilePlaying(element)
		}
		// Required before attaching a ManagedMediaSource (its sourceopen waits on it otherwise), and on
		// every path: a remote player could reach neither this page's MediaSource nor its decryption. Not
		// every engine has it.
		if ("disableRemotePlayback" in element) {
			element.disableRemotePlayback = true
		}

		const start = initialAudio({ tracks: this.info.audio, chosen: this.options.audio, audioOnly: this.audioOnly })
		const startTrack = start === null ? undefined : this.info.audio.find(track => track.id === start.trackId)

		if (start !== null && startTrack !== undefined) {
			this.audioTrackId = startTrack.id
			this.audioMode = start.mode ?? (await audioModeFor(startTrack, this.MediaSourceType, this.canTranscode()))
		}

		if (this.audioOnly && (this.audioTrackId === null || this.audioMode === "none")) {
			throw new DOMException("no playable audio track", "NotSupportedError")
		}

		await this.ops.run(() => this.setUp(this.options.startTime ?? 0, false))

		this.listen("seeking", () => {
			this.onSeeking()
		})
		this.listen("timeupdate", () => {
			this.maintain()
		})
		this.listen("error", () => {
			this.fail("media", element.error?.message ?? "media error")
		})
		this.stallTimer = setInterval(() => {
			this.watchStall()
		}, STALL_POLL_MS)
	}

	public async play(): Promise<void> {
		await this.element?.play()
	}

	public seek(time: number): void {
		if (this.element !== null) {
			this.element.currentTime = time
		}
	}

	public firstTime(): number {
		return this.streamStart ?? 0
	}

	public async selectAudio(trackId: number, forcedMode?: AudioMode): Promise<void> {
		const track = this.info.audio.find(candidate => candidate.id === trackId)

		if (track === undefined || this.element === null) {
			return
		}

		await this.ops.run(async () => {
			const element = this.element

			if (element === null || this.disposed) {
				return
			}

			const mode = forcedMode ?? (await audioModeFor(track, this.MediaSourceType, this.canTranscode()))

			// Audio alone has nothing to fall back to: the track that plays stays.
			if (this.audioOnly && mode === "none") {
				throw new DOMException("audio track cannot be played", "NotSupportedError")
			}

			const time = this.playhead(element)
			const hadAudio = this.audio.buffer !== null
			const rebuild = mode === "none" ? hadAudio : !hadAudio

			// A rebuild restarts video too; where it cannot start here, the track stays as it is.
			if (rebuild && this.idrOnlyStart() && !(await this.call(() => this.hold.remote.canStartAt(this.id, time)))) {
				throw new IdrUnreachableError(time)
			}

			this.audioTrackId = trackId
			this.audioMode = mode

			if (mode === "none") {
				await this.call(() => this.hold.remote.stopAudio(this.id))

				// The audio SourceBuffer would hold playback at its end: video plays on without one.
				if (hadAudio) {
					await this.setUp(time, !element.paused)
				}

				return
			}

			// Audio appears where there was none: SourceBuffers can only be added before the first append.
			if (!hadAudio) {
				await this.setUp(time, !element.paused)

				return
			}

			await this.switchAudio(trackId, mode, element)
		})
	}

	public async diagnostics(): Promise<RemuxSessionDiagnostics> {
		return {
			video: this.video.ranges,
			audio: this.audio.ranges,
			keyTime: this.keyTime,
			audioStartTime: this.audioStartTime,
			ahead: this.ahead,
			quotaErrors: this.quotaErrors,
			mediaSources: this.mediaSources,
			restarts: this.restarts,
			endOfStream: this.endedStream,
			stats: this.disposed ? null : await this.call(() => this.hold.remote.stats(this.id)).catch(() => null)
		}
	}

	public dispose(): void {
		if (this.disposed) {
			return
		}

		this.disposed = true
		this.disposedSignal.reject(new DisposedError())
		this.releaseReads?.()
		this.releaseReads = null
		clearInterval(this.stallTimer)
		this.clearQuotaWaits()

		for (const [type, listener] of this.elementListeners) {
			this.element?.removeEventListener(type, listener)
		}

		const index = this.events.indexOf(this.listener)

		if (index !== -1) {
			this.events.splice(index, 1)
		}

		this.video.dispose()
		this.audio.dispose()

		// The worker also releases its proxy of this session's event callback.
		void Promise.race([Promise.resolve().then(() => this.hold.remote.close(this.id)), this.hold.dead])
			.catch(() => undefined)
			.finally(() => {
				this.hold.release()
			})

		if (this.objectUrl !== null) {
			URL.revokeObjectURL(this.objectUrl)
			this.objectUrl = null
		}

		if (this.element !== null) {
			this.element.removeAttribute("src")
			this.element.load()
		}
	}

	// A worker call that rejects when the worker dies or the session is disposed, rather than hanging; a
	// proxy already released with a dead worker throws, which becomes the rejection too.
	private call<T>(invoke: () => Promise<T>): Promise<T> {
		return Promise.race([Promise.resolve().then(invoke), this.hold.dead, this.disposedSignal.promise])
	}

	// The spelling a copy start's MIME carries, so the SourceBuffer is created with one this MediaSource takes.
	private copyCodec(trackId: number): string | null {
		const track = this.info.audio.find(candidate => candidate.id === trackId)

		return track === undefined ? null : copyCodecFor(track, this.MediaSourceType)
	}

	// IDR-only starts concern video; audio alone starts anywhere.
	private idrOnlyStart(): boolean {
		return this.options.idrOnlyStart === true && !this.audioOnly
	}

	// Until the audio SourceBuffer has taken enough to measure: a file holding nothing but audio is as dense
	// as the track.
	private audioBitrateGuess(): number {
		return !this.info.hasVideoTrack && this.info.bitrate > 0 ? this.info.bitrate : AUDIO_BITRATE_GUESS
	}

	// The tracks this session plays.
	private tracks(): TrackBuffer[] {
		return this.audioOnly ? [this.audio] : [this.video, this.audio]
	}

	private canTranscode(): boolean {
		return (Object.keys(AUDIO_TARGET_CODECS) as AudioTarget[]).some(target =>
			this.MediaSourceType.isTypeSupported(`audio/mp4; codecs="${AUDIO_TARGET_CODECS[target]}"`)
		)
	}

	private listen(type: string, listener: () => void): void {
		this.element?.addEventListener(type, listener)
		this.elementListeners.push([type, listener])
	}

	private onEvent(event: RemuxEvent): void {
		if (event.type === "textCues") {
			if (!this.disposed) {
				this.options.onTextCues?.(event.cues)
			}

			return
		}

		const track = event.kind === "video" ? this.video : this.audio

		if (this.disposed || event.generation !== track.generation) {
			return
		}

		if (event.type === "segment") {
			track.push(event.generation, event.bytes)
		} else if (event.type === "ended") {
			track.ended = true
			this.maybeEndOfStream()
		} else {
			this.fail(event.fragmentTooLarge ? "keyframeIntervalTooLarge" : event.sourceLost ? "source" : "remux", event.message)
		}
	}

	private opFailed(error: unknown, superseded: boolean): void {
		if (superseded || isSuperseded(error) || error instanceof DisposedError) {
			return
		}

		this.fail(isIdrUnreachable(error) ? "openGopStart" : isSourceReadError(error) ? "source" : "remux", error)
	}

	// A new MediaSource on the element (first attach, or audio the SourceBuffers cannot follow), with
	// both pumps started at `time` and the element seeked there.
	private async setUp(time: number, resumePlaying: boolean): Promise<void> {
		const element = this.element

		if (element === null) {
			return
		}

		const MediaSourceType = this.MediaSourceType
		const mediaSource = new MediaSourceType()
		const url = URL.createObjectURL(mediaSource)
		const opened = once(mediaSource, "sourceopen")

		this.mediaSources++
		this.endedStream = false
		// A start still waiting for the old MediaSource's metadata is replaced by `time`.
		this.pendingStart = null
		this.mediaSource = mediaSource
		this.objectUrl = url
		this.video.attachBuffer(null)
		this.audio.attachBuffer(null)
		// Both SourceBuffers exist before the first append: engines refuse a new one once the first has
		// been initialised. The audio MIME is only known once the worker picked its output.
		this.video.hold("setup")
		this.audio.hold("setup")

		try {
			element.src = url
			await Promise.race([opened, this.disposedSignal.promise])
			URL.revokeObjectURL(url)
			this.objectUrl = null
			// Unknown (a Matroska file without a duration): open-ended until endOfStream sets it.
			mediaSource.duration = this.info.duration > 0 ? this.info.duration : Number.POSITIVE_INFINITY

			const result = await this.startPumps(time)

			if (result === null || this.mediaSource !== mediaSource) {
				return
			}

			if (!this.audioOnly) {
				const videoInfo = this.info.video

				if (videoInfo === null) {
					throw new Error("no playable video track")
				}

				this.video.attachBuffer(this.addSourceBuffer(this.video, mediaSource, videoInfo.mime))
			}

			this.audio.attachBuffer(result.audio === null ? null : this.addSourceBuffer(this.audio, mediaSource, result.audio.mime))
			this.audioMime = result.audio?.mime ?? null

			// Exactly where asked (a resume position), or the key packet a cues-less file was clamped to. A start before
			// the first picture is left to the stall watch, which skips the gap once playback waits in it.
			const target = result.video?.clamped === true ? result.video.keyTime : time
			const first = startTarget(time, result)

			if (first > time) {
				this.streamStart = first
			}

			if (target > 0) {
				this.seekOnceLoaded(target, mediaSource)
			}
		} finally {
			this.video.release("setup")
			this.audio.release("setup")
		}

		if (resumePlaying) {
			await element.play().catch(() => undefined)
		}
	}

	private addSourceBuffer(track: TrackBuffer, mediaSource: MediaSource, mime: string): SourceBuffer {
		const buffer = mediaSource.addSourceBuffer(mime)

		// A ManagedMediaSource drops buffered media on its own and says which (it reports the session's own
		// removals too); media it dropped ahead of the playhead is fetched again, within the refetch budget.
		if (this.managed) {
			buffer.addEventListener("bufferedchange", event => {
				// One eviction reaches every SourceBuffer: an operation queued or running (the refetch the first
				// buffer's event started among them) already fetches from the playhead on, and maintain() looks
				// again once it is done.
				if (track.removing || this.disposed || this.mediaSource !== mediaSource || this.pendingStart !== null || this.ops.busy) {
					return
				}

				const removed = "removedRanges" in event && event.removedRanges instanceof TimeRanges ? toRanges(event.removedRanges) : []
				const now = this.element?.currentTime ?? 0

				if (removed.some(([, end]) => end > now + MAX_BUFFER_HOLE)) {
					this.refetchEvicted(now)
				}
			})
		}

		return buffer
	}

	// Data ahead of the playhead the browser dropped is fetched again, each time with a smaller window; one that
	// keeps being cut means the GOPs do not fit at all. A file with an index is fetched again from where the
	// buffer was cut, keeping what lies before it; one without restarts at the playhead, since its pumps can
	// land only on a key packet already scanned.
	private refetchEvicted(now: number): void {
		const at = performance.now()

		this.evictions = recentEvictions(this.evictions, at)

		if (this.evictions.length >= MAX_EVICTION_REFETCHES) {
			this.fail("keyframeIntervalTooLarge", "the browser keeps evicting buffered media ahead of the playhead")

			return
		}

		this.evictions.push(at)
		this.aheadScale *= QUOTA_SHRINK

		if (this.info.seekScansFile || this.idrOnlyStart()) {
			this.ops.restart(now)

			return
		}

		void this.ops
			.run(() => this.refill())
			.catch((error: unknown) => {
				this.opFailed(error, this.ops.restartQueued)
			})
	}

	// Restarts the pumps where the playable buffer ahead of the playhead ends, keeping what lies before it; the
	// window still ends `ahead` past the playhead.
	private async refill(): Promise<void> {
		const element = this.element

		// A restart queued behind this fetches everything again anyway.
		if (element === null || this.disposed || this.ops.restartQueued) {
			return
		}

		const now = this.playhead(element)
		const from = now + bufferedAhead(this.playable(), now)

		// Whatever either track holds past the cut is fetched again with the rest, so none of it reads as a hole.
		for (const track of this.tracks()) {
			for (const [start, end] of rangesOutside(track.ranges, Number.NEGATIVE_INFINITY, from)) {
				void track.remove(start, end).catch(() => undefined)
			}
		}

		this.audio.hold("switch")

		try {
			const result = await this.startPumps(from, now)

			if (result !== null && !(await this.followAudioMime(result.audio?.mime ?? null))) {
				await this.setUp(now, !element.paused)
			}
		} finally {
			this.audio.release("switch")
		}
	}

	// Where the playhead is, or will be once the element has metadata for a start position.
	private playhead(element: HTMLMediaElement): number {
		return this.pendingStart ?? element.currentTime
	}

	// A ManagedMediaSource that asked the page to stop streaming gets no new horizon until it allows it again.
	private mayStream(): boolean {
		const mediaSource = this.mediaSource

		return !this.managed || mediaSource === null || !("streaming" in mediaSource) || mediaSource.streaming !== false
	}

	// Bumps the generation for both tracks and restarts the worker's pumps at the key packet at or
	// before `time`, buffering up to `ahead` past `playhead`. Null when a newer restart replaced this one.
	private async startPumps(time: number, playhead: number = time): Promise<RemuxSeekResult | null> {
		const generation = this.nextGeneration++
		const mediaSource = this.mediaSource

		this.restarts++
		this.clearQuotaWaits()
		this.video.reset(generation, mediaSource)
		this.audio.reset(generation, mediaSource)
		this.horizon = Math.max(time, playhead + this.ahead)

		const audio =
			this.audioTrackId !== null && this.audioMode !== "none"
				? { trackId: this.audioTrackId, mode: this.audioMode, copyCodec: this.copyCodec(this.audioTrackId) }
				: null
		const video = !this.audioOnly
		const result = await this.call(() => this.hold.remote.seek(this.id, { generation, time, horizon: this.horizon, video, audio }))

		if (this.video.generation !== generation) {
			return null
		}

		this.keyTime = result.video?.keyTime ?? result.audio?.startTime ?? time
		this.audioStartTime = result.audio?.startTime ?? null

		if (result.audio === null) {
			this.audio.ended = true
		}

		return result
	}

	// Restarts both pumps at `time` on the current MediaSource; only when its audio SourceBuffer cannot
	// take the new output does it fall back to a new MediaSource.
	private async restart(time: number): Promise<void> {
		const element = this.element

		if (element === null || this.disposed) {
			return
		}

		const user = this.userSeek

		this.userSeek = false

		// Asked before anything is torn down, so a start nothing can reach leaves the current pumps playing.
		if (this.idrOnlyStart() && !(await this.call(() => this.hold.remote.canStartAt(this.id, time)))) {
			if (user) {
				this.fail("openGopStart", new IdrUnreachableError(time))
			} else {
				this.openGopBlocked = true
			}

			return
		}

		this.openGopBlocked = false

		// Everything from the target on is fetched again from its key packet, so nothing buffered there is
		// kept: a range left ahead of the playhead would read as a hole the browser had cut.
		for (const track of this.tracks()) {
			for (const [start, end] of rangesOutside(track.ranges, time - BACK_BUFFER_SECONDS, time)) {
				void track.remove(start, end).catch(() => undefined)
			}
		}

		this.audio.hold("switch")

		try {
			const result = await this.startPumps(time)

			if (result === null) {
				return
			}

			if (!(await this.followAudioMime(result.audio?.mime ?? null))) {
				await this.setUp(time, !element.paused)

				return
			}

			const target = startTarget(time, result)

			if (target > time) {
				this.streamStart = target
			}

			// Back to where a file without an index was clamped, or on past a gap at the start no engine skips; a
			// lead within a buffer hole is left to the engine (see streamStart).
			if (target < time || target - time > MAX_BUFFER_HOLE) {
				this.internalSeek(target)
			}
		} finally {
			this.audio.release("switch")
		}
	}

	// Makes the audio SourceBuffer take `mime`. False when it cannot (no changeType, or audio has to
	// appear or go), which only a new MediaSource fixes.
	private async followAudioMime(mime: string | null): Promise<boolean> {
		const buffer = this.audio.buffer

		if (mime === null || buffer === null) {
			return (mime === null) === (buffer === null)
		}

		if (mime === this.audioMime) {
			return true
		}

		if (!CHANGE_TYPE_SUPPORTED) {
			return false
		}

		await this.audio.run(target => {
			target.changeType(mime)
		})
		this.audioMime = mime

		return true
	}

	private async switchAudio(trackId: number, mode: AudioMode, element: HTMLMediaElement): Promise<void> {
		const generation = this.nextGeneration++

		this.audio.reset(generation, this.mediaSource)
		this.audio.hold("switch")

		try {
			await this.audio.remove(0, Number.POSITIVE_INFINITY)

			const now = this.playhead(element)
			// A little before the playhead, so audio is there when the switch lands.
			const result = await this.call(() =>
				this.hold.remote.switchAudio(this.id, {
					generation,
					trackId,
					mode,
					copyCodec: this.copyCodec(trackId),
					time: Math.max(0, now - 0.1),
					horizon: now + this.ahead
				})
			)

			if (this.audio.generation !== generation) {
				return
			}

			this.audioStartTime = result.startTime

			if (!(await this.followAudioMime(result.mime))) {
				await this.setUp(this.playhead(element), !element.paused)
			}
		} finally {
			this.audio.release("switch")
		}
	}

	private onSeeking(): void {
		const element = this.element

		if (element === null) {
			return
		}

		if (this.internalSeekTo !== null && Math.abs(this.internalSeekTo - element.currentTime) < INTERNAL_SEEK_TOLERANCE) {
			this.internalSeekTo = null

			return
		}

		const lead = this.streamStart === null ? 0 : this.streamStart - element.currentTime
		const time = lead > MAX_BUFFER_HOLE && this.streamStart !== null ? this.streamStart : element.currentTime

		if (time !== element.currentTime) {
			this.internalSeek(time)
		}

		this.nudges = 0
		this.pendingStart = null

		if (!this.ops.busy && seekPlan({ time, video: this.videoRanges(), audio: this.audioRanges() }) === "inBuffer") {
			this.maintain()

			return
		}

		this.userSeek = true
		this.ops.restart(time)
	}

	// Some engines (WebKit) drop a position set before the element has metadata; it is set once it has.
	private seekOnceLoaded(time: number, mediaSource: MediaSource): void {
		const element = this.element

		if (element === null) {
			return
		}

		if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
			this.internalSeek(time)

			return
		}

		this.pendingStart = time
		element.addEventListener(
			"loadedmetadata",
			() => {
				if (this.mediaSource === mediaSource && this.pendingStart === time && !this.disposed) {
					this.pendingStart = null
					this.internalSeek(time)
				}
			},
			{ once: true }
		)
	}

	private internalSeek(time: number): void {
		if (this.element !== null) {
			this.internalSeekTo = time
			this.element.currentTime = time
		}
	}

	// A track's ranges, or null for one this session does not play.
	private videoRanges(): TimeRange[] | null {
		return this.audioOnly ? null : this.video.ranges
	}

	private audioRanges(): TimeRange[] | null {
		return this.audio.buffer === null ? null : this.audio.ranges
	}

	private playable(): TimeRange[] {
		return playableRanges(this.videoRanges(), this.audioRanges())
	}

	// Raises the horizon when the forward buffer has drained, refetches what the browser evicted ahead,
	// and trims the back buffer.
	private maintain(): void {
		const element = this.element

		if (element === null || this.disposed || this.ops.busy || this.pendingStart !== null) {
			return
		}

		const now = element.currentTime
		const ahead = this.ahead
		const seen = playableRanges(this.audioOnly ? null : this.video.seen, this.audio.buffer === null ? null : this.audio.seen)

		if (this.quotaWaits.size === 0 && !this.openGopBlocked && evictedAhead({ currentTime: now, ranges: this.playable(), seen })) {
			this.refetchEvicted(now)

			return
		}

		const forward = forwardBuffered(now, this.videoRanges(), this.audioRanges())

		if (needsMore({ bufferedAhead: forward, ahead }) && now + ahead > this.horizon + 1 && this.mayStream()) {
			this.horizon = now + ahead

			for (const track of this.tracks()) {
				void this.call(() => this.hold.remote.setHorizon(this.id, track.kind, track.generation, this.horizon)).catch(
					() => undefined
				)
			}
		}

		const at = performance.now()

		for (const track of this.tracks()) {
			const ranges = track.ranges
			const first = ranges[0]

			if (first === undefined) {
				continue
			}

			const video = track.kind === "video"
			const limit = video ? this.limits.video : this.limits.audio
			const bitrate = track.bitrate(video ? this.info.bitrate : this.audioBitrateGuess())
			const eviction = backBufferEviction({
				currentTime: now,
				bufferedStart: first[0],
				now: at,
				lastEvictionAt: track.lastEvictionAt,
				fillShare: estimatedBytes(ranges, bitrate) / limit
			})

			if (eviction !== null) {
				track.lastEvictionAt = at

				void track.remove(eviction[0], eviction[1]).catch(() => undefined)
			}
		}
	}

	private clearQuotaWait(track: TrackBuffer): void {
		const cancel = this.quotaWaits.get(track)

		this.quotaWaits.delete(track)
		this.quotaAttempts.delete(track)
		cancel?.()
	}

	private clearQuotaWaits(): void {
		for (const track of [this.video, this.audio]) {
			this.clearQuotaWait(track)
		}
	}

	// Returns whether the append should be retried now; false holds the track until playback drains.
	private async handleQuota(track: TrackBuffer, piece: Piece): Promise<boolean> {
		const element = this.element

		if (element === null) {
			return false
		}

		this.quotaErrors++

		const attempt = this.quotaAttempts.get(track) ?? 0

		this.quotaAttempts.set(track, attempt + 1)

		const action = quotaAction({
			attempt,
			currentTime: element.currentTime,
			ranges: track.ranges,
			scale: this.aheadScale
		})

		if (action.type === "fatal") {
			this.fail("keyframeIntervalTooLarge", `a ${String(piece.segmentBytes)}-byte segment does not fit the buffer`)

			return false
		}

		if (action.type === "evict") {
			await track.remove(action.range[0], action.range[1])

			return true
		}

		this.aheadScale = action.scale
		this.clearQuotaWait(track)
		track.hold("quota")

		// Retried once the playhead has moved on enough to free some of what is buffered; a restart
		// (seek) clears the hold instead.
		const resumeAt = element.currentTime + 2
		const resume = () => {
			if (element.currentTime < resumeAt) {
				return
			}

			this.clearQuotaWait(track)
		}

		element.addEventListener("timeupdate", resume)
		this.quotaWaits.set(track, () => {
			element.removeEventListener("timeupdate", resume)
			track.release("quota")
		})

		return true
	}

	private maybeEndOfStream(): void {
		const mediaSource = this.mediaSource
		const state = (track: TrackBuffer) => ({ ended: track.ended, idle: track.idle, updating: track.updating })
		// Audio alone ends only once its SourceBuffer exists: the MediaSource would otherwise end with none.
		const tracks = this.audioOnly
			? [{ ...state(this.audio), ended: this.audio.ended && this.audio.buffer !== null }]
			: [state(this.video), this.audio.buffer === null ? null : state(this.audio)]

		if (mediaSource !== null && !this.disposed && shouldEndStream({ open: mediaSource.readyState === "open", tracks })) {
			mediaSource.endOfStream()
			this.endedStream = true
		}
	}

	private watchStall(): void {
		const element = this.element

		if (element === null) {
			return
		}

		const now = performance.now()

		if (element.currentTime !== this.lastProgressTime) {
			this.lastProgressTime = element.currentTime
			this.lastProgressAt = now
			this.lastAdvanceAt = now
			this.nudges = 0

			return
		}

		// Held for room the playhead never frees, seeking or not.
		if (this.quotaWaits.size > 0 && !element.paused && now - this.lastAdvanceAt >= STALL_DETECTION_MS) {
			this.fail("keyframeIntervalTooLarge", "playback stalled with the buffer full")

			return
		}

		if (element.paused || element.seeking || element.ended || this.ops.busy || this.pendingStart !== null) {
			this.lastProgressAt = now

			return
		}

		const action = stallAction({
			currentTime: element.currentTime,
			ranges: this.playable(),
			stalledMs: now - this.lastProgressAt,
			nudges: this.nudges
		})

		if (action.type === "skip" || action.type === "nudge") {
			if (action.type === "nudge") {
				this.nudges++
			}

			this.lastProgressAt = now
			this.internalSeek(action.to)
		} else if (action.type === "fatal") {
			if (this.openGopBlocked) {
				this.fail("openGopStart", new IdrUnreachableError(element.currentTime))
			} else {
				this.fail("stalled", `no progress at ${String(element.currentTime)}`)
			}
		}
	}

	private fail(reason: MseFailure, error: unknown): void {
		if (this.disposed || this.workerEnded) {
			return
		}

		this.options.onFailure(reason, error instanceof Error ? error.message : String(error))
	}
}
