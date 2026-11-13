import type { AnyFile } from "@filen/sdk-rs"
import type { LadderDecision, LadderProbe, LadderSelection, PlaybackCapabilities, VideoProbe } from "@filen/shared/videos"
import {
	decideWithDemotions,
	demote,
	demotionSignature,
	isLearnedTrigger,
	isPathWide,
	isTerminalTrigger,
	pathWideKey,
	streamFacts,
	toLadderProbe,
	withoutDirect
} from "@/lib/media/playback/capabilities.logic"
import {
	playbackCapabilities,
	playbackEnvironment,
	type PlaybackCapabilityProbe,
	type PlaybackEnvironment
} from "@/lib/media/playback/capabilities"
import { watchForDemotion, type DemotionWatch } from "@/lib/media/playback/demotionWatch"
import { openDirectSession, type DirectSource } from "@/lib/media/playback/directSession"
import { audioTrackId, samePipeline, sessionPlan, type SessionPlan } from "@/lib/media/playback/openPlayback.logic"
import { captureFramePoster } from "@/lib/media/playback/poster"
import { openRemuxPlaybackSession, type RemuxSource } from "@/lib/media/playback/remuxSession"
import { directSource, remuxSource } from "@/lib/media/playback/sources"
import type { PlaybackFailure, PlaybackSession, PlaybackTrigger, SessionAudio } from "@/lib/media/playback/types"
import type { RemuxTextCue } from "@/lib/media/remuxTypes"
import { isMediaStreamAvailable } from "@/features/preview/lib/previewStream"
import { fnv1a } from "@/lib/fnv1a"
import { log } from "@/lib/log"

// Plays a file through the playback ladder: probe the browser, pick the rung (direct service worker
// stream, remux, remux with audio re-encoded, video alone), and when the rung turns out not to play at
// runtime, keep the frame on screen and go on from the same position one rung down. A failure is
// remembered for this browser build only once the rung below has played the same file, and skipped up
// front only once it has happened on two different files: one broken file never bans a codec.

// "opening": the current rung is loading. "reconnecting": a direct stream is being re-established.
// "restarting": the session is being replaced (the rung failed, or an audio change needs another
// pipeline), the current frame shown meanwhile. "failed": nothing plays (see
// `failure`). "unsupported": the ladder has no rung for this file in this browser (see the decision's reasons).
export type PlaybackStatus = "opening" | "ready" | "reconnecting" | "restarting" | "failed" | "unsupported"

export interface PlaybackSnapshot {
	status: PlaybackStatus
	decision: LadderDecision
	selection: LadderSelection
	failure: PlaybackFailure | null
	// Rungs given up on at runtime during this playback.
	demotions: number
}

export interface Playback {
	getSnapshot(): PlaybackSnapshot
	subscribe(listener: () => void): () => void
	// Index into the probe's audio list, -1 for none.
	selectAudio(audioIndex: number): Promise<void>
	dispose(): void
}

export interface PlaybackDeps {
	capabilities: Pick<PlaybackCapabilityProbe, "capabilities" | "learned" | "learn">
	environment(): Pick<PlaybackEnvironment, "browser" | "frameCallback">
	// A service worker controls the page: without one there is no direct stream.
	directAvailable(): boolean
	directSource(params: { file: AnyFile; name: string; contentType: string }): DirectSource
	remuxSource(file: AnyFile): RemuxSource
	capturePoster(video: HTMLVideoElement): Promise<string | null>
	now(): number
}

export interface OpenPlaybackOptions {
	// The file's name, which the service worker's route is registered with.
	name: string
	// Where playback starts (a resume position), seconds.
	startTime?: number
	autoplay?: boolean
	// Embedded text subtitle cues (Matroska) as a remux reads them; a direct stream yields none.
	onTextCues?: (cues: RemuxTextCue[]) => void
	deps?: Partial<PlaybackDeps>
}

const DEFAULT_DEPS: PlaybackDeps = {
	capabilities: playbackCapabilities,
	environment: playbackEnvironment,
	directAvailable: isMediaStreamAvailable,
	directSource,
	remuxSource,
	capturePoster: captureFramePoster,
	now: () => performance.now()
}

// Every rung below the first, at most once each.
const MAX_DEMOTIONS = 4
// A remux source lost again within this long after reopening it is given up on.
const REOPEN_COOLDOWN_MS = 60_000

export async function openPlayback(
	video: HTMLVideoElement,
	file: AnyFile,
	probe: VideoProbe,
	selection: LadderSelection,
	options: OpenPlaybackOptions
): Promise<Playback> {
	const deps = { ...DEFAULT_DEPS, ...options.deps }
	const playback = new LadderPlayback({ video, file, probe, selection, options, deps })

	await playback.open(options.startTime ?? 0, options.autoplay === true)

	return playback
}

// A demotion waiting to be learned: it is a verdict on the browser only once a lower rung has played the
// same file.
interface PendingDemotion {
	sig: string
	trigger: PlaybackTrigger
	learnable: boolean
}

class LadderPlayback implements Playback {
	private readonly video: HTMLVideoElement
	private readonly file: AnyFile
	private readonly probe: VideoProbe
	private readonly ladderProbe: LadderProbe
	private readonly name: string
	private readonly onTextCues: ((cues: RemuxTextCue[]) => void) | undefined
	private readonly deps: PlaybackDeps
	private readonly fileKey: string
	private readonly listeners = new Set<() => void>()
	private readonly elementListeners: [string, () => void][] = []
	// What failed during this playback, applied again whenever the ladder decides anew (an audio change).
	private readonly sessionDemotions = new Map<string, { reason: PlaybackTrigger }>()
	private pendingDemotions: PendingDemotion[] = []
	private selection: LadderSelection
	private caps: PlaybackCapabilities | null = null
	private snapshot: PlaybackSnapshot
	private plan: SessionPlan = { kind: "none" }
	private session: PlaybackSession | null = null
	private watch: DemotionWatch | null = null
	// Restarts, failures and audio changes run one at a time, in order.
	private timeline: Promise<void> = Promise.resolve()
	// Whether the user wants playback running, which a restart's own pause does not change.
	private playIntent: boolean
	// Set from a restart until the new session is attached: the emptied element's pause is not the user's.
	private restarting = false
	// Where the current session started, which is where it still is until it has metadata.
	private startTime = 0
	private lastReopenAt: number | null = null
	// The poster bridging a restart, and the element's own poster to put back after it.
	private bridgePoster: string | null = null
	private ownPoster: string | null = null
	private readyListener: (() => void) | null = null
	private disposed = false

	public constructor(params: {
		video: HTMLVideoElement
		file: AnyFile
		probe: VideoProbe
		selection: LadderSelection
		options: OpenPlaybackOptions
		deps: PlaybackDeps
	}) {
		this.video = params.video
		this.file = params.file
		this.probe = params.probe
		this.ladderProbe = toLadderProbe(params.probe)
		this.name = params.options.name
		this.onTextCues = params.options.onTextCues
		this.deps = params.deps
		this.fileKey = fnv1a(params.file.uuid).toString(36)
		this.selection = params.selection
		this.playIntent = params.options.autoplay === true
		this.snapshot = {
			status: "opening",
			decision: { path: "unsupported", reasons: [], audio: { mode: "none" } },
			selection: params.selection,
			failure: null,
			demotions: 0
		}

		this.listen("play", () => {
			if (!this.restarting) {
				this.playIntent = true
			}
		})
		this.listen("pause", () => {
			if (!this.restarting) {
				this.playIntent = false
			}
		})
	}

	public getSnapshot(): PlaybackSnapshot {
		return this.snapshot
	}

	public subscribe(listener: () => void): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	public async open(time: number, play: boolean): Promise<void> {
		const decided = await this.decide(this.selection)

		if (this.isDisposed()) {
			return
		}

		this.caps = decided.caps
		this.snapshot = { ...this.snapshot, decision: decided.decision }
		this.start(time, play)
	}

	public selectAudio(audioIndex: number): Promise<void> {
		return this.enqueue(() => this.switchAudio(audioIndex))
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
		this.stopSession()

		for (const [type, listener] of this.elementListeners) {
			this.video.removeEventListener(type, listener)
		}

		this.clearBridgePoster()
		this.listeners.clear()
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const next = this.timeline.then(operation)

		this.timeline = next.catch(() => undefined)

		return next
	}

	// The ladder's decision for `selection` with what this browser build is known not to play, and what
	// failed during this playback, taken away.
	private async decide(selection: LadderSelection): Promise<{ decision: LadderDecision; caps: PlaybackCapabilities }> {
		const [probed, learned] = await Promise.all([
			this.deps.capabilities.capabilities(
				this.ladderProbe,
				selection,
				streamFacts({ probe: this.probe, selection, size: Number(this.file.size) })
			),
			this.deps.capabilities.learned()
		])
		const caps = this.deps.directAvailable() ? probed : withoutDirect(probed)

		return decideWithDemotions({ probe: this.ladderProbe, selection, caps, learned: new Map([...learned, ...this.sessionDemotions]) })
	}

	private async switchAudio(audioIndex: number): Promise<void> {
		if (this.disposed || audioIndex === this.selection.audioIndex) {
			return
		}

		const selection: LadderSelection = { ...this.selection, audioIndex }
		const decided = await this.decide(selection)

		if (this.isDisposed()) {
			return
		}

		const plan = this.planFor(decided.decision, selection)
		const session = this.session
		const audio = plan.kind === "remux" ? plan.audio : plan.kind === "direct" ? this.directAudio(audioIndex) : null

		if (session !== null && audio !== null && samePipeline(this.plan, plan) && (await session.selectAudio(audio))) {
			// Superseded meanwhile (a failure replaced the session): what it switched no longer plays.
			if (this.isDisposed() || session !== this.session) {
				return
			}

			this.selection = selection
			this.caps = decided.caps
			this.plan = plan
			this.update({ decision: decided.decision, selection })

			return
		}

		if (this.isDisposed()) {
			return
		}

		this.selection = selection
		this.caps = decided.caps
		await this.restart({ decision: decided.decision, status: "restarting" })
	}

	// Starts the current decision's session at `time`.
	private start(time: number, play: boolean): void {
		const decision = this.snapshot.decision
		const plan = this.planFor(decision, this.selection)

		this.plan = plan
		this.startTime = time

		if (plan.kind === "none") {
			this.restarting = false
			this.clearBridgePoster()
			this.update({ status: "unsupported" })

			return
		}

		const env = this.deps.environment()
		let session: PlaybackSession | null = null
		const current = () => session !== null && session === this.session && !this.disposed
		const callbacks = {
			onFailure: (failure: PlaybackFailure) => {
				if (current()) {
					void this.enqueue(() => (current() ? this.onFailure(failure) : Promise.resolve()))
				}
			},
			onReconnecting: (reconnecting: boolean) => {
				if (!current()) {
					return
				}

				if (reconnecting) {
					this.watch?.suspend()
				} else {
					this.watch?.restart()
				}

				this.update({ status: reconnecting ? "reconnecting" : "ready" })
			}
		}

		session =
			plan.kind === "direct"
				? openDirectSession({
						source: this.deps.directSource({ file: this.file, name: this.name, contentType: plan.contentType }),
						startTime: time,
						audioIndex: plan.audioIndex,
						callbacks
					})
				: openRemuxPlaybackSession({
						path: plan.path,
						source: this.deps.remuxSource(this.file),
						size: Number(this.file.size),
						index: this.probe.index,
						startTime: time,
						audio: plan.audio,
						idrOnlyStart: plan.idrOnlyStart,
						callbacks,
						onTextCues: this.onTextCues
					})
		this.session = session
		this.watch = watchForDemotion(
			this.video,
			{ metadataTimeout: plan.kind === "direct", frameCallback: env.frameCallback, expectAudio: decision.audio.mode !== "none" },
			(trigger, trusted) => {
				callbacks.onFailure({ trigger, detail: "watchdog", learnable: trusted })
			},
			() => {
				if (current()) {
					this.confirmDemotions()
				}
			}
		)
		this.awaitReady()

		if (this.snapshot.status !== "reconnecting") {
			this.update({ status: "opening" })
		}

		session.attach(this.video).then(
			() => {
				if (!current()) {
					return
				}

				this.restarting = false

				if (play) {
					this.playIntent = true
					void this.video.play().catch(() => undefined)
				}
			},
			(error: unknown) => {
				this.restarting = false
				callbacks.onFailure({ trigger: "stream-unavailable", detail: error instanceof Error ? error.message : String(error) })
			}
		)
	}

	// A lower rung played the file: a single rung that failed before it is this browser's, worth
	// remembering. Several failed rungs say the file is at fault; the rung without audio says nothing
	// about any audio codec.
	private confirmDemotions(): void {
		const pending = this.pendingDemotions

		this.pendingDemotions = []

		const only = pending.length === 1 ? pending[0] : undefined

		if (only !== undefined && only.learnable && !only.sig.startsWith("video-only|")) {
			void this.deps.capabilities.learn(only.sig, only.trigger, this.fileKey)
		}
	}

	private planFor(decision: LadderDecision, selection: LadderSelection): SessionPlan {
		return sessionPlan({ decision, probe: this.probe, selection, browser: this.deps.environment().browser })
	}

	private directAudio(audioIndex: number): SessionAudio | null {
		const track = this.probe.audio[audioIndex]

		return track === undefined ? null : { index: audioIndex, trackId: audioTrackId(audioIndex), mode: "copy" }
	}

	private listen(type: string, listener: () => void): void {
		this.video.addEventListener(type, listener)
		this.elementListeners.push([type, listener])
	}

	// The current session's first canplay: it plays, and the frame bridging the restart can go.
	private awaitReady(): void {
		this.clearReadyListener()

		const listener = () => {
			this.clearReadyListener()
			this.clearBridgePoster()

			if (this.snapshot.status === "opening" || this.snapshot.status === "reconnecting") {
				this.update({ status: "ready" })
			}
		}

		this.readyListener = listener
		this.video.addEventListener("canplay", listener)
	}

	private clearReadyListener(): void {
		if (this.readyListener !== null) {
			this.video.removeEventListener("canplay", this.readyListener)
			this.readyListener = null
		}
	}

	private async onFailure(failure: PlaybackFailure): Promise<void> {
		const caps = this.caps

		if (this.disposed || caps === null) {
			return
		}

		const decision = this.snapshot.decision

		log.warn("playback", `${decision.path} failed: ${failure.trigger} (${failure.detail})`)

		// A remux source lost under a live session (the SDK worker restarted, a download failed): opened
		// again at the same position, once a minute at most.
		if (failure.trigger === "network" && this.plan.kind === "remux") {
			const now = this.deps.now()

			if (this.lastReopenAt === null || now - this.lastReopenAt >= REOPEN_COOLDOWN_MS) {
				this.lastReopenAt = now
				await this.restart({ decision, status: "reconnecting" })

				return
			}
		}

		if (isTerminalTrigger(failure.trigger) || this.snapshot.demotions >= MAX_DEMOTIONS) {
			this.stopSession()
			this.update({ status: "failed", failure })

			return
		}

		const next = demote({ caps, probe: this.ladderProbe, selection: this.selection, decision, trigger: failure.trigger })
		const sig = demotionSignature({ path: decision.path, probe: this.ladderProbe, selection: this.selection })

		this.sessionDemotions.set(sig, { reason: failure.trigger })

		if (isPathWide(decision.path, failure.trigger)) {
			this.sessionDemotions.set(pathWideKey(decision.path), { reason: failure.trigger })
		}

		this.pendingDemotions.push({
			sig,
			trigger: failure.trigger,
			learnable: failure.learnable !== false && isLearnedTrigger(failure.trigger)
		})

		if (next === null) {
			this.stopSession()
			this.update({ status: "failed", failure })

			return
		}

		this.caps = next.caps
		await this.restart({ decision: next.decision, status: "restarting", failure })
	}

	// Ends the current session and starts `decision`'s at the same position and play state, with the current
	// frame as the poster meanwhile.
	private async restart(params: {
		decision: LadderDecision
		status: "restarting" | "reconnecting"
		failure?: PlaybackFailure
	}): Promise<void> {
		const time = this.video.readyState >= this.video.HAVE_METADATA ? this.video.currentTime : this.startTime
		const play = this.playIntent
		const demoted = params.failure !== undefined

		this.restarting = true
		this.update({ status: params.status })

		const poster = await this.deps.capturePoster(this.video)

		if (this.isDisposed()) {
			if (poster !== null) {
				URL.revokeObjectURL(poster)
			}

			return
		}

		if (poster !== null) {
			this.clearBridgePoster()
			this.ownPoster = this.video.getAttribute("poster")
			this.bridgePoster = poster
			this.video.poster = poster
		}

		this.stopSession()
		this.update({
			decision: params.decision,
			selection: this.selection,
			...(demoted ? { failure: params.failure, demotions: this.snapshot.demotions + 1 } : {})
		})
		this.start(time, play)
	}
	private stopSession(): void {
		this.clearReadyListener()
		this.watch?.dispose()
		this.watch = null
		this.session?.dispose()
		this.session = null
	}

	private clearBridgePoster(): void {
		if (this.bridgePoster === null) {
			return
		}

		URL.revokeObjectURL(this.bridgePoster)
		this.bridgePoster = null

		if (this.ownPoster === null) {
			this.video.removeAttribute("poster")
		} else {
			this.video.setAttribute("poster", this.ownPoster)
		}

		this.ownPoster = null
	}

	private update(patch: Partial<PlaybackSnapshot>): void {
		if (this.disposed) {
			return
		}

		this.snapshot = { ...this.snapshot, ...patch }

		for (const listener of this.listeners) {
			listener()
		}
	}
}
