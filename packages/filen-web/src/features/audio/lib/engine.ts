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
import { CoverArtCache } from "@/features/audio/lib/coverCache"
import type { TrackTags } from "@/features/audio/lib/metadata"

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
// trivial. Times are ms (via `sample`). `rebind` swaps which event-callback set a LIVE element reports
// to without touching the element itself — the seam that makes prefetch promotion possible: a prefetch
// element is created with inert (no-op) events while it warms silently in the background, then rebound
// to the real playback events at the instant it is promoted to "now playing", preserving whatever the
// browser already buffered/decoded instead of reloading from scratch.
export interface AudioElementAdapter {
	load: (src: string) => void
	play: () => Promise<void>
	pause: () => void
	seek: (seconds: number) => void
	clear: () => void
	setVolume: (volume: number) => void
	setMuted: (muted: boolean) => void
	sample: () => ElementSample
	rebind: (events: AudioElementEvents) => void
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
	// A second element factory for the one-track-ahead warm-up (preload="auto" in production). Prefetch
	// is entirely opt-in on this dep's presence: omitting it (every existing test, any environment that
	// doesn't care) means schedulePrefetch is a permanent no-op and playback behaves exactly as it did
	// before prefetch existed — zero behavioral change for callers that don't provide it.
	createPrefetchElement?: AudioElementFactory
	// Tag/cover extraction for the current + one-ahead prefetched track. Same opt-in-by-presence pattern
	// as createPrefetchElement — absent in tests that don't care about metadata.
	extractMetadata?: (track: QueueTrack, source: TrackSource) => Promise<TrackTags>
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
	// The one-track-ahead warm-up element + which queue index it holds, if any. `null` index means
	// "nothing warmed" (no prefetch dep, queue end, or the warm-up itself failed/was superseded).
	private prefetchElement: AudioElementAdapter | null = null
	private prefetchIndex: number | null = null
	private prefetchBlobUrl: string | null = null
	// Bumped on every schedulePrefetch call so a superseded in-flight resolve (a jump/shuffle-rebuild
	// landed before the previous prefetch resolved) detects it and discards its result instead of
	// warming a now-stale target.
	private prefetchGeneration = 0
	private readonly coverCache = new CoverArtCache()

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

	// Lazily creates the warm-up element with INERT events — it must never drive playback state while it
	// is silently buffering in the background (a stray `ended`/`error` from an element that isn't
	// actually playing must not touch the current track). `onError` is the one real hook: a warm-up
	// failure just means "not warm", handled the same as never having prefetched at all.
	private ensurePrefetchElement(): AudioElementAdapter {
		if (this.prefetchElement) {
			return this.prefetchElement
		}

		const factory = this.deps.createPrefetchElement ?? this.deps.createElement
		const element = factory({
			onTimeUpdate: () => undefined,
			onDurationChange: () => undefined,
			onEnded: () => undefined,
			onError: () => {
				this.teardownPrefetch()
			}
		})

		this.prefetchElement = element

		return element
	}

	// Tears down whatever is currently warmed (element paused/cleared/disposed, its blob URL revoked) and
	// forgets which index it held. Safe to call when nothing is warmed. Called before every reschedule —
	// this module keeps at most ONE element ahead, never more.
	private teardownPrefetch(): void {
		this.prefetchElement?.pause()
		this.prefetchElement?.clear()
		this.prefetchElement?.dispose()
		this.prefetchElement = null
		this.prefetchIndex = null

		if (this.prefetchBlobUrl !== null) {
			this.revoke(this.prefetchBlobUrl)
			this.prefetchBlobUrl = null
		}
	}

	// Re-derives "what should be warmed next" from the live queue/nav state and, if it differs from what
	// is already warmed, tears down the stale warm-up and resolves+loads the new one. A no-op when no
	// prefetch dep was supplied (createPrefetchElement absent), when there is nowhere to advance to, or
	// when the target is already warm. Never throws, never surfaces an error — prefetch is a pure nicety,
	// a failure here just costs the next track a cold-start beat.
	private async schedulePrefetch(): Promise<void> {
		if (!this.deps.createPrefetchElement) {
			return
		}

		const advance = computeNext(this.nav())
		const generation = ++this.prefetchGeneration

		if (advance === null) {
			this.teardownPrefetch()

			return
		}

		if (advance.index === this.prefetchIndex) {
			return
		}

		this.teardownPrefetch()

		const track = useAudioStore.getState().queue[advance.index]

		if (!track) {
			return
		}

		let source: TrackSource

		try {
			source = await this.deps.resolveSource(track)
		} catch {
			return
		}

		if (generation !== this.prefetchGeneration) {
			if (source.kind === "blob") {
				this.revoke(source.url)
			}

			return
		}

		this.scheduleMetadata(track, source)

		const element = this.ensurePrefetchElement()

		if (source.kind === "blob") {
			this.prefetchBlobUrl = source.url
		}

		element.load(source.url)
		this.prefetchIndex = advance.index
	}

	// Swaps the warmed element into the "now playing" slot: rebinds it to the real playback events,
	// retires the outgoing main element, and plays. Preserves whatever the browser already
	// buffered/decoded for the promoted element instead of resolving+loading from scratch.
	private async promotePrefetch(index: number): Promise<void> {
		const generation = ++this.loadGeneration
		const track = useAudioStore.getState().queue[index]
		const promoted = this.prefetchElement

		if (!track || !promoted) {
			return
		}

		this.deps.mediaSession?.setMetadata(track)
		useAudioStore.getState().setStatus("loading")

		// Detach bookkeeping from the prefetch slot before touching the element — teardownPrefetch would
		// otherwise dispose the very element being promoted.
		this.prefetchElement = null
		const promotedBlobUrl = this.prefetchIndex === index ? this.prefetchBlobUrl : null
		this.prefetchIndex = null
		this.prefetchBlobUrl = null

		promoted.rebind({
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

		if (this.currentBlobUrl !== null && this.currentBlobUrl !== promotedBlobUrl) {
			this.revoke(this.currentBlobUrl)
		}

		this.currentBlobUrl = promotedBlobUrl

		const outgoing = this.element

		this.element = promoted
		outgoing?.pause()
		outgoing?.clear()
		outgoing?.dispose()

		try {
			await promoted.play()
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

		this.settlePlaying(promoted)
	}

	// Shared success tail for a track that just started playing, whether via a cold-started element
	// (loadAndPlay) or a promoted warm one (promotePrefetch): clear the skip guard/error, settle the
	// store + OS playback state, and re-arm the one-ahead prefetch for whatever is next from here.
	private settlePlaying(element: AudioElementAdapter): void {
		this.skipGuard = 0
		this.lastPositionWriteAt = 0
		useAudioStore.getState().setError(null)
		useAudioStore.getState().setStatus("playing")
		this.deps.mediaSession?.setPlaybackState("playing")
		this.deps.mediaSession?.setPositionState(element.sample())
		void this.schedulePrefetch()
	}

	// Kicks off tag/cover extraction for `track` against the SAME source the engine resolved for
	// playback — never a second byte fetch of its own. Memoized per uuid via tagsByUuid's presence (an
	// EMPTY_TRACK_TAGS result still counts as "attempted", so a tag-less file is never re-parsed every
	// time it's revisited). A no-op when no extractMetadata dep was supplied.
	private scheduleMetadata(track: QueueTrack, source: TrackSource): void {
		if (!this.deps.extractMetadata) {
			return
		}

		if (useAudioStore.getState().tagsByUuid[track.uuid] !== undefined) {
			return
		}

		void this.deps.extractMetadata(track, source).then(tags => {
			useAudioStore.getState().setTrackTags(track.uuid, tags)

			const coverUrl = tags.picture ? this.applyCover(track.uuid, tags.picture) : null
			const state = useAudioStore.getState()
			const current = state.queue[state.currentIndex]

			// Only refresh the OS surface if this uuid is STILL the current track — a slow resolve for a
			// track the user has since skipped past must not stomp fresher metadata.
			if (current?.uuid === track.uuid) {
				this.deps.mediaSession?.setMetadata(
					current,
					{ title: tags.title, artist: tags.artist, album: tags.album },
					coverUrl && tags.picture ? { url: coverUrl, type: tags.picture.format } : null
				)
			}
		})
	}

	// Mints/evicts the cover into the shared LRU and mirrors the cache's live key set into the store so
	// every reactive surface (bar, panel thumbnails) sees it. Returns the freshly-minted URL.
	private applyCover(uuid: string, picture: NonNullable<TrackTags["picture"]>): string {
		const url = this.coverCache.set(uuid, picture)

		useAudioStore.getState().setCoverUrls(this.coverCache.snapshot())

		return url
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

	// Move to `index` and start it. If it is already warmed by the prefetch element, promote it instead
	// (no re-resolve, no reload). Otherwise the cold-start path: resolve a source (SW stream or
	// whole-buffer blob), swap the element's src, play. Every await re-checks the generation so a
	// superseding load/skip/dispose bails cleanly; a source resolved for a superseded load still has its
	// blob URL freed. A resolve error or a rejected play() routes into the bounded auto-skip.
	private async loadAndPlay(index: number): Promise<void> {
		if (index === this.prefetchIndex && this.prefetchElement) {
			await this.promotePrefetch(index)

			return
		}

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

		this.scheduleMetadata(track, source)

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

		this.settlePlaying(element)
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
		this.teardownPrefetch()

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

		// Indices shift under any removal, so whatever was warmed is stale regardless of which slot was
		// removed — tear it down unconditionally and let whichever branch below re-arm it against the
		// post-mutation queue.
		this.teardownPrefetch()

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
		void this.schedulePrefetch()
	}

	// Empty the queue and stop — the mini-player disappears (the shell renders it only for a non-empty
	// queue). Supersedes any in-flight load, revokes the live blob URL, and clears the OS metadata; the
	// persisted shuffle/loop/output prefs survive (store.reset keeps them).
	public clearQueue(): void {
		this.loadGeneration++
		this.element?.pause()
		this.element?.clear()
		this.teardownPrefetch()

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

	// Rebuilding the shuffle order changes what "next" means, so the previously-warmed prefetch (if any)
	// is stale — tear it down and re-arm against the fresh order.
	public setShuffleEnabled(enabled: boolean): void {
		const state = useAudioStore.getState()
		const order = enabled && state.queue.length > 0 ? buildShuffleOrder(state.queue.length, state.currentIndex) : []

		state.setShuffle(enabled, order)
		this.teardownPrefetch()
		void this.schedulePrefetch()
	}

	// A loop-mode change also changes what "next" means (off/all/one all resolve differently at the
	// queue boundary) — same reschedule as setShuffleEnabled.
	public setLoopMode(mode: LoopMode): void {
		useAudioStore.getState().setLoop(mode)
		this.teardownPrefetch()
		void this.schedulePrefetch()
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
		this.teardownPrefetch()
		this.coverCache.revokeAll()

		if (this.currentBlobUrl !== null) {
			this.revoke(this.currentBlobUrl)
			this.currentBlobUrl = null
		}

		this.skipGuard = 0
		this.lastPositionWriteAt = 0
		useAudioStore.getState().reset()
		useAudioStore.getState().resetMetadata()
		this.deps.mediaSession?.setMetadata(null)
		this.deps.mediaSession?.setPlaybackState("none")
	}
}
