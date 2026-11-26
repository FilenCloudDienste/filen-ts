import type { File as SdkFile } from "@filen/sdk-rs"
import { itemKey, seriesKey, type CueStore, type ItemRec, type LadderSubtitle, type VideoProbe } from "@filen/shared/videos"
import type { RemuxTextCue } from "@/lib/media/remuxTypes"
import type { PlaybackFailure, PlaybackTrigger } from "@/lib/media/playback/types"
import { EmbeddedCues } from "@/lib/media/playback/embeddedCues"
import { embeddedTextReachable, openPlayback, type Playback, type PlaybackSnapshot } from "@/lib/media/playback/openPlayback"
import { createListenerSet } from "@/lib/listenerSet"
import { log } from "@/lib/log"
import { videoLibrary } from "@/features/videos/lib/index"
import { probeService } from "@/features/videos/lib/probeService"
import { PROBE_RANK } from "@/features/videos/lib/probeService.logic"
import { watchState, type WatchItem } from "@/features/videos/lib/watchState"
import { captureFrameFromVideo } from "@/features/videos/lib/frames"
import { storeCapturedFrame } from "@/features/videos/lib/artwork"
import { planStart, type StartRequest } from "@/features/videos/lib/player/resume.logic"
import { stackProgress, type WatchItemTarget } from "@/features/videos/lib/player/watchTarget.logic"
import { defaultAudioIndex } from "@/features/videos/lib/player/audioChoice.logic"

// Plays watch targets on the stage's one <video> element: finds the files, probes them (cached), opens the
// playback ladder at the resume point, follows stacked parts, and reports progress to the watch state.
// Its snapshot changes on discrete events only (an item opening, a status change); position never goes
// through it.

export type PlayerPhase = "idle" | "loading" | "ready" | "missing" | "probeFailed" | "unsupported" | "failed"

export interface PlayerSnapshot {
	phase: PlayerPhase
	target: WatchItemTarget | null
	part: number
	probe: VideoProbe | null
	playback: PlaybackSnapshot | null
	audioIndex: number
	partDurations: readonly (number | null)[]
	// Started from a resume point (the "Resumed at" pill), with the position it started at.
	resumedAt: number | null
	// play() was refused (no user activation): the caller offers a play button.
	autoplayBlocked: boolean
	// Bumped each time an item or part starts, so the UI can reset per-item state.
	epoch: number
	// Bumped whenever cues of the shown embedded subtitle track arrived (embeddedCues).
	embeddedVersion: number
	// No remux rung plays the open part whole in this browser, so its embedded text tracks can't be shown: it keeps
	// playing direct, and they are offered as unavailable.
	embeddedTextBlocked: boolean
}

const IDLE: PlayerSnapshot = {
	phase: "idle",
	target: null,
	part: 0,
	probe: null,
	playback: null,
	audioIndex: -1,
	partDurations: [],
	resumedAt: null,
	autoplayBlocked: false,
	epoch: 0,
	embeddedVersion: 0,
	embeddedTextBlocked: false
}

// After a failure the item opens again by itself after these waits, then the failure card's Retry is left. The
// count holds across the reopens, so a lasting failure isn't retried forever.
export const AUTO_RETRY_DELAYS_MS = [1000, 2000, 4000] as const
// Playing on this long after a reopen earns the automatic retries back.
const AUTO_RETRY_RESET_SECONDS = 30

// Failures a reopen may get past. The others (a keyframe interval too large for the buffer, an open GOP start, a
// ladder out of rungs) come back the same for the same file in the same browser.
const PASSING_TRIGGERS: ReadonlySet<PlaybackTrigger> = new Set(["network", "stream-unavailable", "no-metadata", "decode-stall"])

// A failure worth an automatic reopen: none known (the open itself threw), one of the moment, or one a hidden tab
// may have caused.
export function isPassingFailure(failure: PlaybackFailure | null): boolean {
	return failure === null || failure.learnable === false || PASSING_TRIGGERS.has(failure.trigger)
}

// The player waits this long at most for the watch state's first read (another device's newer resume point)
// before it starts from what it has; a flush in another tab can hold the lock much longer.
export const WATCH_STATE_WAIT_MS = 1500

// A pause this early or this close to the end leaves no still worth keeping.
const CAPTURE_MIN_POSITION_SECONDS = 5
const CAPTURE_END_FRACTION = 0.95

function userLanguages(): readonly string[] {
	return typeof navigator === "undefined" ? [] : navigator.languages
}

export interface OpenRequest {
	target: WatchItemTarget
	start: StartRequest
	// Started by the user (a click) rather than by autoplay: play() is expected to be allowed.
	autoplay: boolean
	// An audio track picked before opening (the detail page); the automatic choice when absent or out of range.
	audioIndex?: number
}

export class PlayerController {
	private snapshot: PlayerSnapshot = IDLE
	private readonly changes = createListenerSet("videos.player")
	private video: HTMLVideoElement | null = null
	private playback: Playback | null = null
	private unsubscribePlayback: (() => void) | null = null
	private files: SdkFile[] = []
	private generation = 0
	private readonly elementListeners: [string, () => void][] = []
	private onEnded: (() => void) | null = null
	private captureDone = false
	// What this item last reported to the watch state, ended with a stop whatever happens next.
	private lastReported: { item: WatchItem; pos: number; dur: number } | null = null
	// Where the element last really was (part, seconds), for a retry; null before the first position.
	private lastPosition: { key: string; part: number; time: number } | null = null
	// The item was already reported as finished (Up Next advanced past its credits).
	private finished = false
	// Embedded text cues of the open file, by track number, as the remux has read them.
	private readonly embedded = new EmbeddedCues()
	// Text tracks the open part's probe offers: cues of any other track are not kept.
	private offeredTracks: ReadonlySet<number> = new Set()
	private readonly offered = (track: number): boolean => this.offeredTracks.has(track)
	// The embedded track the caller shows: only its cues re-render.
	private shownEmbedded: number | null = null
	// What the ladder is told about subtitles: an embedded text track needs the remux rung.
	private subtitleKind: LadderSubtitle = "none"
	// The audio track picked before opening, for the next part opened only.
	private pickedAudio: number | null = null
	// The audio track the user chose for the open item, kept across its reopens (a retry, the next part, Start over).
	private chosenAudio: { key: string; part: number; index: number; lang: string | null } | null = null
	// Automatic retries spent on the open item, and where its current open first really played.
	private autoRetries = 0
	private playedFrom: number | null = null

	public readonly subscribe = (listener: () => void): (() => void) => this.changes.subscribe(listener)

	public readonly getSnapshot = (): PlayerSnapshot => this.snapshot

	// The whole item (every part) ended; the caller decides what comes next.
	public setOnEnded(listener: (() => void) | null): void {
		this.onEnded = listener
	}

	public attach(video: HTMLVideoElement | null): void {
		if (this.video === video) {
			return
		}

		this.detachElement()
		this.video = video

		if (video === null) {
			return
		}

		const listen = (type: string, listener: () => void): void => {
			video.addEventListener(type, listener)
			this.elementListeners.push([type, listener])
		}

		listen("timeupdate", () => {
			this.report(false)
		})
		listen("play", () => {
			this.report(true)
			this.captureDone = false

			if (this.snapshot.autoplayBlocked) {
				this.update({ autoplayBlocked: false })
			}
		})
		listen("pause", () => {
			this.report(true)
			this.captureStill()
		})
		listen("ended", () => {
			this.handleEnded()
		})
	}

	public async open(request: OpenRequest, partOverride?: { part: number; position: number }): Promise<void> {
		const video = this.video

		if (video === null) {
			return
		}

		const generation = ++this.generation

		this.stopCurrent()

		const { target } = request
		const keepTarget = this.snapshot.target?.key === target.key

		if (!keepTarget) {
			this.chosenAudio = null
			this.autoRetries = 0
		}

		const part = partOverride?.part ?? 0

		this.pickedAudio = request.audioIndex ?? null
		this.playedFrom = null
		this.embedded.clear()
		this.offeredTracks = new Set()
		this.update({
			...IDLE,
			phase: "loading",
			target,
			part,
			// A reopen of the same part keeps its tracks on offer, so a subtitle choice holds while it reopens.
			probe: keepTarget && part === this.snapshot.part ? this.snapshot.probe : null,
			embeddedTextBlocked: keepTarget && part === this.snapshot.part && this.snapshot.embeddedTextBlocked,
			epoch: this.snapshot.epoch + 1,
			embeddedVersion: this.snapshot.embeddedVersion + 1,
			partDurations: keepTarget ? this.snapshot.partDurations : target.parts.map(() => null)
		})

		// The resume point comes from the watch state: local journal plus the newest save from other devices, waited
		// for briefly. A part switch or a retry starts at a known position and doesn't wait.
		const [files] = await Promise.all([
			videoLibrary.playableFiles(target.parts.map(part => part.file.stableUuid)),
			partOverride === undefined ? this.awaitWatchState() : Promise.resolve()
		])

		if (generation !== this.generation) {
			return
		}

		const ordered = target.parts.map(part => files.find(file => file.stableUUID === part.file.stableUuid))

		if (ordered.some(file => file === undefined)) {
			this.update({ phase: "missing" })

			return
		}

		this.files = ordered.filter(file => file !== undefined)

		const partDurations = await this.partDurations(generation)

		if (generation !== this.generation) {
			return
		}

		const first = this.files[0]

		if (first === undefined) {
			this.update({ phase: "missing" })

			return
		}

		const plan =
			partOverride === undefined
				? planStart({
						request: request.start,
						rec: this.record(target.key),
						file: { uuid: first.uuid, size: Number(first.size) },
						partDurations
					})
				: { ...partOverride, resumed: false }

		await this.openPart(
			generation,
			target,
			plan.part,
			plan.position,
			request.autoplay,
			plan.resumed ? plan.position : null,
			partDurations
		)
	}

	// Plays the same item again from where it last really was (after a failure, a long stall, a failed probe), else
	// from its resume point. The element itself is no witness: a failed or restarting element reads 0.
	public async retry(): Promise<void> {
		const target = this.snapshot.target

		if (target === null || this.video === null) {
			return
		}

		const last = this.lastPosition?.key === target.key ? this.lastPosition : null

		await (last === null
			? this.open({ target, start: "resume", autoplay: true })
			: this.open({ target, start: "resume", autoplay: true }, { part: last.part, position: last.time }))
	}

	// The wait before the next automatic retry of a failed item; null once they are spent, or when the failure
	// would only come back.
	public autoRetryDelay(): number | null {
		if (this.snapshot.phase === "failed" && !isPassingFailure(this.snapshot.playback?.failure ?? null)) {
			return null
		}

		return AUTO_RETRY_DELAYS_MS[this.autoRetries] ?? null
	}

	// A retry nobody asked for: counted, and only while the item still failed.
	public async autoRetry(): Promise<void> {
		if (this.snapshot.phase !== "failed" || this.autoRetryDelay() === null) {
			return
		}

		this.autoRetries += 1
		await this.retry()
	}

	// The connection went away: coming back earns the automatic retries again.
	public resetAutoRetries(): void {
		this.autoRetries = 0
	}

	// An embedded text track was chosen (or not): it needs the remux rung, which a direct stream (an MKV played as
	// it is) restarts on, at the same position. `embeddedTrack` is the track shown, whose cues re-render.
	public setSubtitleKind(kind: LadderSubtitle, embeddedTrack: number | null = null): void {
		if (embeddedTrack !== this.shownEmbedded) {
			this.shownEmbedded = embeddedTrack

			// Cues that arrived after the caller last read the track.
			if (embeddedTrack !== null && this.embedded.stale(embeddedTrack)) {
				this.update({ embeddedVersion: this.snapshot.embeddedVersion + 1 })
			}
		}

		if (kind === this.subtitleKind) {
			return
		}

		this.subtitleKind = kind

		if (kind === "embedded-text" && this.snapshot.playback?.decision.path === "direct") {
			void this.moveToRemux()
		}
	}

	// A direct stream restarts on the remux rung for an embedded text track only when that rung plays the file whole;
	// otherwise it keeps playing and the tracks are marked unavailable.
	private async moveToRemux(): Promise<void> {
		const generation = this.generation
		const { probe, part, audioIndex, embeddedTextBlocked } = this.snapshot
		const file = this.files[part]

		if (probe === null || file === undefined || embeddedTextBlocked) {
			return
		}

		const reachable = await this.embeddedReachable(file, probe, audioIndex)

		if (generation !== this.generation || this.subtitleKind !== "embedded-text") {
			return
		}

		if (reachable) {
			await this.retry()
		} else {
			this.update({ embeddedTextBlocked: true })
		}
	}

	private async embeddedReachable(file: SdkFile, probe: VideoProbe, audioIndex: number): Promise<boolean> {
		try {
			return await embeddedTextReachable(file, probe, { audioIndex, subtitle: "embedded-text" })
		} catch (error) {
			log.warn("videos.player", "deciding the embedded subtitle rung failed", error)

			return false
		}
	}

	// The cues of embedded track `track` read so far; null before any. The store is rebuilt only when that track got
	// cues. `_version` is the snapshot's embeddedVersion the caller rendered with, so a memoizing caller asks again.
	public embeddedCues(track: number, _version: number): CueStore | null {
		return this.embedded.store(track)
	}

	// The autoplay-blocked card's Play: a user gesture, so play() is allowed now.
	public play(): void {
		const video = this.video

		if (video !== null) {
			video.play().catch((error: unknown) => {
				log.warn("videos.player", "play refused", error)
			})
		}
	}

	// Up Next moved on past the credits: the item counts as played to its end.
	public finish(): void {
		const item = this.watchItem()
		const position = this.currentProgress()

		if (item === null || position === null || this.finished) {
			return
		}

		this.finished = true
		void watchState.reportStop({ item, pos: position.pos, dur: position.dur, ended: true })
	}

	// The item ended and plays again from its start (repeat), as a new watch session: the one that ended was reported
	// already. One part goes back on the playback it has, as the preview's loop does; a stack opens its first part.
	public replay(): void {
		const target = this.snapshot.target
		const video = this.video
		const playback = this.playback

		if (target === null || video === null) {
			return
		}

		if (playback === null || target.parts.length > 1) {
			void this.open({ target, start: "start", autoplay: true })

			return
		}

		this.finished = false
		this.lastReported = null
		this.update({ resumedAt: null, epoch: this.snapshot.epoch + 1 })
		video.currentTime = playback.firstTime()
		this.playWhenReady(this.generation)
	}

	public async selectAudio(index: number): Promise<void> {
		const playback = this.playback
		const target = this.snapshot.target

		if (playback === null || target === null || index === this.snapshot.audioIndex) {
			return
		}

		const lang = this.snapshot.probe?.audio[index]?.lang ?? null

		this.chosenAudio = { key: target.key, part: this.snapshot.part, index, lang }
		// Whether a remux plays the file whole depends on the audio track: another one is asked about afresh.
		this.update({ audioIndex: index, embeddedTextBlocked: false })
		await playback.selectAudio(index)

		if (target.seriesDirUuid !== null && lang !== null) {
			void watchState.setSeriesLanguages({ seriesDirUuid: target.seriesDirUuid, audio: lang })
		}
	}

	// Ends playback of the current item (reported as stopped) and leaves the element empty.
	public stop(): void {
		this.generation++
		this.stopCurrent()
		this.update({ ...IDLE, epoch: this.snapshot.epoch + 1, embeddedVersion: this.snapshot.embeddedVersion + 1 })
	}

	public dispose(): void {
		this.stop()
		this.detachElement()
		this.video = null
		this.onEnded = null
		this.changes.clear()
	}

	// The watch item being played, in watch-state terms.
	public watchItem(): WatchItem | null {
		const target = this.snapshot.target
		const first = this.files[0]

		if (target === null || first === undefined) {
			return null
		}

		return {
			stableUuid: target.key,
			uuid: first.uuid,
			size: Number(first.size),
			itemClass: target.itemClass,
			...(target.parts.length > 1 ? { part: this.snapshot.part } : {})
		}
	}

	private async awaitWatchState(): Promise<void> {
		const wait: { timer: ReturnType<typeof setTimeout> | null } = { timer: null }

		await Promise.race([
			watchState.open().catch((error: unknown) => {
				log.warn("videos.player", "watch state not opened", error)
			}),
			new Promise<void>(resolve => {
				wait.timer = setTimeout(resolve, WATCH_STATE_WAIT_MS)
			})
		])

		if (wait.timer !== null) {
			clearTimeout(wait.timer)
		}
	}

	// The element's position as the item's progress, when the element is really playing this item; else what was
	// last reported.
	private currentProgress(): { pos: number; dur: number } | null {
		const video = this.video

		if (video !== null && this.playing() && video.readyState >= video.HAVE_METADATA && Number.isFinite(video.duration)) {
			const progress = stackProgress(this.snapshot.partDurations, this.snapshot.part, video.currentTime, video.duration)

			return { pos: progress.pos, dur: progress.dur }
		}

		return this.lastReported === null ? null : { pos: this.lastReported.pos, dur: this.lastReported.dur }
	}

	// The current session plays (not opening, restarting, reconnecting or failed).
	private playing(): boolean {
		return this.snapshot.phase === "ready" && this.playback?.getSnapshot().status === "ready"
	}

	private record(key: string): ItemRec | undefined {
		return watchState.getSnapshot().doc.items[itemKey(key)]
	}

	// Durations of a stack's parts (the card tier answers them; usually cached already). One part needs none.
	private async partDurations(generation: number): Promise<(number | null)[]> {
		if (this.files.length <= 1) {
			return [null]
		}

		const records = await Promise.all(
			this.files.map(file => probeService.request({ uuid: file.uuid, file }, "card", { rank: () => PROBE_RANK.explicit }))
		)
		const durations = records.map(record => record?.probe?.durationSec ?? null)

		if (generation === this.generation) {
			this.update({ partDurations: durations })
		}

		return durations
	}

	private async openPart(
		generation: number,
		target: WatchItemTarget,
		part: number,
		position: number,
		autoplay: boolean,
		resumedAt: number | null,
		partDurations: readonly (number | null)[]
	): Promise<void> {
		const video = this.video
		const file = this.files[part]

		if (video === null || file === undefined) {
			return
		}

		const record = await probeService.request({ uuid: file.uuid, file }, "full", { rank: () => PROBE_RANK.explicit })

		if (generation !== this.generation) {
			return
		}

		const probe = record?.probe ?? null

		if (probe === null) {
			this.update({ phase: "probeFailed", part })

			return
		}

		const series = target.seriesDirUuid === null ? undefined : watchState.getSnapshot().doc.series[seriesKey(target.seriesDirUuid)]
		const picked = this.pickedAudio
		const chosen = this.chosenAudio?.key === target.key ? this.chosenAudio : null

		this.pickedAudio = null

		// The pick made before opening, else the user's choice on this part, else the automatic one (another part of a
		// stack may order its tracks differently: it goes by the chosen track's language).
		let audioIndex: number

		if (picked !== null && picked >= 0 && picked < probe.audio.length) {
			audioIndex = picked
			this.chosenAudio = { key: target.key, part, index: picked, lang: probe.audio[picked]?.lang ?? null }
		} else if (chosen !== null && chosen.part === part && chosen.index < probe.audio.length) {
			audioIndex = chosen.index
		} else {
			audioIndex = defaultAudioIndex({
				probe,
				rememberedLang: chosen?.lang ?? series?.al?.v ?? null,
				userLanguages: userLanguages()
			})
		}

		this.offeredTracks = new Set(probe.subs.map(sub => sub.id))
		this.update({
			probe,
			part,
			audioIndex,
			resumedAt,
			partDurations,
			autoplayBlocked: false,
			// What another part's playback found says nothing about this one.
			embeddedTextBlocked: part === this.snapshot.part && this.snapshot.embeddedTextBlocked
		})

		const subtitleKind = this.subtitleKind
		let playback: Playback

		try {
			playback = await openPlayback(
				video,
				file,
				probe,
				{ audioIndex, subtitle: subtitleKind },
				{
					name: target.parts[part]?.file.name ?? "",
					startTime: position,
					autoplay: false,
					onTextCues: cues => {
						if (generation === this.generation) {
							this.addTextCues(cues)
						}
					}
				}
			)
		} catch (error) {
			log.warn("videos.player", "opening playback failed", error)

			if (generation === this.generation) {
				this.update({ phase: "failed" })
			}

			return
		}

		if (generation !== this.generation) {
			playback.dispose()

			return
		}

		// An embedded text track chosen while it opened (its tracks show only once the probe is in the snapshot) needs
		// the remux rung a direct stream lacks, when that rung plays the file whole.
		if (
			this.subtitleKind === "embedded-text" &&
			subtitleKind !== "embedded-text" &&
			playback.getSnapshot().decision.path === "direct"
		) {
			const reachable = await this.embeddedReachable(file, probe, audioIndex)

			if (generation !== this.generation || reachable) {
				playback.dispose()

				if (generation === this.generation) {
					await this.openPart(generation, target, part, position, autoplay, resumedAt, partDurations)
				}

				return
			}

			this.update({ embeddedTextBlocked: true })
		}

		this.playback = playback
		this.unsubscribePlayback = playback.subscribe(() => {
			this.syncPlayback()
		})
		this.syncPlayback()

		if (autoplay) {
			this.playWhenReady(generation)
		}
	}

	// play() once the element has metadata; a refusal (no user activation) is reported, never retried.
	private playWhenReady(generation: number): void {
		const video = this.video

		if (video === null) {
			return
		}

		const start = (): void => {
			if (generation !== this.generation) {
				return
			}

			video.play().then(
				() => {
					if (generation === this.generation && this.snapshot.autoplayBlocked) {
						this.update({ autoplayBlocked: false })
					}
				},
				(error: unknown) => {
					if (generation === this.generation && error instanceof DOMException && error.name === "NotAllowedError") {
						this.update({ autoplayBlocked: true })
					}
				}
			)
		}

		if (video.readyState >= video.HAVE_METADATA) {
			start()
		} else {
			video.addEventListener("loadedmetadata", start, { once: true })
		}
	}

	// Cues of the tracks the probe offers are kept (EmbeddedCues bounds them); only cues of the shown track re-render.
	private addTextCues(cues: readonly RemuxTextCue[]): void {
		const grown = this.embedded.add(cues, this.offered)

		if (this.shownEmbedded !== null && grown.has(this.shownEmbedded)) {
			this.update({ embeddedVersion: this.snapshot.embeddedVersion + 1 })
		}
	}

	private syncPlayback(): void {
		const playback = this.playback

		if (playback === null) {
			return
		}

		const state = playback.getSnapshot()
		const phase: PlayerPhase =
			state.status === "unsupported"
				? "unsupported"
				: state.status === "failed"
					? "failed"
					: state.status === "opening"
						? "loading"
						: "ready"

		this.update({
			playback: state,
			phase,
			audioIndex: state.selection.audioIndex,
			embeddedTextBlocked: this.snapshot.embeddedTextBlocked || state.decision.reasons.includes("subtitle-embedded-unavailable")
		})
	}

	// Never reports a position the element doesn't really hold: while opening or restarting it reads 0.
	private report(stateChanged: boolean): void {
		const video = this.video
		const item = this.watchItem()
		const target = this.snapshot.target

		if (
			video === null ||
			item === null ||
			target === null ||
			this.finished ||
			!this.playing() ||
			video.readyState < video.HAVE_METADATA ||
			video.seeking
		) {
			return
		}

		this.lastPosition = { key: target.key, part: this.snapshot.part, time: video.currentTime }

		if (this.autoRetries > 0) {
			if (this.playedFrom === null) {
				this.playedFrom = video.currentTime
			} else if (Math.abs(video.currentTime - this.playedFrom) >= AUTO_RETRY_RESET_SECONDS) {
				this.autoRetries = 0
			}
		}

		if (!stateChanged && video.paused) {
			return
		}

		const partDuration = Number.isFinite(video.duration) ? video.duration : 0
		const progress = stackProgress(this.snapshot.partDurations, this.snapshot.part, video.currentTime, partDuration)

		this.lastReported = { item, pos: progress.pos, dur: progress.dur }
		watchState.reportProgress({ item, pos: progress.pos, dur: progress.dur, playing: !video.paused && !video.ended })
	}

	private handleEnded(): void {
		const target = this.snapshot.target
		const item = this.watchItem()
		const video = this.video

		if (target === null || item === null || video === null) {
			return
		}

		const nextPart = this.snapshot.part + 1

		if (nextPart < target.parts.length) {
			void this.open({ target, start: "resume", autoplay: true }, { part: nextPart, position: 0 })

			return
		}

		const progress = stackProgress(this.snapshot.partDurations, this.snapshot.part, video.currentTime, video.duration)

		if (!this.finished) {
			this.finished = true
			void watchState.reportStop({ item, pos: progress.pos, dur: progress.dur, ended: true })
		}

		this.lastReported = null
		this.onEnded?.()
	}

	// The frame on screen as the item's still (zero reads), once per pause.
	private captureStill(): void {
		const video = this.video
		const first = this.files[0]

		if (video === null || first === undefined || this.captureDone || video.ended || this.snapshot.phase !== "ready") {
			return
		}

		const duration = video.duration

		if (
			video.currentTime < CAPTURE_MIN_POSITION_SECONDS ||
			(Number.isFinite(duration) && video.currentTime > duration * CAPTURE_END_FRACTION)
		) {
			return
		}

		this.captureDone = true
		void captureFrameFromVideo(video, "s")
			.then(frame => (frame === null ? undefined : storeCapturedFrame(first.uuid, "s", frame)))
			.catch((error: unknown) => {
				log.warn("videos.player", "still capture failed", error)
			})
	}

	// Ends the item in the watch state whatever the state of the session (a stop at the last real position, or a
	// drop when it never had one), keeps a still, and lets go of the stream.
	private stopCurrent(): void {
		const item = this.watchItem() ?? this.lastReported?.item ?? null
		const progress = this.currentProgress()

		if (item !== null && !this.finished) {
			if (progress !== null && (this.lastReported !== null || this.playing())) {
				this.captureStill()
				void watchState.reportStop({ item, pos: progress.pos, dur: progress.dur })
			} else {
				watchState.dropPlayback({ stableUuid: item.stableUuid })
			}
		}

		this.lastReported = null
		this.finished = false
		this.unsubscribePlayback?.()
		this.unsubscribePlayback = null
		this.playback?.dispose()
		this.playback = null
	}

	private detachElement(): void {
		const video = this.video

		if (video !== null) {
			for (const [type, listener] of this.elementListeners) {
				video.removeEventListener(type, listener)
			}
		}

		this.elementListeners.length = 0
	}

	private update(patch: Partial<PlayerSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch }
		this.changes.emit()
	}
}
