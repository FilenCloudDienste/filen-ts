import { type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"
import { useAudioStore } from "@/features/audio/store/useAudioStore"
import {
	buildShuffleOrder,
	computeNext,
	reconcileVisibility,
	removeFromQueue,
	replaceQueueAtIndex,
	smartPrevious,
	withinSkipBudget,
	type AdvanceResult,
	type ElementSample,
	type LoopMode,
	type QueueNav,
	type QueueTrack
} from "@/features/audio/store/audioQueue"
import type { MediaSessionPublisher } from "@/features/audio/lib/mediaSession"

// The module-level playback engine — a singleton lib (constructed in audioEngine.ts with the real DOM
// adapter + SW/blob source resolver), NOT a React component, mirroring sdkApi and the mobile Audio
// class. It owns exactly one media element for the app's life and drives the zustand store; the store
// drives the UI. All element interaction goes through an injected adapter so the whole engine is
// unit-testable in node, where an <audio> element cannot be constructed — the real adapter is exercised
// live on-device instead.

// Position writes to the store are throttled to a sane cadence — a media element fires `timeupdate`
// several times a second, and a scrubber does not need more than ~4Hz. End-detection rides the `ended`
// event, never this throttle, so a coarser cadence costs nothing.
const POSITION_WRITE_THROTTLE_MS = 250

// Volume/muted persist separately from the queue prefs: they are output-device settings the engine
// owns (desktop needs an in-app volume), not queue state. Same per-tab kv rationale as the queue prefs.
const OUTPUT_PREFS_KV_KEY = "audio.v1.output"

export const audioOutputPrefsSchema = type({ volume: "number", muted: "boolean" })

// The event callbacks the engine hands to the adapter factory; the adapter wires them to the concrete
// element's listeners (or, in a test, exposes them so the harness can fire them).
export interface AudioElementEvents {
	onTimeUpdate: () => void
	onDurationChange: () => void
	onEnded: () => void
	onError: () => void
}

// The thin seam over a media element. Everything the engine needs and nothing more, so a fake is
// trivial. Times are ms (via `sample`).
export interface AudioElementAdapter {
	load: (src: string) => void
	play: () => Promise<void>
	pause: () => void
	seek: (seconds: number) => void
	clear: () => void
	setVolume: (volume: number) => void
	setMuted: (muted: boolean) => void
	sample: () => ElementSample
	dispose: () => void
}

export type AudioElementFactory = (events: AudioElementEvents) => AudioElementAdapter

// A resolved playable source. A "blob" url is an object URL the engine owns and must revoke on the next
// track switch / dispose; a "stream" url is an SW-served route that needs no page-side cleanup.
export type TrackSource = { kind: "stream"; url: string } | { kind: "blob"; url: string }

export interface AudioEngineDeps {
	createElement: AudioElementFactory
	resolveSource: (track: QueueTrack) => Promise<TrackSource>
	// Injectable purely so tests can spy on blob revocation; production uses URL.revokeObjectURL.
	revokeObjectUrl?: (url: string) => void
	// Injectable clock for the position throttle, so a test can drive it deterministically.
	now?: () => number
	// The OS Media Session bridge (engine → lock-screen/media-key metadata + playback state). Absent in
	// tests and wherever Media Session is unsupported; every call site guards on it, so a missing bridge
	// simply means no OS integration.
	mediaSession?: MediaSessionPublisher
}

function defaultRevoke(url: string): void {
	if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
		URL.revokeObjectURL(url)
	}
}

function clampVolume(volume: number): number {
	if (!Number.isFinite(volume)) {
		return 1
	}

	return Math.max(0, Math.min(1, volume))
}

export class AudioEngine {
	private readonly deps: AudioEngineDeps
	private element: AudioElementAdapter | null = null
	// The object URL of the currently-loaded blob source, if any — revoked on switch/dispose.
	private currentBlobUrl: string | null = null
	// Bumped on every load attempt so an older in-flight resolve/play can detect it was superseded and
	// bail (the user skipped, the queue was replaced, dispose ran) rather than stomping newer state.
	private loadGeneration = 0
	// Consecutive failed-track auto-skips; reset to 0 on any successful play. Bounds the auto-skip pass.
	private skipGuard = 0
	private lastPositionWriteAt = 0
	private volume = 1
	private muted = false
	private outputLoad: Promise<void> | null = null
	private visibilityHandler: (() => void) | null = null

	public constructor(deps: AudioEngineDeps) {
		this.deps = deps
	}

	private now(): number {
		return (this.deps.now ?? Date.now)()
	}

	private revoke(url: string): void {
		;(this.deps.revokeObjectUrl ?? defaultRevoke)(url)
	}

	private nav(): QueueNav {
		const state = useAudioStore.getState()

		return {
			queueLength: state.queue.length,
			currentIndex: state.currentIndex,
			shuffleEnabled: state.shuffleEnabled,
			shuffleOrder: state.shuffleOrder,
			loopMode: state.loopMode
		}
	}

	private ensureElement(): AudioElementAdapter {
		if (this.element) {
			return this.element
		}

		const element = this.deps.createElement({
			onTimeUpdate: () => {
				this.onTimeUpdate()
			},
			onDurationChange: () => {
				this.onDurationChange()
			},
			onEnded: () => {
				void this.handleTrackEnd()
			},
			onError: () => {
				this.onPlaybackFailure(asErrorDTO(new Error("audio element playback error")))
			}
		})

		// Re-apply the persisted output prefs to a freshly-created element.
		element.setVolume(this.volume)
		element.setMuted(this.muted)
		this.element = element

		return element
	}

	private onTimeUpdate(): void {
		if (!this.element) {
			return
		}

		const now = this.now()

		if (now - this.lastPositionWriteAt < POSITION_WRITE_THROTTLE_MS) {
			return
		}

		this.lastPositionWriteAt = now

		const sample = this.element.sample()

		useAudioStore.getState().setPosition(Math.max(0, sample.currentTimeMs))
		this.deps.mediaSession?.setPositionState(sample)
	}

	private onDurationChange(): void {
		if (!this.element) {
			return
		}

		const durationMs = this.element.sample().durationMs

		useAudioStore.getState().setDuration(Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0)
	}

	// Move to `index` and start it. The single load path: resolve a source (SW stream or whole-buffer
	// blob), swap the element's src, play. Every await re-checks the generation so a superseding
	// load/skip/dispose bails cleanly; a source resolved for a superseded load still has its blob URL
	// freed. A resolve error or a rejected play() routes into the bounded auto-skip.
	private async loadAndPlay(index: number): Promise<void> {
		const generation = ++this.loadGeneration
		const track = useAudioStore.getState().queue[index]

		if (!track) {
			return
		}

		// Publish OS metadata as soon as the track is known (before bytes resolve) so the lock-screen /
		// media-key surface names the loading track rather than lagging a beat behind.
		this.deps.mediaSession?.setMetadata(track)
		useAudioStore.getState().setStatus("loading")

		let source: TrackSource

		try {
			source = await this.deps.resolveSource(track)
		} catch (error) {
			if (generation !== this.loadGeneration) {
				return
			}

			this.onPlaybackFailure(asErrorDTO(error))

			return
		}

		if (generation !== this.loadGeneration) {
			if (source.kind === "blob") {
				this.revoke(source.url)
			}

			return
		}

		const element = this.ensureElement()

		this.swapBlobUrl(source)
		element.load(source.url)

		try {
			await element.play()
		} catch (error) {
			if (generation !== this.loadGeneration) {
				return
			}

			this.onPlaybackFailure(asErrorDTO(error))

			return
		}

		if (generation !== this.loadGeneration) {
			return
		}

		this.skipGuard = 0
		this.lastPositionWriteAt = 0
		useAudioStore.getState().setError(null)
		useAudioStore.getState().setStatus("playing")
		this.deps.mediaSession?.setPlaybackState("playing")
		this.deps.mediaSession?.setPositionState(element.sample())
	}

	// Revoke the outgoing blob URL when it is being replaced, and remember the new one (or null for a
	// stream source, which needs no cleanup).
	private swapBlobUrl(source: TrackSource): void {
		const nextBlobUrl = source.kind === "blob" ? source.url : null

		if (this.currentBlobUrl !== null && this.currentBlobUrl !== nextBlobUrl) {
			this.revoke(this.currentBlobUrl)
		}

		this.currentBlobUrl = nextBlobUrl
	}

	// A track failed to load or play. Surface it LABEL-FIRST, then bounded auto-skip: increment the
	// guard, and once a full pass over the queue is exhausted settle instead of spinning. Otherwise
	// advance to the next track and try it.
	private onPlaybackFailure(error: ErrorDTO): void {
		useAudioStore.getState().setError(error)
		this.skipGuard += 1

		if (!withinSkipBudget(this.skipGuard, useAudioStore.getState().queue.length)) {
			this.settleStopped()

			return
		}

		const advance = computeNext(this.nav())

		if (advance === null) {
			this.settleStopped()

			return
		}

		this.applyAdvance(advance)
		void this.loadAndPlay(advance.index)
	}

	private applyAdvance(advance: AdvanceResult): void {
		useAudioStore.getState().setCurrent(advance.index, advance.shuffleOrder)
	}

	// End of the road: supersede any in-flight load, stop the element, and settle to a non-spinning
	// terminal status (idle when the queue is empty, otherwise paused at the start). Any lastError set
	// by the failure path stays visible.
	private settleStopped(): void {
		this.loadGeneration++
		this.element?.pause()

		const state = useAudioStore.getState()

		state.setStatus(state.queue.length === 0 ? "idle" : "paused")
		state.setPosition(0)
		this.deps.mediaSession?.setPlaybackState(state.queue.length === 0 ? "none" : "paused")
	}

	// The `ended` handler. Loop "one" restarts the current track; otherwise advance, and if there is
	// nowhere to advance (queue end, looping off) settle. skipGuard is 0 here on a natural end (the
	// current track played successfully), so any failures during the advance get a fresh bounded pass.
	public async handleTrackEnd(): Promise<void> {
		const state = useAudioStore.getState()

		if (state.queue.length === 0) {
			this.settleStopped()

			return
		}

		if (state.loopMode === "one") {
			await this.loadAndPlay(state.currentIndex)

			return
		}

		const advance = computeNext(this.nav())

		if (advance === null) {
			this.settleStopped()

			return
		}

		this.applyAdvance(advance)
		await this.loadAndPlay(advance.index)
	}

	// Replace the whole queue positioned at a track and start playing — the folder-open / playlist-play
	// entry point. Supersedes the outgoing track's end-handling before swapping the queue.
	public async enqueueAndPlay(tracks: QueueTrack[], startIndex: number): Promise<void> {
		const load = replaceQueueAtIndex(tracks, startIndex, useAudioStore.getState().shuffleEnabled)

		this.loadGeneration++
		useAudioStore.getState().loadQueue(load.queue, load.currentIndex, load.shuffleOrder)

		if (load.queue.length === 0) {
			this.settleStopped()

			return
		}

		await this.loadAndPlay(load.currentIndex)
	}

	public async playCurrent(): Promise<void> {
		if (useAudioStore.getState().queue.length === 0) {
			return
		}

		await this.loadAndPlay(useAudioStore.getState().currentIndex)
	}

	// Resume an already-loaded element in place; if nothing is loaded yet, start the current track.
	public resume(): void {
		if (!this.element || useAudioStore.getState().queue.length === 0) {
			void this.playCurrent()

			return
		}

		useAudioStore.getState().setStatus("playing")
		this.deps.mediaSession?.setPlaybackState("playing")
		void this.element.play().catch((error: unknown) => {
			this.onPlaybackFailure(asErrorDTO(error))
		})
	}

	public pause(): void {
		this.element?.pause()
		useAudioStore.getState().setStatus("paused")
		this.deps.mediaSession?.setPlaybackState("paused")
	}

	public toggle(): void {
		if (useAudioStore.getState().status === "playing") {
			this.pause()
		} else {
			this.resume()
		}
	}

	public seek(seconds: number): void {
		this.element?.seek(seconds)
		useAudioStore.getState().setPosition(Math.max(0, seconds * 1000))

		if (this.element) {
			this.deps.mediaSession?.setPositionState(this.element.sample())
		}
	}

	public async skipNext(): Promise<void> {
		const advance = computeNext(this.nav())

		if (advance === null) {
			this.settleStopped()

			return
		}

		this.applyAdvance(advance)
		await this.loadAndPlay(advance.index)
	}

	public async skipPrevious(): Promise<void> {
		const positionMs = this.element ? this.element.sample().currentTimeMs : useAudioStore.getState().positionMs
		const result = smartPrevious(this.nav(), positionMs)

		if (result.kind === "restart") {
			this.seek(0)

			return
		}

		useAudioStore.getState().setCurrent(result.index, result.shuffleOrder)
		await this.loadAndPlay(result.index)
	}

	// Jump straight to a queued track (a now-playing-panel click-to-jump). Re-anchors the shuffle order at
	// the target so shuffle-next continues from there, then loads and plays it.
	public async playIndex(index: number): Promise<void> {
		const state = useAudioStore.getState()

		if (index < 0 || index >= state.queue.length) {
			return
		}

		const order = state.shuffleEnabled ? buildShuffleOrder(state.queue.length, index) : []

		state.setCurrent(index, order)
		await this.loadAndPlay(index)
	}

	// Remove one track from the queue (a per-row remove). A background track leaves playback untouched
	// (only the index label shifts); removing the CURRENT track loads whatever now fills its slot, or
	// clears everything when it was the last track.
	public async removeAt(index: number): Promise<void> {
		const state = useAudioStore.getState()
		const mutation = removeFromQueue(state.queue, state.currentIndex, state.shuffleEnabled, state.shuffleOrder, index)

		if (mutation.queue.length === 0) {
			this.clearQueue()

			return
		}

		if (mutation.currentRemoved) {
			this.loadGeneration++
			useAudioStore.getState().loadQueue(mutation.queue, mutation.currentIndex, mutation.shuffleOrder)
			await this.loadAndPlay(mutation.currentIndex)

			return
		}

		useAudioStore.getState().setQueueState(mutation.queue, mutation.currentIndex, mutation.shuffleOrder)
	}

	// Empty the queue and stop — the mini-player disappears (the shell renders it only for a non-empty
	// queue). Supersedes any in-flight load, revokes the live blob URL, and clears the OS metadata; the
	// persisted shuffle/loop/output prefs survive (store.reset keeps them).
	public clearQueue(): void {
		this.loadGeneration++
		this.element?.pause()
		this.element?.clear()

		if (this.currentBlobUrl !== null) {
			this.revoke(this.currentBlobUrl)
			this.currentBlobUrl = null
		}

		this.skipGuard = 0
		this.lastPositionWriteAt = 0
		useAudioStore.getState().reset()
		this.deps.mediaSession?.setMetadata(null)
		this.deps.mediaSession?.setPlaybackState("none")
	}

	public setShuffleEnabled(enabled: boolean): void {
		const state = useAudioStore.getState()
		const order = enabled && state.queue.length > 0 ? buildShuffleOrder(state.queue.length, state.currentIndex) : []

		state.setShuffle(enabled, order)
	}

	public setLoopMode(mode: LoopMode): void {
		useAudioStore.getState().setLoop(mode)
	}

	public setVolume(volume: number): void {
		this.volume = clampVolume(volume)
		this.element?.setVolume(this.volume)
		useAudioStore.getState().setOutput(this.volume, this.muted)
		void this.persistOutputPrefs()
	}

	public setMuted(muted: boolean): void {
		this.muted = muted
		this.element?.setMuted(muted)
		useAudioStore.getState().setOutput(this.volume, this.muted)
		void this.persistOutputPrefs()
	}

	public toggleMuted(): void {
		this.setMuted(!this.muted)
	}

	// Load-once persisted volume/muted, memoized per engine instance. Swallowed on failure — output
	// prefs are a nicety, never a blocker.
	public hydrateOutputPrefs(): Promise<void> {
		this.outputLoad ??= kvGetJson(OUTPUT_PREFS_KV_KEY, audioOutputPrefsSchema)
			.then(loaded => {
				if (loaded === null) {
					return
				}

				this.volume = clampVolume(loaded.volume)
				this.muted = loaded.muted
				this.element?.setVolume(this.volume)
				this.element?.setMuted(this.muted)
				useAudioStore.getState().setOutput(this.volume, this.muted)
			})
			.catch((error: unknown) => {
				log.warn("audio", "failed to load persisted audio output prefs", error)
			})

		return this.outputLoad
	}

	private async persistOutputPrefs(): Promise<void> {
		try {
			await kvSetJson(OUTPUT_PREFS_KV_KEY, { volume: this.volume, muted: this.muted })
		} catch (error) {
			log.warn("audio", "failed to persist audio output prefs", error)
		}
	}

	// Foreground reconcile: re-derive position/status straight off the element after the tab was
	// backgrounded (throttled timers left the store stale), advancing if the track ended while hidden.
	// The pure decision lives in reconcileVisibility; this only applies it.
	public bindLifecycle(): void {
		if (typeof document === "undefined" || this.visibilityHandler) {
			return
		}

		const handler = (): void => {
			if (document.visibilityState === "visible") {
				this.reconcileOnVisible()
			}
		}

		this.visibilityHandler = handler
		document.addEventListener("visibilitychange", handler)
	}

	private reconcileOnVisible(): void {
		if (!this.element) {
			return
		}

		const result = reconcileVisibility(this.element.sample(), useAudioStore.getState().status)

		useAudioStore.getState().setPosition(result.positionMs)
		useAudioStore.getState().setDuration(result.durationMs)

		if (result.shouldAdvance) {
			void this.handleTrackEnd()

			return
		}

		if (useAudioStore.getState().status !== "loading") {
			useAudioStore.getState().setStatus(result.status)
		}
	}

	// Full teardown on logout: supersede any in-flight load, stop + tear down the element, revoke the
	// live blob URL, and clear the store. Nothing leaks across sessions.
	public dispose(): void {
		this.loadGeneration++

		if (this.visibilityHandler && typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", this.visibilityHandler)
		}

		this.visibilityHandler = null

		this.element?.pause()
		this.element?.clear()
		this.element?.dispose()
		this.element = null

		if (this.currentBlobUrl !== null) {
			this.revoke(this.currentBlobUrl)
			this.currentBlobUrl = null
		}

		this.skipGuard = 0
		this.lastPositionWriteAt = 0
		useAudioStore.getState().reset()
		this.deps.mediaSession?.setMetadata(null)
		this.deps.mediaSession?.setPlaybackState("none")
	}
}
