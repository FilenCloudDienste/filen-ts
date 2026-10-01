import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { useMediaVolumeStore, type MediaVolume } from "@/lib/media/mediaVolume"
import { BlockSource, blobReadRange, urlReadRange } from "@/lib/media/blockSource"
import { MEDIA_FORMAT_UNSUPPORTED } from "@/lib/media/mediaFailure"
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
import { createThumbnailUrlCache } from "@/features/drive/lib/thumbnailUrlCache"
import { backfillTrackDuration, getTrackTags } from "@/features/audio/store/useTrackTagsStore"
import { COVER_THUMBNAIL_TYPE } from "@/features/audio/lib/trackTags.logic"

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

// The event callbacks the engine hands to the adapter factory; the adapter wires them to the concrete
// element's listeners (or, in a test, exposes them so the harness can fire them). `onError` hands over
// the failure unclassified: telling a format the browser cannot play from a broken stream may read the
// file, which only a failure that is reported is worth. It resolves null once the element has moved on.
export interface AudioElementEvents {
	onTimeUpdate: () => void
	onDurationChange: () => void
	onEnded: () => void
	onError: (failure: () => Promise<ErrorDTO | null>) => void
}

// The thin seam over a media element. Everything the engine needs and nothing more, so a fake is
// trivial. Times are ms (via `sample`). `rebind` swaps which event-callback set a LIVE element reports
// to without touching the element itself — the seam that makes prefetch promotion possible: a prefetch
// element is created with inert (no-op) events while it warms silently in the background, then rebound
// to the real playback events at the instant it is promoted to "now playing", preserving whatever the
// browser already buffered/decoded instead of reloading from scratch.
export interface AudioElementAdapter {
	// `bytes` reads the same file, for classifying a failure of it.
	load: (src: string, bytes: BlockSource) => void
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
// track switch / dispose; a "stream" url is an SW-served route that needs no page-side cleanup. A blob
// source carries its Blob so a local read uses the bytes already in memory: fetching a blob: URL is
// refused by the CSP's connect-src.
export type TrackSource = { kind: "stream"; url: string } | { kind: "blob"; url: string; blob: Blob }

export interface AudioEngineDeps {
	createElement: AudioElementFactory
	// `signal` aborts once the engine no longer wants the source (superseded load, torn-down prefetch),
	// so a whole-file download still in flight stops instead of finishing for nothing.
	resolveSource: (track: QueueTrack, signal: AbortSignal) => Promise<TrackSource>
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
	// The cover thumbnail for the current + one-ahead prefetched track; reading it also records the track's
	// tags in the track-tag store, which is where the engine reads them from. Same opt-in-by-presence
	// pattern as createPrefetchElement — absent in tests that don't care about metadata. `null` means the
	// track could not be read this time (not "no cover"), so a later load asks again.
	resolveCover?: (track: QueueTrack, source: TrackSource) => Promise<{ cover: Blob | null } | null>
	// A track failed because the browser cannot play its format; `stopped` when playback stopped on it
	// rather than skipping past it.
	onFormatFailure?: (track: QueueTrack, stopped: boolean) => void
}

// Cover-art blob URLs are held only for the current + one-ahead prefetched track, so this is headroom
// for a short back/forward history.
const COVER_CACHE_MAX_ENTRIES = 8

function defaultRevoke(url: string): void {
	if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
		URL.revokeObjectURL(url)
	}
}

// The track's bytes: the blob already in memory, or ranges of the stream the element plays.
function trackBytes(source: TrackSource, track: QueueTrack): BlockSource {
	return source.kind === "blob"
		? new BlockSource(source.blob.size, blobReadRange(source.blob))
		: new BlockSource(Number(track.file.size), urlReadRange(source.url))
}

function applyOutput(element: AudioElementAdapter, output: MediaVolume): void {
	element.setVolume(output.volume)
	element.setMuted(output.muted)
}

export class AudioEngine {
	private readonly deps: AudioEngineDeps
	private element: AudioElementAdapter | null = null
	// The object URL of the currently-loaded blob source, if any — revoked on switch/dispose.
	private currentBlobUrl: string | null = null
	// The uuid of the track whose bytes the main element currently holds. Identity is the uuid, not the
	// queue index, because indices shift under queue mutations. `null` means the element holds nothing
	// playable, so anything that would resume/replay "what is loaded" must load first.
	private loadedTrackUuid: string | null = null
	// Bumped on every load attempt so an older in-flight resolve/play can detect it was superseded and
	// bail (the user skipped, the queue was replaced, dispose ran) rather than stomping newer state.
	private loadGeneration = 0
	// Aborts the in-flight load's source resolve; replaced on every bump of loadGeneration.
	private loadAbort: AbortController | null = null
	// Bumped on every pause. A pause refuses PLAYBACK, not the load: the track is still the one the user
	// wants, so an in-flight load finishes onto the element, but every play() tail started before the bump
	// must abandon itself — never starting audio behind the pause, and never mistaking the play() the
	// pause aborted for a playback failure.
	private pauseGeneration = 0
	// Consecutive failed-track auto-skips; reset to 0 on any successful play. Bounds the auto-skip pass.
	private skipGuard = 0
	private lastPositionWriteAt = 0
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
	private prefetchAbort: AbortController | null = null
	// The index whose warm-up is still resolving, so a reschedule that lands on the same next track (a
	// loop/shuffle toggle right after a track starts) lets it finish instead of restarting it.
	private prefetchPendingIndex: number | null = null
	// One mint per track shared by every surface that shows cover art (bar, panel, MediaSession).
	private readonly coverCache = createThumbnailUrlCache(COVER_CACHE_MAX_ENTRIES, (_uuid, url) => {
		this.revoke(url)
	})

	public constructor(deps: AudioEngineDeps) {
		this.deps = deps

		// The shared media volume, whichever player changed it. The warm-up element follows too: a promoted
		// one keeps playing at the level it was given.
		useMediaVolumeStore.subscribe(output => {
			if (this.element) {
				applyOutput(this.element, output)
			}

			if (this.prefetchElement) {
				applyOutput(this.prefetchElement, output)
			}
		})
	}

	private now(): number {
		return (this.deps.now ?? Date.now)()
	}

	private revoke(url: string): void {
		;(this.deps.revokeObjectUrl ?? defaultRevoke)(url)
	}

	// An in-flight attempt no longer owns the transport once another load superseded it or the user paused
	// meanwhile — either way it must not settle the store, start audio, or report a failure.
	private superseded(loadGeneration: number, pauseGeneration: number): boolean {
		return loadGeneration !== this.loadGeneration || pauseGeneration !== this.pauseGeneration
	}

	// Every supersede of the current load goes through here, so its source download stops with it.
	private bumpLoadGeneration(): number {
		this.loadAbort?.abort()
		this.loadAbort = null

		return ++this.loadGeneration
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

	// The real playback callbacks, for a freshly created element and for a promoted warm one.
	private playbackEvents(): AudioElementEvents {
		return {
			onTimeUpdate: () => {
				this.onTimeUpdate()
			},
			onDurationChange: () => {
				this.onDurationChange()
			},
			onEnded: () => {
				void this.handleTrackEnd()
			},
			onError: failure => {
				void failure().then(error => {
					if (error !== null) {
						this.onPlaybackFailure(error)
					}
				})
			}
		}
	}

	// Shared play-start tail: a failure or success that lands after a supersede (new load or pause) is
	// dropped silently.
	private async playAndSettle(element: AudioElementAdapter, generation: number, pauseGeneration: number): Promise<void> {
		try {
			await element.play()
		} catch (error) {
			if (this.superseded(generation, pauseGeneration)) {
				return
			}

			this.onPlaybackFailure(asErrorDTO(error))

			return
		}

		if (this.superseded(generation, pauseGeneration)) {
			return
		}

		this.settlePlaying(element)
	}

	private ensureElement(): AudioElementAdapter {
		if (this.element) {
			return this.element
		}

		const element = this.deps.createElement(this.playbackEvents())

		applyOutput(element, useMediaVolumeStore.getState())
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

		applyOutput(element, useMediaVolumeStore.getState())
		this.prefetchElement = element

		return element
	}

	// Tears down whatever is currently warmed (element paused/cleared/disposed, its blob URL revoked) and
	// forgets which index it held. Safe to call when nothing is warmed. Called before every reschedule —
	// this module keeps at most ONE element ahead, never more. Also bumps the generation counter so a
	// schedulePrefetch continuation still awaiting resolveSource when the teardown ran can never
	// repopulate the slot afterwards: without the bump, a warm-up left in flight by a superseded queue
	// would survive the teardown, resurrect a dead element, and a later promotion by raw-index
	// coincidence would play the wrong track's bytes.
	private teardownPrefetch(): void {
		this.prefetchGeneration++
		this.prefetchAbort?.abort()
		this.prefetchAbort = null
		this.prefetchPendingIndex = null
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

		if (advance === null) {
			this.teardownPrefetch()

			return
		}

		if (advance.index === this.prefetchIndex || advance.index === this.prefetchPendingIndex) {
			return
		}

		this.teardownPrefetch()

		const track = useAudioStore.getState().queue[advance.index]

		// Next is the file already loaded (a one-track queue on loop "all"): handleTrackEnd replays it in
		// place, so warming a second copy would only re-resolve it every lap.
		if (!track || track.uuid === this.loadedTrackUuid) {
			return
		}

		// Snapshot AFTER the teardown's own bump: any teardown that runs while resolveSource below is
		// in flight (queue replace, jump, shuffle rebuild, dispose) moves the counter past this value,
		// so the continuation bails at the staleness guard instead of resurrecting a torn-down slot.
		const generation = this.prefetchGeneration
		const abort = new AbortController()

		this.prefetchAbort = abort
		this.prefetchPendingIndex = advance.index

		let source: TrackSource

		try {
			source = await this.deps.resolveSource(track, abort.signal)
		} catch {
			if (generation === this.prefetchGeneration) {
				this.prefetchPendingIndex = null
			}

			return
		}

		if (generation !== this.prefetchGeneration) {
			if (source.kind === "blob") {
				this.revoke(source.url)
			}

			return
		}

		this.prefetchPendingIndex = null

		this.scheduleMetadata(track, source)

		const element = this.ensurePrefetchElement()

		if (source.kind === "blob") {
			this.prefetchBlobUrl = source.url
		}

		element.load(source.url, trackBytes(source, track))
		this.prefetchIndex = advance.index
	}

	// Swaps the warmed element into the "now playing" slot: rebinds it to the real playback events,
	// retires the outgoing main element, and plays. Preserves whatever the browser already
	// buffered/decoded for the promoted element instead of resolving+loading from scratch.
	private async promotePrefetch(index: number): Promise<void> {
		const generation = this.bumpLoadGeneration()
		const pauseGeneration = this.pauseGeneration
		const track = useAudioStore.getState().queue[index]
		const promoted = this.prefetchElement

		if (!track || !promoted) {
			return
		}

		// The warm-up already extracted this track's tags while it was not yet current, so they are
		// published from what is known rather than waiting on an extraction that will not run again.
		this.publishMetadata(track)
		useAudioStore.getState().setStatus("loading")

		// Detach bookkeeping from the prefetch slot before touching the element — teardownPrefetch would
		// otherwise dispose the very element being promoted.
		this.prefetchElement = null
		const promotedBlobUrl = this.prefetchIndex === index ? this.prefetchBlobUrl : null
		this.prefetchIndex = null
		this.prefetchBlobUrl = null
		this.prefetchAbort = null

		promoted.rebind(this.playbackEvents())

		if (this.currentBlobUrl !== null && this.currentBlobUrl !== promotedBlobUrl) {
			this.revoke(this.currentBlobUrl)
		}

		this.currentBlobUrl = promotedBlobUrl

		const outgoing = this.element

		this.element = promoted
		this.loadedTrackUuid = track.uuid
		outgoing?.pause()
		outgoing?.clear()
		outgoing?.dispose()

		// A warm element announced its duration while bound to the INERT warm-up events, and a loaded
		// element never re-fires `durationchange` — so without this seed the store keeps the 0 setCurrent
		// wrote and the scrubber stays dead for the whole promoted track. Reads 0 when the warm-up had not
		// reached metadata yet; the now-bound handler corrects that when it lands.
		this.onDurationChange()

		await this.playAndSettle(promoted, generation, pauseGeneration)
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

	// Kicks off the cover (and, with it, tag) read for `track`. Skipped when the track's tags are known and
	// either it has no cover or its cover is still in the cache; a cover the LRU evicted is read again,
	// from the thumbnail cache when it is there, so a revisit normally costs no download. A no-op when no
	// resolveCover dep was supplied.
	private scheduleMetadata(track: QueueTrack, source: TrackSource): void {
		if (!this.deps.resolveCover) {
			return
		}

		const known = getTrackTags(track.uuid)

		if (known !== undefined && (!known.cover || this.coverCache.get(track.uuid) !== undefined)) {
			return
		}

		void this.deps.resolveCover(track, source).then(result => {
			if (result === null) {
				return
			}

			if (result.cover !== null) {
				this.applyCover(track.uuid, result.cover)
			}

			const state = useAudioStore.getState()
			const current = state.queue[state.currentIndex]

			// Only refresh the OS surface if this uuid is STILL the current track — a slow resolve for a
			// track the user has since skipped past must not stomp fresher metadata.
			if (current?.uuid === track.uuid) {
				this.publishMetadata(current)
			}
		})
	}

	// Publishes `track` to the OS surface with whatever tags and cover are already known for it.
	private publishMetadata(track: QueueTrack): void {
		if (!this.deps.mediaSession) {
			return
		}

		const tags = getTrackTags(track.uuid)
		const coverUrl = this.coverCache.get(track.uuid)

		this.deps.mediaSession.setMetadata(track, tags, coverUrl !== undefined ? { url: coverUrl, type: COVER_THUMBNAIL_TYPE } : null)
	}

	// Mints/evicts the cover into the shared LRU and mirrors the cache's live key set into the store so
	// every reactive surface (bar, panel thumbnails) sees it.
	private applyCover(uuid: string, cover: Blob): void {
		const previous = this.coverCache.delete(uuid)

		if (previous !== undefined) {
			this.revoke(previous)
		}

		this.coverCache.set(uuid, URL.createObjectURL(cover))

		useAudioStore.getState().setCoverUrls(Object.fromEntries(this.coverCache.entries()))
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
		const known = Number.isFinite(durationMs) && durationMs > 0

		useAudioStore.getState().setDuration(known ? durationMs : 0)

		if (known && this.loadedTrackUuid !== null) {
			backfillTrackDuration(this.loadedTrackUuid, durationMs / 1000)
		}
	}

	// Move to `index` and start it. If it is already warmed by the prefetch element, promote it instead
	// (no re-resolve, no reload). Otherwise the cold-start path: resolve a source (SW stream or
	// whole-buffer blob), swap the element's src, play. Every await re-checks the generation so a
	// superseding load/skip/dispose bails cleanly; a source resolved for a superseded load still has its
	// blob URL freed. A pause is NOT a supersede: the resolved bytes still land on the element, only the
	// playing is dropped. A resolve error or a rejected play() routes into the bounded auto-skip.
	private async loadAndPlay(index: number): Promise<void> {
		if (index === this.prefetchIndex && this.prefetchElement) {
			await this.promotePrefetch(index)

			return
		}

		const generation = this.bumpLoadGeneration()
		const pauseGeneration = this.pauseGeneration
		const track = useAudioStore.getState().queue[index]

		if (!track) {
			return
		}

		// Publish OS metadata as soon as the track is known (before bytes resolve) so the lock-screen /
		// media-key surface names the loading track rather than lagging a beat behind.
		this.publishMetadata(track)
		useAudioStore.getState().setStatus("loading")

		const abort = new AbortController()

		this.loadAbort = abort

		let source: TrackSource

		try {
			source = await this.deps.resolveSource(track, abort.signal)
		} catch (error) {
			// A pause abandons the failure too, not just the playback: the retry when the user asks for
			// audio again is what should surface it, rather than an error the paused user never provoked.
			if (this.superseded(generation, pauseGeneration)) {
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
		element.load(source.url, trackBytes(source, track))
		this.loadedTrackUuid = track.uuid

		// Paused while this was resolving: the bytes stay on the element — that is what gives the paused
		// track a duration and a live scrubber, and what lets resume() replay it without a second download
		// — but the playback the user just refused never starts.
		if (this.pauseGeneration !== pauseGeneration) {
			return
		}

		await this.playAndSettle(element, generation, pauseGeneration)
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
		const state = useAudioStore.getState()
		const track = state.queue[state.currentIndex] ?? null

		state.setError(error, track)

		// The auto-skip exists to get playback past a broken track. A paused transport is not asking for
		// audio, so a failure reaching it here (a stray element error on the loaded-but-paused track) stops
		// at the error instead of advancing the queue into playback the user did not ask for.
		if (state.status === "paused") {
			this.reportFormatFailure(error, track, true)

			return
		}

		this.skipGuard += 1

		const advance = withinSkipBudget(this.skipGuard, state.queue.length) ? computeNext(this.nav()) : null

		this.reportFormatFailure(error, track, advance === null)

		if (advance === null) {
			this.settleStopped()

			return
		}

		this.applyAdvance(advance)
		void this.loadAndPlay(advance.index)
	}

	private reportFormatFailure(error: ErrorDTO, track: QueueTrack | null, stopped: boolean): void {
		if (error.kind === MEDIA_FORMAT_UNSUPPORTED && track !== null) {
			this.deps.onFormatFailure?.(track, stopped)
		}
	}

	private applyAdvance(advance: AdvanceResult): void {
		useAudioStore.getState().setCurrent(advance.index, advance.shuffleOrder)
	}

	// End of the road: supersede any in-flight load, stop the element, and settle to a non-spinning
	// terminal status (idle when the queue is empty, otherwise paused at the start). Any lastError set
	// by the failure path stays visible.
	private settleStopped(): void {
		this.bumpLoadGeneration()
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
			await this.repeatCurrent(state.currentIndex)

			return
		}

		const advance = computeNext(this.nav())

		if (advance === null) {
			this.settleStopped()

			return
		}

		this.applyAdvance(advance)

		// Next is the file already on the element (a one-track queue on loop "all"): replay it in place
		// like loop "one" instead of re-resolving it. setCurrent zeroed the duration and the element will
		// not re-announce it.
		if (useAudioStore.getState().queue[advance.index]?.uuid === this.loadedTrackUuid) {
			this.onDurationChange()
			await this.repeatCurrent(advance.index)

			return
		}

		await this.loadAndPlay(advance.index)
	}

	// Loop "one": replay the element in place. Reloading would re-resolve the source on every lap — a
	// full re-download and re-decrypt of the file on the blob path, a fresh SW registration on the stream
	// path — and throw away whatever the browser had already buffered. Prefetch can never cover this: it
	// warms what comes AFTER the current track. Falls back to a cold load only when the element no longer
	// holds this track.
	private async repeatCurrent(index: number): Promise<void> {
		const element = this.element
		const track = useAudioStore.getState().queue[index]

		if (!element || track?.uuid !== this.loadedTrackUuid) {
			await this.loadAndPlay(index)

			return
		}

		const generation = this.bumpLoadGeneration()
		const pauseGeneration = this.pauseGeneration

		element.seek(0)
		useAudioStore.getState().setPosition(0)

		await this.playAndSettle(element, generation, pauseGeneration)
	}

	// Replace the whole queue positioned at a track and start playing — the folder-open / playlist-play
	// entry point. Supersedes the outgoing track's end-handling before swapping the queue. The old queue's
	// warmed prefetch (if any) is keyed to an index into an array that no longer exists after this swap —
	// torn down unconditionally so loadAndPlay never mistakes it for warm by raw index coincidence.
	// `shuffle` sets the shuffle toggle as part of the swap (shuffle-play), rather than through
	// setShuffleEnabled, which would first re-arm a prefetch against the queue being replaced.
	public async enqueueAndPlay(tracks: QueueTrack[], startIndex: number, options: { shuffle?: boolean } = {}): Promise<void> {
		const load = replaceQueueAtIndex(tracks, startIndex, options.shuffle ?? useAudioStore.getState().shuffleEnabled)

		this.bumpLoadGeneration()
		this.teardownPrefetch()
		useAudioStore.getState().loadQueue(load.queue, load.currentIndex, load.shuffleOrder)

		if (options.shuffle !== undefined) {
			useAudioStore.getState().setShuffle(options.shuffle, load.shuffleOrder)
		}

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

	// Resume an already-loaded element in place. When the element holds anything other than the current
	// track — nothing yet, or the previous track because a load was paused/superseded mid-flight — this
	// starts the current track instead of replaying stale bytes.
	public resume(): void {
		const state = useAudioStore.getState()
		const current = state.queue[state.currentIndex]

		if (!this.element || current?.uuid !== this.loadedTrackUuid) {
			void this.playCurrent()

			return
		}

		const generation = this.loadGeneration
		const pauseGeneration = this.pauseGeneration

		state.setStatus("playing")
		this.deps.mediaSession?.setPlaybackState("playing")
		void this.element.play().catch((error: unknown) => {
			// A pause landing before this settles rejects it with AbortError; that is the user's own doing,
			// not a broken track, so it must not surface an error or trigger the auto-skip. Nor may a
			// failure the element's error event already reported (and skipped past) count twice.
			if (this.superseded(generation, pauseGeneration)) {
				return
			}

			this.onPlaybackFailure(asErrorDTO(error))
		})
	}

	// Pausing supersedes the PLAYBACK an in-flight load is heading for, not the load itself: without the
	// bump, a load that resolves after this settles to "playing" and starts audio the user just refused —
	// and the element.pause() below would reject that load's own play() promise, surfacing a playback
	// error and auto-skipping to another track. The load still finishes onto the element, so the paused
	// track keeps a duration/scrubber and resume() replays it without re-downloading it.
	public pause(): void {
		this.pauseGeneration++
		this.element?.pause()
		useAudioStore.getState().setStatus("paused")
		this.deps.mediaSession?.setPlaybackState("paused")
	}

	// "loading" is playback intent already in flight, so a toggle during it is a PAUSE — the transport
	// button stays enabled through the spinner, and resuming there would play whatever the element still
	// holds (the previous track).
	public toggle(): void {
		const status = useAudioStore.getState().status

		if (status === "playing" || status === "loading") {
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
			this.bumpLoadGeneration()
			useAudioStore.getState().loadQueue(mutation.queue, mutation.currentIndex, mutation.shuffleOrder)
			await this.loadAndPlay(mutation.currentIndex)

			return
		}

		useAudioStore.getState().setQueueState(mutation.queue, mutation.currentIndex, mutation.shuffleOrder)
		void this.schedulePrefetch()
	}

	// Empty the queue and stop — the mini-player disappears (the shell renders it only for a non-empty
	// queue). Supersedes any in-flight load, revokes the live blob URL, and clears the OS metadata; the
	// persisted shuffle/loop prefs survive (store.reset keeps them).
	public clearQueue(): void {
		this.bumpLoadGeneration()
		this.element?.pause()
		this.element?.clear()
		this.loadedTrackUuid = null
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

	// Rebuilding the shuffle order can change what "next" means. schedulePrefetch re-derives it and tears
	// the warm-up down only when the next index moved: the queue itself is unchanged, so the same index
	// still names the same track and its warm buffer stays valid.
	public setShuffleEnabled(enabled: boolean): void {
		const state = useAudioStore.getState()
		const order = enabled && state.queue.length > 0 ? buildShuffleOrder(state.queue.length, state.currentIndex) : []

		state.setShuffle(enabled, order)
		void this.schedulePrefetch()
	}

	// A loop-mode change can change what "next" means at the queue boundary (off/all/one resolve
	// differently there) — same reschedule as setShuffleEnabled.
	public setLoopMode(mode: LoopMode): void {
		useAudioStore.getState().setLoop(mode)
		void this.schedulePrefetch()
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
		this.bumpLoadGeneration()

		if (this.visibilityHandler && typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", this.visibilityHandler)
		}

		this.visibilityHandler = null

		this.element?.pause()
		this.element?.clear()
		this.element?.dispose()
		this.element = null
		this.loadedTrackUuid = null
		this.teardownPrefetch()
		this.coverCache.clear()

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
