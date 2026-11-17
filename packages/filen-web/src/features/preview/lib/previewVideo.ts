import type { AnyFile } from "@filen/sdk-rs"
import {
	languagesMatch,
	normalizeLanguage,
	selectAudioTrack,
	type CueStore,
	type LadderDecision,
	type LadderSubtitle,
	type MediaCodec,
	type ProbeAudio,
	type VideoProbe
} from "@filen/shared/videos"
import { openPlayback, type Playback, type PlaybackDeps } from "@/lib/media/playback/openPlayback"
import { captureFramePoster } from "@/lib/media/playback/poster"
import type { RemuxTextCue } from "@/lib/media/remuxTypes"
import { EmbeddedCues } from "@/lib/media/playback/embeddedCues"
import { warmMediaVolume } from "@/lib/media/mediaVolume"
import { createListenerSet } from "@/lib/listenerSet"
import { log } from "@/lib/log"
import { undecodedKinds } from "@/features/preview/lib/playbackGap"
import { CODECS, browserCanPlay } from "@/features/preview/lib/containerTracks"
import { confirmedGap, silentAudioCodec, type PreviewVideoRoute } from "@/features/preview/lib/previewPlayback.logic"
import { STREAM_STALL_MS, STREAM_STALL_POLL_MS, expectsProgress } from "@/lib/media/playback/directSession.logic"
import { audioTracksOf, enableAudioTrack } from "@/lib/media/playback/audioTrackList"
import { menuListsProbeAudio } from "@/features/preview/lib/audioTrackMenu.logic"
import {
	holdPreviewStreamAlive,
	previewStreamIdOf,
	previewStreamStatus,
	releasePreviewStreamSoon
} from "@/features/preview/lib/previewStream"
import type { PreviewStreamStatus } from "@/lib/sw/protocol"

function defaultStatus(url: string): Promise<PreviewStreamStatus> {
	return previewStreamStatus(previewStreamIdOf(url))
}

function defaultRelease(url: string): void {
	releasePreviewStreamSoon(previewStreamIdOf(url))
}

// One preview video on its element. A file the browser plays from a plain src starts on the service
// worker's range route exactly as before, at no probe's cost; anything else, and a direct start that
// fails or turns out to lack its sound or picture, goes through the playback ladder (probe, then direct,
// remux or remux with the audio re-encoded), keeping the position and the frame on screen.

// "active": playing or on its way (the element's own state says which). "unsupported": no rung plays the
// file in this browser. "failed": the bytes could not be read.
export type PreviewVideoStatus = "active" | "unsupported" | "failed"

export interface PreviewVideoSnapshot {
	status: PreviewVideoStatus
	route: PreviewVideoRoute
	probe: VideoProbe | null
	decision: LadderDecision | null
	// The audio codec a rung that plays the picture alone could not play.
	silentCodec: MediaCodec | null
	// Bumped whenever embedded subtitle cues arrived.
	embeddedVersion: number
	// The audio track playing, an index into the probe's audio (-1 until known).
	audioIndex: number
	// The element's own audio tracks on a direct stream (WebKit), named by the element: the audio menu needs no probe.
	nativeAudio: readonly NativeAudioTrack[] | null
}

export interface NativeAudioTrack {
	label: string
	language: string
}

// Whether the probe's audio tracks are the element's, in order: as many, each in the language the element names for it
// where both name one.
export function describesTracks(probed: readonly ProbeAudio[], native: readonly NativeAudioTrack[]): boolean {
	return (
		probed.length === native.length &&
		probed.every((track, index) => {
			const element = native[index]?.language ?? ""

			return normalizeLanguage(track.lang) === null || normalizeLanguage(element) === null || languagesMatch(track.lang, element)
		})
	)
}

// What the outcome of a probe was: the record (null: no container the probe reads), or no answer at all.
export type PreviewProbeResult = { status: "probed"; probe: VideoProbe | null } | { status: "unavailable" }

export interface PreviewVideoDeps {
	// The service worker's URL for the plain-src start.
	registerDirect: () => Promise<string>
	// Whether the service worker still holds the registration behind `url`, asked of its registry (no
	// request reaches the network); previewStreamStatus by default.
	status?: (url: string) => Promise<PreviewStreamStatus>
	// Hands the registration behind `url` back once nothing plays from it; releasePreviewStreamSoon by default.
	release?: (url: string) => void
	// Keeps the service worker, and with it the registration, alive while the element may read from it
	// (paused included); returns the release. holdPreviewStreamAlive by default.
	holdAlive?: () => () => void
	// Calls `listener` when the worker answers a request for `url` with 404; returns the unsubscribe.
	onStreamGone?: (url: string, listener: () => void) => () => void
	now?: () => number
	hidden?: () => boolean
	probe: (signal: AbortSignal) => Promise<PreviewProbeResult>
	// The probe already held in memory, without I/O (the drive's probe service); null where none is.
	peek?: () => VideoProbe | null
	// The ladder's own deps for this file (byte sources, whether a direct rung exists).
	playbackDeps: (allowDirect: boolean) => Partial<PlaybackDeps>
	// The ladder; openPlayback when absent.
	openPlayback?: typeof openPlayback
	capturePoster?: (video: HTMLVideoElement) => Promise<string | null>
}

export interface PreviewVideoOptions {
	file: AnyFile
	name: string
	route: PreviewVideoRoute
	startTime: number
	deps: PreviewVideoDeps
}

// Playback a browser must have decoded something of by now if it can decode the track at all.
const PLAYED_SECONDS_BEFORE_CHECK = 1.5

// Audio codecs every browser decodes without re-encoding: what a default track choice prefers.
const NATIVE_AUDIO: ReadonlySet<string> = new Set(["aac", "mp3", "opus", "vorbis", "flac"])

function userLanguages(): readonly string[] {
	return typeof navigator === "undefined" ? [] : navigator.languages
}

export class PreviewVideo {
	private readonly options: PreviewVideoOptions
	private readonly changes = createListenerSet("preview.video")
	private readonly elementListeners: [string, EventListener][] = []
	private readonly abort = new AbortController()
	private snapshot: PreviewVideoSnapshot
	private video: HTMLVideoElement | null = null
	private playback: Playback | null = null
	private unsubscribePlayback: (() => void) | null = null
	private subtitle: LadderSubtitle = "none"
	// The position the ladder last opened at, for a retry before the element knows where it is.
	private lastTime = 0
	private poster: string | null = null
	// Whether the user wants the plain-src start playing; an error pauses nothing, so it survives one.
	private playIntent = true
	private escalated = false
	private stopStallWatch: (() => void) | null = null
	// The direct start's registration, until it is handed back.
	private directUrl: string | null = null
	// Ends the direct start's hold on the worker.
	private releaseAlive: (() => void) | null = null
	// Bumped by every ladder open: one that a newer open (a retry) overtook leaves without a trace.
	private ladderGeneration = 0
	private disposed = false
	private readonly embedded = new EmbeddedCues()
	// The probe, read at most once per open and shared by the controls' engagement, the gap check and the ladder (a
	// public link's is cached nowhere else); one that failed is read again only by Retry.
	private probeRead: Promise<PreviewProbeResult> | null = null
	private probeFailed = false
	// Whether the controls were engaged: their probe is asked for once.
	private engaged = false
	// The audio track the user picked, which a ladder opened later plays; null while they picked none.
	private wantedAudio: number | null = null

	public readonly subscribe = (listener: () => void): (() => void) => this.changes.subscribe(listener)

	public readonly getSnapshot = (): PreviewVideoSnapshot => this.snapshot

	public constructor(options: PreviewVideoOptions) {
		this.options = options
		this.lastTime = options.startTime

		const held = options.deps.peek?.() ?? null

		this.snapshot = {
			status: "active",
			route: options.route,
			probe: held,
			decision: null,
			silentCodec: null,
			embeddedVersion: 0,
			audioIndex: -1,
			nativeAudio: null
		}

		if (held !== null) {
			this.snapshot = { ...this.snapshot, ...this.directAudio(held) }
		}
	}

	// Where the element really was last, for a restart after the element was emptied (a failure).
	private readonly trackPosition = (): void => {
		const video = this.video

		if (video !== null && video.readyState >= video.HAVE_METADATA && !video.seeking) {
			this.lastTime = video.currentTime
		}
	}

	public open(video: HTMLVideoElement): void {
		this.video = video
		video.addEventListener("timeupdate", this.trackPosition)

		if (this.options.route === "direct") {
			void this.openDirect(video)
		} else {
			void this.openLadder({ time: this.options.startTime, play: true, allowDirect: true })
		}
	}

	// Plays again from where it last was, after a failure.
	public retry(): void {
		const video = this.video

		if (video === null || this.disposed) {
			return
		}

		if (this.probeFailed) {
			this.probeRead = null
			this.probeFailed = false
		}

		this.update({ status: "active" })
		void this.openLadder({ time: this.position(), play: true, allowDirect: !this.escalated })
	}

	private readProbe(): Promise<PreviewProbeResult> {
		this.probeRead ??= this.options.deps
			.probe(this.abort.signal)
			.catch((): PreviewProbeResult => ({ status: "unavailable" }))
			.then(result => {
				this.probeFailed = result.status === "unavailable"

				return result
			})

		return this.probeRead
	}

	// The subtitle kind shown: an embedded text track needs the remux rung, which a direct start moves to.
	public setSubtitle(kind: LadderSubtitle): void {
		if (kind === this.subtitle) {
			return
		}

		this.subtitle = kind

		const direct = this.snapshot.route === "direct" || this.snapshot.decision?.path === "direct"

		if (kind === "embedded-text" && direct && this.snapshot.status === "active") {
			void this.escalate()
		}
	}

	// Reads the probe, for the audio and chapter menus, once per open: called on the first engagement with the controls,
	// so a video nobody reaches for costs no read. A hidden page waits until it is visible.
	public ensureProbe(): void {
		if (this.snapshot.probe !== null || this.engaged || this.disposed) {
			return
		}

		this.engaged = true
		void this.whenVisible().then(async () => {
			if (this.isDisposed()) {
				return
			}

			const result = await this.readProbe()

			if (!this.isDisposed() && result.status === "probed" && result.probe !== null && this.snapshot.probe === null) {
				this.update({ probe: result.probe, ...this.directAudio(result.probe) })
			}
		})
	}

	// On a direct start whose element names no tracks of its own, the track it plays is the probe's default (else its
	// first): what the audio menu marks as playing.
	private directAudio(probe: VideoProbe): Partial<PreviewVideoSnapshot> {
		if (this.snapshot.route !== "direct" || this.escalated || this.snapshot.audioIndex >= 0 || probe.audio.length === 0) {
			return {}
		}

		return {
			audioIndex: Math.max(
				0,
				probe.audio.findIndex(track => track.def)
			)
		}
	}

	private whenVisible(): Promise<void> {
		const hidden = this.options.deps.hidden ?? (() => typeof document !== "undefined" && document.hidden)

		if (!hidden()) {
			return Promise.resolve()
		}

		return new Promise(resolve => {
			const listener = (): void => {
				if (!hidden() || this.disposed) {
					document.removeEventListener("visibilitychange", listener)
					resolve()
				}
			}

			document.addEventListener("visibilitychange", listener)
		})
	}

	// Plays the probe's audio track `index`: in place where the element switches its own tracks (WebKit's direct
	// stream) and plays that track's codec, through the ladder's own switch once it plays, else by moving a direct
	// start to the ladder. A pick made while the ladder opens is the track it plays.
	public selectAudio(index: number): void {
		if (index === this.snapshot.audioIndex || this.disposed || this.snapshot.status !== "active") {
			return
		}

		this.wantedAudio = index

		const playback = this.playback

		if (playback !== null) {
			void playback.selectAudio(index).catch((error: unknown) => {
				log.warn("preview.video", "switching the audio track failed", error)
			})

			return
		}

		if (this.snapshot.route === "direct" && !this.escalated) {
			// The menu the pick came from: the probe's tracks, or the element's own.
			void this.switchDirectAudio(index, menuListsProbeAudio(this.snapshot.probe))
		}
	}

	private async switchDirectAudio(index: number, probeIndexed: boolean): Promise<void> {
		const video = this.video
		const native = this.snapshot.nativeAudio

		if (video === null || native === null) {
			await this.escalate(index)

			return
		}

		const result = this.snapshot.probe === null ? await this.readProbe() : { status: "probed" as const, probe: this.snapshot.probe }

		if (this.isDisposed() || this.escalated || this.wantedAudio !== index) {
			return
		}

		const probe = result.status === "probed" ? result.probe : null
		const described = probe !== null && describesTracks(probe.audio, native)

		// A pick of the probe's tracks the element's own cannot be matched to (WebKit lists fewer, or others) would switch
		// the wrong one: the ladder plays the probe's.
		if (probeIndexed && !described) {
			await this.escalate(index)

			return
		}

		const codec = described ? (probe.audio[index]?.codec ?? null) : null

		// Only a codec the probe names for that very track, which the element cannot play, moves the stream to the ladder.
		// Without one (no probe, none that reads the file, a track it cannot name) the element switches its own track.
		if (codec !== null && !browserCanPlay(video)(CODECS[codec].query)) {
			await this.escalate(index)

			return
		}

		if (enableAudioTrack(video, index)) {
			this.update({ audioIndex: index })

			return
		}

		await this.escalate(index)
	}

	// The embedded cues of `track` read so far; null before any. Rebuilt only when that track got cues; `_version`
	// is the snapshot's embeddedVersion the caller rendered with, so a memoizing caller asks again.
	public embeddedCues(track: number, _version: number): CueStore | null {
		return this.embedded.store(track)
	}

	public dispose(): void {
		if (this.disposed) {
			return
		}

		this.disposed = true
		this.stopStallWatch?.()
		this.releaseDirect()
		this.abort.abort()
		this.stopPlayback()
		this.clearElementListeners()
		this.clearPoster()
		this.changes.clear()

		const video = this.video

		if (video !== null) {
			video.removeEventListener("timeupdate", this.trackPosition)
			// Removing the attribute empties the element; `src = ""` would load the page itself as media.
			video.removeAttribute("src")
			video.load()
		}
	}

	private releaseUrl(url: string): void {
		const release = this.options.deps.release ?? defaultRelease

		release(url)
	}

	// Once the element no longer reads the direct start's URL: disposed, or moved to the ladder.
	private releaseDirect(): void {
		this.releaseAlive?.()
		this.releaseAlive = null

		if (this.directUrl !== null) {
			this.releaseUrl(this.directUrl)
			this.directUrl = null
		}
	}

	private isDisposed(): boolean {
		return this.disposed
	}

	private position(): number {
		const video = this.video

		return video !== null && video.readyState >= video.HAVE_METADATA ? video.currentTime : this.lastTime
	}

	private async openDirect(video: HTMLVideoElement): Promise<void> {
		let url: string

		try {
			url = await this.options.deps.registerDirect()
		} catch (error) {
			log.warn("preview.video", "stream registration failed", error)

			if (!this.isDisposed()) {
				void this.escalate()
			}

			return
		}

		if (this.isDisposed()) {
			this.releaseUrl(url)

			return
		}

		this.directUrl = url
		this.releaseAlive = (this.options.deps.holdAlive ?? holdPreviewStreamAlive)()

		const start = this.options.startTime

		this.listen(video, "loadedmetadata", () => {
			if (start > 0) {
				video.currentTime = start
			}

			this.readNativeAudio(video)

			void warmMediaVolume().then(() => {
				if (!this.isDisposed() && this.snapshot.route === "direct") {
					video.play().catch(() => undefined)
				}
			})
		})
		this.listen(video, "play", () => {
			this.playIntent = true
		})
		this.listen(video, "pause", () => {
			this.playIntent = false
		})
		// A stream that broke or a file the browser cannot decode: the ladder reads through the SDK instead,
		// and decides whether anything plays.
		this.listen(video, "error", () => {
			void this.escalate()
		})
		this.watchForGap(video)
		this.watchForStall(video, url)
		video.src = url
	}

	// The element's own audio tracks (WebKit), free once its metadata is in: more than one fills the audio menu.
	private readNativeAudio(video: HTMLVideoElement): void {
		const tracks = audioTracksOf(video)

		if (tracks === undefined) {
			return
		}

		const native: NativeAudioTrack[] = []
		let enabled = -1

		for (let index = 0; index < tracks.length; index++) {
			const track = tracks[index]

			native.push({ label: track?.label ?? "", language: track?.language ?? "" })

			if (track?.enabled === true && enabled < 0) {
				enabled = index
			}
		}

		this.update({ nativeAudio: native, audioIndex: enabled })
	}

	// WebKit retries a range request the service worker answers 404 for ever, without an error: a playhead
	// that waits on the stream for STREAM_STALL_MS has the worker asked once whether it still holds the
	// registration, and one it no longer serves moves playback to the ladder (which reads through the SDK
	// worker). A hidden page's clock starts over.
	private watchForStall(video: HTMLVideoElement, url: string): void {
		const now = this.options.deps.now ?? (() => performance.now())
		const hidden = this.options.deps.hidden ?? (() => typeof document !== "undefined" && document.hidden)
		let progressAt = now()
		let progressTime = -1
		let checking = false
		const timer = setInterval(() => {
			if (this.snapshot.route !== "direct" || this.isDisposed()) {
				clearInterval(timer)

				return
			}

			if (hidden() || !expectsProgress(video) || video.currentTime !== progressTime) {
				progressAt = now()
				progressTime = video.currentTime

				return
			}

			if (checking || now() - progressAt < STREAM_STALL_MS) {
				return
			}

			checking = true
			void (this.options.deps.status ?? defaultStatus)(url)
				.catch(() => "missing" as const)
				.then(status => {
					checking = false
					progressAt = now()

					// A worker that could not be asked ("unknown") is waited on.
					if (status === "missing" || status === "lost") {
						clearInterval(timer)
						void this.escalate()
					}
				})
		}, STREAM_STALL_POLL_MS)

		// The worker says so itself when it answers 404 (WebKit would retry for ever): no stall to wait out.
		const stopGone =
			this.options.deps.onStreamGone?.(url, () => {
				if (this.snapshot.route === "direct") {
					void this.escalate()
				}
			}) ?? null

		this.stopStallWatch = () => {
			clearInterval(timer)
			stopGone?.()
		}
	}

	// Once the element has played a moment, a kind it decoded nothing of is checked against the probe; a
	// track the browser cannot decode moves playback to the ladder, which re-encodes or names it.
	private watchForGap(video: HTMLVideoElement): void {
		let played = 0
		let last = video.currentTime
		const onTimeUpdate = (): void => {
			const delta = video.currentTime - last

			last = video.currentTime

			// A seek or a loop back is not playback.
			if (video.seeking || delta <= 0 || delta > 1) {
				return
			}

			played += delta

			if (played < PLAYED_SECONDS_BEFORE_CHECK) {
				return
			}

			video.removeEventListener("timeupdate", onTimeUpdate)

			const kinds = undecodedKinds(video)

			if (kinds.length > 0) {
				void this.checkGap(video, kinds)
			}
		}

		this.listen(video, "timeupdate", onTimeUpdate)
	}

	private async checkGap(video: HTMLVideoElement, kinds: ReturnType<typeof undecodedKinds>): Promise<void> {
		const result = await this.readProbe()

		if (this.isDisposed() || result.status !== "probed") {
			return
		}

		if (result.probe === null) {
			return
		}

		const canPlay = browserCanPlay(video)
		const codec = confirmedGap(result.probe, kinds, candidate => canPlay(CODECS[candidate].query))

		if (codec !== null) {
			this.update({ probe: result.probe })
			void this.escalate()
		}
	}

	// Leaves the plain-src start for the ladder at the same position and play state, the frame kept as the
	// poster meanwhile, with the audio track `audioIndex` when one was asked for. Once only: the ladder handles its own
	// failures from there.
	private async escalate(audioIndex?: number): Promise<void> {
		const video = this.video

		if (video === null || this.escalated || this.isDisposed()) {
			return
		}

		this.escalated = true
		this.stopStallWatch?.()
		this.clearElementListeners()
		await this.bridgePoster(video)

		if (this.isDisposed()) {
			return
		}

		// Read after the bridge: a seek made meanwhile is where the ladder opens.
		const time = this.position()
		const play = this.playIntent

		video.removeAttribute("src")
		video.load()
		this.releaseDirect()
		await this.openLadder({ time, play, allowDirect: false, ...(audioIndex === undefined ? {} : { audioIndex }) })
	}

	private async bridgePoster(video: HTMLVideoElement): Promise<void> {
		const poster = await (this.options.deps.capturePoster ?? captureFramePoster)(video)

		if (poster === null) {
			return
		}

		if (this.isDisposed()) {
			URL.revokeObjectURL(poster)

			return
		}

		this.clearPoster()
		this.poster = poster
		video.poster = poster
		video.addEventListener(
			"canplay",
			() => {
				this.clearPoster()
			},
			{ once: true }
		)
	}

	private clearPoster(): void {
		if (this.poster === null) {
			return
		}

		URL.revokeObjectURL(this.poster)
		this.poster = null
		this.video?.removeAttribute("poster")
	}

	private async openLadder(params: { time: number; play: boolean; allowDirect: boolean; audioIndex?: number }): Promise<void> {
		const video = this.video

		if (video === null) {
			return
		}

		const generation = ++this.ladderGeneration
		const superseded = (): boolean => this.isDisposed() || generation !== this.ladderGeneration

		this.stopPlayback()
		this.lastTime = params.time
		this.update({ route: "ladder", status: "active" })

		const known = this.snapshot.probe
		const result: PreviewProbeResult = known !== null ? { status: "probed", probe: known } : await this.readProbe()

		if (superseded()) {
			return
		}

		if (result.status === "unavailable") {
			this.update({ status: "failed" })

			return
		}

		const probe = result.probe

		if (probe === null) {
			this.update({ status: "unsupported", probe: null })

			return
		}

		// The track asked for, else the one the user picked; otherwise the ladder's own choice (a playable one in the
		// user's language), not whichever the element had enabled.
		const chosen = params.audioIndex ?? this.wantedAudio
		const audioIndex =
			chosen !== null && chosen < probe.audio.length
				? chosen
				: selectAudioTrack(
						probe.audio.map(track => ({ lang: track.lang, default: track.def })),
						{
							userLanguages: userLanguages(),
							playable: (_track, index) => {
								const codec = probe.audio[index]?.codec ?? null

								return codec !== null && NATIVE_AUDIO.has(codec)
							}
						}
					)

		this.update({ probe, audioIndex, nativeAudio: null })

		if (params.play) {
			await warmMediaVolume()
		}

		let playback: Playback

		try {
			const open = this.options.deps.openPlayback ?? openPlayback
			const deps = this.options.deps.playbackDeps(params.allowDirect)

			if (superseded()) {
				return
			}

			playback = await open(
				video,
				this.options.file,
				probe,
				{ audioIndex, subtitle: this.subtitle },
				{
					name: this.options.name,
					startTime: params.time,
					autoplay: params.play,
					onTextCues: cues => {
						this.addTextCues(cues)
					},
					deps
				}
			)
		} catch (error) {
			log.warn("preview.video", "opening playback failed", error)

			if (!superseded()) {
				this.update({ status: "failed" })
			}

			return
		}

		if (superseded()) {
			playback.dispose()

			return
		}

		this.playback = playback
		this.unsubscribePlayback = playback.subscribe(() => {
			this.syncPlayback()
		})
		this.syncPlayback()

		// A track picked while it opened.
		if (this.wantedAudio !== null && this.wantedAudio !== audioIndex && this.wantedAudio < probe.audio.length) {
			void playback.selectAudio(this.wantedAudio).catch((error: unknown) => {
				log.warn("preview.video", "switching the audio track failed", error)
			})
		}
	}

	private syncPlayback(): void {
		const playback = this.playback
		const probe = this.snapshot.probe

		if (playback === null || probe === null) {
			return
		}

		const state = playback.getSnapshot()

		this.update({
			decision: state.decision,
			audioIndex: state.selection.audioIndex,
			status: state.status === "unsupported" ? "unsupported" : state.status === "failed" ? "failed" : "active",
			silentCodec:
				state.decision.path === "video-only" && probe.audio.length > 0 ? silentAudioCodec(probe, state.selection.audioIndex) : null
		})
	}

	// Only the tracks the probe offers are kept (EmbeddedCues bounds the rest).
	private addTextCues(cues: readonly RemuxTextCue[]): void {
		const subs = this.snapshot.probe?.subs

		if (this.disposed || subs === undefined) {
			return
		}

		if (this.embedded.add(cues, track => subs.some(sub => sub.id === track)).size > 0) {
			this.update({ embeddedVersion: this.snapshot.embeddedVersion + 1 })
		}
	}

	private stopPlayback(): void {
		this.unsubscribePlayback?.()
		this.unsubscribePlayback = null
		this.playback?.dispose()
		this.playback = null
	}

	private listen(video: HTMLVideoElement, type: string, listener: () => void): void {
		video.addEventListener(type, listener)
		this.elementListeners.push([type, listener])
	}

	private clearElementListeners(): void {
		const video = this.video

		for (const [type, listener] of this.elementListeners) {
			video?.removeEventListener(type, listener)
		}

		this.elementListeners.length = 0
	}

	private update(patch: Partial<PreviewVideoSnapshot>): void {
		if (this.disposed) {
			return
		}

		this.snapshot = { ...this.snapshot, ...patch }
		this.changes.emit()
	}
}
