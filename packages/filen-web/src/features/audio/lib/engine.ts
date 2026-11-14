import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { useMediaVolumeStore, type MediaVolume } from "@/lib/media/mediaVolume"
import { MEDIA_FORMAT_UNSUPPORTED, type MediaFailureKind } from "@/lib/media/mediaFailure"
import { log } from "@/lib/log"
import { replayGainFor } from "@filen/shared"
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
import type { AudioOutput, ElementGain } from "@/features/audio/lib/audioOutput"
import type { GetTrackEdges, SmoothTransitionsPrefs, SourceRoute, TrackEdges } from "@/features/audio/lib/smoothTransitions.types"
import {
	committedValid,
	fadeCurves,
	manualFadePlan,
	planTransition,
	sameRelease,
	seekCancelsCrossfade,
	shouldStartFade,
	MANUAL_FADE_MS,
	type CommittedAdvance,
	type TransitionPlan
} from "@/features/audio/lib/crossfade.logic"
import { INITIAL_WATCHDOG_STATE, watchdogStep, type WatchdogState } from "@/features/audio/lib/outputWatchdog.logic"
import { setSmoothTransitionsUnavailable, useSmoothTransitionsStore } from "@/features/audio/store/useSmoothTransitionsStore"

// The module-level playback engine — a singleton lib (constructed in audioEngine.ts with the real DOM
// adapter + streaming source resolver), NOT a React component, mirroring sdkApi and the mobile Audio
// class. It owns the main media element (replaced when a warm one is promoted, or when its Web Audio routing no
// longer fits) and drives the zustand store; the store drives the UI. All element interaction goes through an
// injected adapter so the whole engine is unit-testable in node, where an <audio> element cannot be constructed —
// the real adapter is exercised live on-device instead.

// Position writes to the store are throttled to a sane cadence — a media element fires `timeupdate`
// several times a second, and a scrubber does not need more than ~4Hz. End-detection rides the `ended`
// event, never this throttle, so a coarser cadence costs nothing.
const POSITION_WRITE_THROTTLE_MS = 250

// A gapless micro-overlap is too short for `timeupdate` to catch: its timer is armed once this little is left.
const MICRO_OVERLAP_ARM_MS = 1_500

// Curves start this far after the AudioContext's clock, so the first point is never already in the past.
const CURVE_LEAD_SECONDS = 0.02

// A cold target of a "short fade" skip that is not playing by then: the outgoing fades out on its own.
const MANUAL_FADE_TARGET_TIMEOUT_MS = 3_000

// A routed element's sound can reach the graph well after its play() resolved (WebKit buffers it): the curves wait
// for it to be heard, this long at most (a track that opens with digital silence).
const AUDIBLE_TIMEOUT_MS = 600

// How long a warm element takes from play() to being heard, before one was measured, and how much one measurement
// moves it.
const INITIAL_START_LATENCY_MS = 50
// WebKit hands a routed element's sound to the graph about half a second after it starts, sooner for an element
// already sought into its audio: never assumed shorter than this there.
const WEBKIT_START_LATENCY_MS = 450
const START_LATENCY_WEIGHT = 0.3
const START_LATENCY_MARGIN = 1.5
const MAX_START_LATENCY_MS = 1_000

// WebKit never suspends its context while paused (its resume can stay silent), so a long pause hands the routed element
// back and closes the context; the next play, a gesture, starts a new one.
const WEBKIT_IDLE_CLOSE_MS = 5 * 60_000

// Turning loudness matching on or off moves the trims this smoothly.
const TRIM_RAMP_SECONDS = 0.2

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

// The element ran out of data (`waiting`) or the network stopped delivering (`stalled`).
export type StallListener = (kind: "waiting" | "stalled") => void

// The thin seam over a media element. Everything the engine needs and nothing more, so a fake is
// trivial. Times are ms (via `sample`). `rebind` swaps which event-callback set a LIVE element reports
// to without touching the element itself — the seam that makes prefetch promotion possible: a prefetch
// element is created with inert (no-op) events while it warms silently in the background, then rebound
// to the real playback events at the instant it is promoted to "now playing", preserving whatever the
// browser already buffered/decoded instead of reloading from scratch.
export interface AudioElementAdapter {
	// Hands the element the source's media; the source also classifies the element's failures.
	load: (source: TrackSource) => void
	play: () => Promise<void>
	pause: () => void
	seek: (seconds: number) => void
	clear: () => void
	setVolume: (volume: number) => void
	setMuted: (muted: boolean) => void
	sample: () => ElementSample
	rebind: (events: AudioElementEvents) => void
	dispose: () => void
	// Routes the element through the Web Audio output, for good: its sound then only reaches the speakers through
	// the returned gains. Absent where an element cannot be routed.
	route?: (output: AudioOutput) => ElementGain | null
	// Reports data starvation to `listener` (null stops it). Logged during a transition, where two streams compete.
	watchStalls?: (listener: StallListener | null) => void
}

export type AudioElementFactory = (events: AudioElementEvents) => AudioElementAdapter

// A resolved playable source, always streamed: a URL the service worker serves (the file as it is, or its
// audio decoded into a WAV stream), or a MediaSource session the element is attached to where no service
// worker serves the page. The engine owns it from resolve to `release` (a track switch, a torn-down warm-up,
// dispose), which hands back whatever it holds.
export interface TrackSource {
	media:
		| { kind: "url"; url: string }
		// `onFailure` reports a failure the session itself detected, classified.
		| { kind: "session"; attach: (element: HTMLMediaElement, onFailure: (kind: MediaFailureKind) => void) => Promise<void> }
	// How the source reached the element; absent reads as the file as it is.
	route?: SourceRoute
	// Tells a format failure from a broken stream, given the element's MediaError code.
	classify: (code: number) => Promise<MediaFailureKind>
	release: () => void
	// Present when a format failure of this source has another route to try: records the failure, so the
	// file resolves to that route from now on.
	demote?: () => void
}

// Smooth transitions (crossfades, smart edges, loudness matching). Opt-in by presence like prefetch: without it,
// and while the feature is off, playback is exactly what it is without the feature.
export interface SmoothTransitionsDeps {
	output: AudioOutput
	getEdges: GetTrackEdges
	// Re-reads a parsed track's ReplayGain (records parsed before it was read carry none).
	refreshGain?: (track: QueueTrack) => void
	// WebKit: MediaSource sessions cannot be routed (they play as silence).
	webkit: boolean
	// Whether the call runs inside a user gesture, so a context created now may start.
	inGesture: () => boolean
}

export interface AudioEngineDeps {
	createElement: AudioElementFactory
	// `signal` aborts once the engine no longer wants the source (superseded load, torn-down prefetch).
	resolveSource: (track: QueueTrack, signal: AbortSignal) => Promise<TrackSource>
	// Injectable purely so tests can spy on cover URL revocation; production uses URL.revokeObjectURL.
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
	resolveCover?: (track: QueueTrack) => Promise<{ cover: Blob | null } | null>
	// A track failed because the browser cannot play its format; `stopped` when playback stopped on it
	// rather than skipping past it.
	onFormatFailure?: (track: QueueTrack, stopped: boolean) => void
	smoothTransitions?: SmoothTransitionsDeps
}

// Cover-art blob URLs are held only for the current + one-ahead prefetched track, so this is headroom
// for a short back/forward history.
const COVER_CACHE_MAX_ENTRIES = 8

function defaultRevoke(url: string): void {
	if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
		URL.revokeObjectURL(url)
	}
}

function masterLevel(output: MediaVolume): number {
	return output.muted ? 0 : output.volume
}

// A routed element's gains, with the loudness trim it plays at and its peak after that trim (for the overlap's
// headroom).
interface Routed {
	gain: ElementGain
	trim: number
	peak: number
}

// The outgoing element of a transition, fading out (or about to) while the current one plays.
interface Fading {
	element: AudioElementAdapter
	source: TrackSource | null
	timer: ReturnType<typeof setTimeout> | null
	// Wall time the fade is over, for a background tab whose timers were held back.
	endsAt: number
}

// A transition whose incoming element was asked to play and has not started yet.
interface Starting {
	incoming: AudioElementAdapter
	source: TrackSource | null
	index: number
	// The track the incoming element holds: an index alone goes stale under a queue edit.
	uuid: string
	plan: TransitionPlan
	// Null when the queue already moved to the incoming track (a skip the user asked for).
	advance: AdvanceResult | null
	outgoingEnded: boolean
}

interface LoadOptions {
	// The user picked the track: it starts at 0:00, and a "short fade" skip fades into it.
	manual?: boolean
	// The reload of a degraded output: a refused play holds paused instead of skipping.
	degrade?: boolean
}

export class AudioEngine {
	private readonly deps: AudioEngineDeps
	private element: AudioElementAdapter | null = null
	// The source the main element plays, released on switch/dispose.
	private currentSource: TrackSource | null = null
	// Sources already demoted: a format failure after that (the other route cannot decode the file either) is
	// final, never another retry.
	private readonly demoted = new WeakSet<TrackSource>()
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
	private prefetchSource: TrackSource | null = null
	// Where the warm element was sought to (past the incoming track's leading silence), so a skip the user asked
	// for can take it back to 0:00.
	private prefetchStartMs = 0
	// Bumped on every schedulePrefetch call so a superseded in-flight resolve (a jump/shuffle-rebuild
	// landed before the previous prefetch resolved) detects it and discards its result instead of
	// warming a now-stale target.
	private prefetchGeneration = 0
	private prefetchAbort: AbortController | null = null
	// The index whose warm-up is still resolving, so a reschedule that lands on the same next track (a
	// loop/shuffle toggle right after a track starts) lets it finish instead of restarting it.
	private prefetchPendingIndex: number | null = null
	// The next-track decision the warm-up was made for. A shuffle lap's reshuffle is random, so the track end, a
	// fade, a skip and a failure all take this rather than deciding again (and landing on another track).
	private committed: CommittedAdvance | null = null
	// One mint per track shared by every surface that shows cover art (bar, panel, MediaSession).
	private readonly coverCache = createThumbnailUrlCache(COVER_CACHE_MAX_ENTRIES, (_uuid, url) => {
		this.revoke(url)
	})

	// Smooth transitions. Everything below stays empty while the feature is off.
	private readonly routed = new Map<AudioElementAdapter, Routed>()
	// An unrouted element's loudness trim, applied through its volume.
	private readonly unroutedTrim = new WeakMap<AudioElementAdapter, number>()
	private fading: Fading | null = null
	private starting: Starting | null = null
	private plan: TransitionPlan | null = null
	// The plan needs re-deriving (edges arrived, a duration became known, the fade length changed).
	private planStale = true
	// The uuid whose crossfade the user ruled out by seeking into its window: it plays out gapless.
	private gaplessOnlyUuid: string | null = null
	private transitionTimer: ReturnType<typeof setTimeout> | null = null
	// Edges known for the current and the warm track, by uuid.
	private readonly knownEdges = new Map<string, TrackEdges | null>()
	private readonly edgeReads = new Map<string, AbortController>()
	// The output stopped rendering this session: every element plays unrouted from now on.
	private degraded = false
	// The degrade reload's play() was refused (background): the next resume tries again.
	private degradeRetry = false
	// Where a degrade reload resumes the track.
	private pendingResume: { uuid: string; ms: number } | null = null
	private watchdog: WatchdogState = INITIAL_WATCHDOG_STATE
	// How long a warm element takes from play() to being heard here, smoothed: a gapless switch is asked for that early.
	private startLatencyMs = INITIAL_START_LATENCY_MS
	private minStartLatencyMs = 0
	private idleCloseTimer: ReturnType<typeof setTimeout> | null = null

	public constructor(deps: AudioEngineDeps) {
		this.deps = deps

		// The shared media volume, whichever player changed it. The warm-up and the fading element follow too. A
		// routed element stays at full level: the output's master gain carries the volume for it.
		useMediaVolumeStore.subscribe(output => {
			for (const element of [this.element, this.prefetchElement, this.fading?.element]) {
				if (element && !this.routed.has(element)) {
					this.applyElementVolume(element, output)
				}
			}

			this.deps.smoothTransitions?.output.setMaster(masterLevel(output))
		})

		if (deps.smoothTransitions) {
			const output = deps.smoothTransitions.output

			this.startLatencyMs = deps.smoothTransitions.webkit ? WEBKIT_START_LATENCY_MS : INITIAL_START_LATENCY_MS
			this.minStartLatencyMs = deps.smoothTransitions.webkit ? WEBKIT_START_LATENCY_MS : 0

			output.setMaster(masterLevel(useMediaVolumeStore.getState()))
			output.onStateChange(() => {
				this.checkOutput()
			})
			useSmoothTransitionsStore.subscribe((state, previous) => {
				if (state.prefs !== previous.prefs) {
					this.onPrefsChanged(state.prefs, previous.prefs)
				}
			})
		}
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

	// Every supersede of the current load goes through here, so its source download stops with it, and so does any
	// transition: the fading element and a fade still starting never outlive a stop or a replace.
	private bumpLoadGeneration(): number {
		this.loadAbort?.abort()
		this.loadAbort = null
		this.dropStarting()
		this.dropFading()

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

	// The decision the warm-up was made for while it still holds, else a fresh one.
	private committedOrCompute(): AdvanceResult | null {
		const committed = this.committed

		if (committed !== null && this.committedStill()) {
			return committed.advance
		}

		return computeNext(this.nav())
	}

	// The warm-up's decision still holds for the queue as it is now.
	private committedStill(): boolean {
		const state = useAudioStore.getState()

		return committedValid(this.committed, {
			queue: state.queue,
			currentIndex: state.currentIndex,
			loopMode: state.loopMode,
			shuffleEnabled: state.shuffleEnabled,
			shuffleOrder: state.shuffleOrder
		})
	}

	private commit(advance: AdvanceResult | null): void {
		const state = useAudioStore.getState()

		this.committed =
			advance === null
				? null
				: {
						advance,
						queue: state.queue,
						fromIndex: state.currentIndex,
						loopMode: state.loopMode,
						shuffleEnabled: state.shuffleEnabled,
						shuffleOrder: state.shuffleOrder
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

	// The outgoing element of a transition only reports its end (and data starvation, for the field log): it no
	// longer drives the transport.
	private fadingEvents(element: AudioElementAdapter): AudioElementEvents {
		return {
			onTimeUpdate: () => undefined,
			onDurationChange: () => undefined,
			onEnded: () => {
				this.onOutgoingEnded(element)
			},
			onError: () => undefined
		}
	}

	// Data starvation on either element while two streams play, for the field log.
	private watchOverlapStalls(fading: Fading, incoming: AudioElementAdapter, incomingSource: TrackSource | null): void {
		const routes = { outgoingRoute: fading.source?.route ?? "direct", incomingRoute: incomingSource?.route ?? "direct" }

		fading.element.watchStalls?.(kind => {
			log.info("audio", `${kind} during a transition (outgoing)`, routes)
		})
		incoming.watchStalls?.(kind => {
			if (this.fading === fading) {
				log.info("audio", `${kind} during a transition (incoming)`, routes)
			}
		})
	}

	// ── Smooth transitions: routing and levels ──

	private prefs(): SmoothTransitionsPrefs {
		return useSmoothTransitionsStore.getState().prefs
	}

	// The feature applies: present, on, and the output has not failed this session.
	private smoothOn(): boolean {
		const smooth = this.deps.smoothTransitions

		return smooth !== undefined && !this.degraded && this.prefs().enabled
	}

	private unlockOutput(): void {
		const smooth = this.deps.smoothTransitions

		if (smooth === undefined || !this.smoothOn()) {
			return
		}

		smooth.output.setKeepOpen(true)

		if (smooth.inGesture() || smooth.output.contextState !== "closed") {
			smooth.output.unlock()
		}
	}

	// Whether an element for `source` is routed now. A routed element on a context that cannot start would play
	// silence, so a load outside a gesture (the assistant, an auto-advance) on a stopped context stays unrouted.
	private eligible(source: TrackSource | null, element: AudioElementAdapter | null): boolean {
		const smooth = this.deps.smoothTransitions

		if (smooth === undefined || !this.smoothOn() || (element !== null && element.route === undefined)) {
			return false
		}

		if (smooth.webkit && source?.route === "session") {
			setSmoothTransitionsUnavailable("sourceIneligible")

			return false
		}

		if (!this.degraded) {
			setSmoothTransitionsUnavailable(null)
		}

		return smooth.output.usable
	}

	// The loudness trim the track at `index` plays at, and its peak after that trim. Album gain on a run of one
	// album played in order, track gain otherwise.
	private levelFor(index: number): { trim: number; peak: number } {
		const state = useAudioStore.getState()
		const track = state.queue[index]
		const tags = track ? getTrackTags(track.uuid) : undefined

		if (!this.smoothOn() || !this.prefs().matchLoudness) {
			return { trim: 1, peak: tags?.gain?.trackPeak ?? 1 }
		}

		if (track && tags?.parsed === true && tags.gain === undefined) {
			this.deps.smoothTransitions?.refreshGain?.(track)
		}

		const album =
			!state.shuffleEnabled &&
			tags !== undefined &&
			[index - 1, index + 1].some(neighbour => {
				const other = state.queue[neighbour]
				const otherTags = other ? getTrackTags(other.uuid) : undefined

				return otherTags !== undefined && sameRelease(tags, otherTags)
			})
		const { linear, peak } = replayGainFor(tags?.gain, { album })

		return { trim: linear, peak: (peak ?? 1) * linear }
	}

	private applyElementVolume(element: AudioElementAdapter, output: MediaVolume): void {
		element.setVolume(output.volume * Math.min(1, this.unroutedTrim.get(element) ?? 1))
		element.setMuted(output.muted)
	}

	// Routes `element` (the track at `index`) when it is eligible, else gives it its loudness through its volume.
	private prepareLevel(element: AudioElementAdapter, source: TrackSource | null, index: number): void {
		const level = this.levelFor(index)

		if (!this.routed.has(element) && this.eligible(source, element)) {
			this.route(element, level, 0)
		}

		const routed = this.routed.get(element)

		if (routed !== undefined) {
			routed.trim = level.trim
			routed.peak = level.peak
			routed.gain.setTrim(level.trim, 0)

			return
		}

		if (level.trim !== 1) {
			this.unroutedTrim.set(element, level.trim)
		} else {
			this.unroutedTrim.delete(element)
		}

		this.applyElementVolume(element, useMediaVolumeStore.getState())
	}

	// The loudness of an element already prepared (routed or not), for tags that arrived after it was prepared.
	private refreshLevel(element: AudioElementAdapter, index: number): void {
		const level = this.levelFor(index)
		const routed = this.routed.get(element)

		if (routed === undefined) {
			if (level.trim !== 1) {
				this.unroutedTrim.set(element, level.trim)
			} else {
				this.unroutedTrim.delete(element)
			}

			this.applyElementVolume(element, useMediaVolumeStore.getState())

			return
		}

		routed.peak = level.peak

		if (routed.trim !== level.trim) {
			routed.trim = level.trim
			routed.gain.setTrim(level.trim, 0)
		}
	}

	private route(element: AudioElementAdapter, level: { trim: number; peak: number }, rampSeconds: number): void {
		const smooth = this.deps.smoothTransitions
		const gain = smooth ? (element.route?.(smooth.output) ?? null) : null

		if (gain === null) {
			return
		}

		this.routed.set(element, { gain, trim: level.trim, peak: level.peak })
		this.unroutedTrim.delete(element)
		element.setVolume(1)
		element.setMuted(false)
		gain.holdFade(1)
		gain.setTrim(level.trim, rampSeconds)
	}

	// Every play() the engine issues starts at full fade level, so a prepared element promoted without a fade is
	// never silent.
	private resetFadeGain(element: AudioElementAdapter): void {
		this.routed.get(element)?.gain.holdFade(1)
	}

	private retire(element: AudioElementAdapter): void {
		element.pause()
		element.clear()
		element.dispose()
		this.routed.get(element)?.gain.release()
		this.routed.delete(element)
	}

	private onPrefsChanged(next: SmoothTransitionsPrefs, previous: SmoothTransitionsPrefs): void {
		const smooth = this.deps.smoothTransitions

		if (smooth === undefined) {
			return
		}

		this.planStale = true
		smooth.output.setKeepOpen(this.smoothOn())

		// Nothing loaded: the output starts with the next play instead of idling until then.
		if (next.enabled && !previous.enabled && this.element !== null) {
			this.unlockOutput()
		}

		if (!next.enabled) {
			this.plan = null
			this.clearTransitionTimer()

			// A source that could not be mixed no longer matters once the feature is off; a degrade holds for the session.
			if (!this.degraded) {
				setSmoothTransitionsUnavailable(null)
			}
		}

		if (next.enabled === previous.enabled && next.matchLoudness === previous.matchLoudness) {
			return
		}

		// Turned on mid-track: the live elements are routed now (inside the toggle's gesture), at most a buffer's
		// glitch. Loudness moves to the new trims, gently.
		const state = useAudioStore.getState()
		const live: [AudioElementAdapter | null, TrackSource | null, number | null][] = [
			[this.element, this.currentSource, state.currentIndex],
			[this.prefetchElement, this.prefetchSource, this.prefetchIndex]
		]

		for (const [element, source, index] of live) {
			if (element === null || index === null) {
				continue
			}

			const level = this.levelFor(index)
			const routed = this.routed.get(element)

			if (routed !== undefined) {
				routed.trim = level.trim
				routed.peak = level.peak
				routed.gain.setTrim(level.trim, TRIM_RAMP_SECONDS)
			} else if (this.eligible(source, element)) {
				this.route(element, level, element === this.element ? TRIM_RAMP_SECONDS : 0)
			} else {
				this.prepareLevel(element, source, index)
			}
		}
	}

	// ── Smooth transitions: edges and the plan ──

	private requestEdges(track: QueueTrack, source: TrackSource, cachedOnly: boolean): void {
		const smooth = this.deps.smoothTransitions

		if (smooth === undefined || !this.smoothOn() || this.knownEdges.has(track.uuid) || this.edgeReads.has(track.uuid)) {
			return
		}

		const abort = new AbortController()

		this.edgeReads.set(track.uuid, abort)
		void smooth.getEdges(track, source.route ?? "direct", abort.signal, { cachedOnly }).then(edges => {
			if (this.edgeReads.get(track.uuid) !== abort) {
				return
			}

			this.edgeReads.delete(track.uuid)
			this.knownEdges.set(track.uuid, edges)
			this.planStale = true
		})
	}

	// Forgets edges (and stops reading them) for every track that is neither current nor next.
	private pruneEdges(keep: readonly string[]): void {
		for (const uuid of [...this.knownEdges.keys()]) {
			if (!keep.includes(uuid)) {
				this.knownEdges.delete(uuid)
			}
		}

		for (const [uuid, abort] of [...this.edgeReads]) {
			if (!keep.includes(uuid)) {
				abort.abort()
				this.edgeReads.delete(uuid)
			}
		}
	}

	private incomingDurationMs(uuid: string): number {
		const sampled = this.prefetchElement?.sample().durationMs ?? 0

		if (Number.isFinite(sampled) && sampled > 0) {
			return sampled
		}

		const seconds = this.knownEdges.get(uuid)?.durationSec ?? getTrackTags(uuid)?.durationSec ?? null

		return seconds !== null ? seconds * 1000 : 0
	}

	// Re-derives the plan for the transition out of the current track into the warm one. Cheap and pure, so it
	// runs from `timeupdate` whenever something it depends on changed.
	private refreshPlan(sample: ElementSample): void {
		this.planStale = false

		const state = useAudioStore.getState()
		const advance = this.committedOrCompute()
		const out = state.queue[state.currentIndex]
		const incoming = advance ? state.queue[advance.index] : undefined

		if (
			!this.smoothOn() ||
			state.loopMode === "one" ||
			advance?.index !== this.prefetchIndex ||
			!out ||
			!incoming ||
			incoming.uuid === out.uuid
		) {
			this.setPlan(null)

			return
		}

		const inDurationMs = this.incomingDurationMs(incoming.uuid)

		// Not known yet: asked again on the next update rather than settling on "too short to fade".
		if (inDurationMs === 0) {
			this.planStale = true
		}

		const outTags = getTrackTags(out.uuid)
		const inTags = getTrackTags(incoming.uuid)

		this.setPlan(
			planTransition({
				out: { name: out.name, durationMs: sample.durationMs, album: outTags?.album ?? null, artist: outTags?.artist ?? null },
				in: { name: incoming.name, durationMs: inDurationMs, album: inTags?.album ?? null, artist: inTags?.artist ?? null },
				outEdges: this.knownEdges.get(out.uuid) ?? null,
				inEdges: this.knownEdges.get(incoming.uuid) ?? null,
				consecutive: !state.shuffleEnabled && advance.index === state.currentIndex + 1,
				fadeSeconds: this.prefs().fadeSeconds,
				gaplessOnly: this.gaplessOnlyUuid === out.uuid,
				// Half again as much as measured: starting early only lengthens the overlap, starting late leaves a gap.
				startLatencyMs: this.startLatencyMs * START_LATENCY_MARGIN
			})
		)

		if (this.plan === null && sample.durationMs <= 0) {
			this.planStale = true
		}
	}

	private setPlan(plan: TransitionPlan | null): void {
		this.plan = plan

		const warm = this.prefetchElement

		// The warm element waits where the incoming audio starts, sought before it buffers much. A gapless
		// transition (an album run) starts at 0:00.
		if (warm !== null && this.routed.has(warm)) {
			const startMs = plan?.kind === "crossfade" ? plan.inStartMs : 0

			if (startMs !== this.prefetchStartMs) {
				warm.seek(startMs / 1000)
				this.prefetchStartMs = startMs
			}
		}

		this.armTransitionTimer()
	}

	private clearTransitionTimer(): void {
		if (this.transitionTimer !== null) {
			clearTimeout(this.transitionTimer)
			this.transitionTimer = null
		}
	}

	// The backup for `timeupdate`, which can run late or (a micro-overlap) too coarsely.
	private armTransitionTimer(): void {
		this.clearTransitionTimer()

		const plan = this.plan
		const element = this.element

		if (plan === null || element === null || this.fading !== null || this.starting !== null) {
			return
		}

		const sample = element.sample()

		if (sample.paused) {
			return
		}

		const delay = plan.startAtMs - sample.currentTimeMs

		if (delay <= 0 || (plan.kind === "gapless" && delay > MICRO_OVERLAP_ARM_MS)) {
			return
		}

		this.transitionTimer = setTimeout(() => {
			this.transitionTimer = null

			if (this.element !== element) {
				return
			}

			this.maybeStartTransition(element.sample())

			// The media clock can run a little behind the timer: not due yet, so it waits again for what is left.
			if (this.starting === null && this.fading === null) {
				this.armTransitionTimer()
			}
		}, delay)
	}

	private maybeStartTransition(sample: ElementSample): void {
		const plan = this.plan

		if (plan === null || this.starting !== null || this.fading !== null || useAudioStore.getState().status !== "playing") {
			return
		}

		if (!shouldStartFade(sample, plan)) {
			return
		}

		// Only the decision the warm-up was made for: a changed queue, shuffle or loop mode re-derives it first.
		const advance = this.committed?.advance ?? null

		if (!this.committedStill() || advance?.index !== this.prefetchIndex) {
			void this.schedulePrefetch()

			return
		}

		void this.beginTransition(plan, advance)
	}

	// ── Smooth transitions: the overlap ──

	// Starts the warm element over the current one. Synchronously: the warm element leaves the prefetch slot (so
	// nothing promotes it twice) and the outgoing stops driving the transport. The swap itself waits for the
	// incoming's play() to resolve.
	private async beginTransition(plan: TransitionPlan, advance: AdvanceResult | null): Promise<void> {
		const outgoing = this.element
		const incoming = this.prefetchElement
		const index = this.prefetchIndex
		const outRouted = outgoing ? this.routed.get(outgoing) : undefined
		const inRouted = incoming ? this.routed.get(incoming) : undefined

		if (
			this.starting !== null ||
			this.fading !== null ||
			outgoing === null ||
			incoming === null ||
			index === null ||
			outRouted === undefined ||
			inRouted === undefined
		) {
			return
		}

		const uuid = useAudioStore.getState().queue[index]?.uuid

		if (uuid === undefined) {
			return
		}

		this.bumpLoadGeneration()

		const source = this.prefetchSource

		// Tags that arrived since the warm-up give the loudness trim it could not know then.
		this.refreshLevel(incoming, index)
		this.prefetchElement = null
		this.prefetchIndex = null
		this.prefetchSource = null
		this.prefetchAbort = null
		this.prefetchStartMs = 0
		this.plan = null
		this.clearTransitionTimer()
		outgoing.rebind(this.fadingEvents(outgoing))
		inRouted.gain.holdFade(0)

		const starting: Starting = { incoming, source, index, uuid, plan, advance, outgoingEnded: false }

		this.starting = starting

		const askedAt = this.now()

		try {
			await incoming.play()
		} catch (error) {
			if (this.starting === starting) {
				this.failTransition(starting, error)
			}

			return
		}

		if (this.starting === starting) {
			this.completeTransition(starting, outRouted, inRouted, askedAt)
		}
	}

	private failTransition(starting: Starting, error: unknown): void {
		const outgoing = this.element

		this.starting = null
		log.warn("audio", "the incoming track of a transition did not start", error)
		this.retire(starting.incoming)
		starting.source?.release()

		if (outgoing === null) {
			return
		}

		outgoing.rebind(this.playbackEvents())

		// A skip the user asked for already named the target: it loads cold rather than the old track playing on
		// under its title.
		if (starting.advance === null) {
			void this.loadAndPlay(useAudioStore.getState().currentIndex)

			return
		}

		// The outgoing ended while the incoming's play() was pending: the track change happens now, cold.
		if (starting.outgoingEnded) {
			void this.handleTrackEnd()
		}
	}

	private completeTransition(starting: Starting, outRouted: Routed, inRouted: Routed, askedAt: number): void {
		const outgoing = this.element
		const state = useAudioStore.getState()
		const track = starting.advance ? state.queue[starting.advance.index] : state.queue[state.currentIndex]

		// The queue, the shuffle or the loop mode changed while the incoming was starting: the decision no longer
		// holds. The incoming waits as the warm element again (if it still is the next track) and the outgoing plays on.
		if (outgoing === null || track?.uuid !== starting.uuid || (starting.advance !== null && !this.committedStill())) {
			this.parkStarting()

			if (starting.outgoingEnded) {
				void this.handleTrackEnd()
			} else {
				void this.schedulePrefetch()
			}

			return
		}

		this.starting = null

		const outgoingSource = this.currentSource

		if (starting.outgoingEnded) {
			inRouted.gain.holdFade(1)
			this.retire(outgoing)
			outgoingSource?.release()
		} else {
			// The outgoing plays on at full level until the incoming is heard; the curves start then.
			const fading = this.startFading(
				outgoing,
				outgoingSource,
				starting.plan.stopAtMs - outgoing.sample().currentTimeMs + AUDIBLE_TIMEOUT_MS
			)
			const plan = starting.plan

			this.watchOverlapStalls(fading, starting.incoming, starting.source)
			void inRouted.gain.whenAudible(AUDIBLE_TIMEOUT_MS).then(heard => {
				// Only a start that was heard measures the latency: a track opening with silence would inflate it.
				if (heard) {
					this.measureStartLatency(askedAt)
				}

				this.crossOnceAudible(fading, starting.incoming, outRouted, inRouted, plan, starting.advance === null)
			})
		}

		// The incoming is the current track from here: the store, the scrubber and the Media Session switch at fade
		// start. The outgoing's source stays alive with the fading element.
		this.element = starting.incoming
		this.currentSource = starting.source
		this.loadedTrackUuid = track.uuid
		starting.incoming.rebind(this.playbackEvents())

		if (starting.advance !== null) {
			this.applyAdvance(starting.advance)
		}

		this.publishMetadata(track)
		this.onDurationChange()
		// With nothing fading the next track warms now; otherwise when the fade is over.
		this.settlePlaying(starting.incoming, this.fading === null)
	}

	// The incoming is heard: both curves start, the outgoing's over what is left of it (however late the incoming
	// arrived), the incoming's over the fade (a gapless switch: over the same short remainder).
	private crossOnceAudible(
		fading: Fading,
		incoming: AudioElementAdapter,
		outRouted: Routed,
		inRouted: Routed,
		plan: TransitionPlan,
		manual: boolean
	): void {
		const smooth = this.deps.smoothTransitions

		if (this.element !== incoming || smooth === undefined) {
			return
		}

		// The outgoing went first (it ended, or a seek dropped it): the incoming plays on alone at full level.
		if (this.fading !== fading) {
			inRouted.gain.holdFade(1)

			return
		}

		// A skip the user asked for fades over its full length from here; a natural transition must be over where the
		// outgoing's audio ends.
		const outRemainingMs = manual ? plan.inFadeMs : plan.stopAtMs - fading.element.sample().currentTimeMs

		// Nothing left of the outgoing to cross with: the incoming plays at full level at once.
		if (outRemainingMs <= CURVE_LEAD_SECONDS * 1000) {
			inRouted.gain.holdFade(1)
			this.finishFade(fading)

			return
		}

		const t0 = smooth.output.contextSeconds + CURVE_LEAD_SECONDS
		const curves = fadeCurves(outRouted.peak, inRouted.peak)
		const inFadeMs = plan.kind === "gapless" ? outRemainingMs : plan.inFadeMs

		inRouted.gain.scheduleFade(curves.in, t0, inFadeMs / 1000)
		outRouted.gain.scheduleFade(curves.out, t0, outRemainingMs / 1000)
		this.rescheduleFadeEnd(fading, outRemainingMs)
	}

	private measureStartLatency(askedAt: number): void {
		const measured = this.now() - askedAt

		this.startLatencyMs = Math.min(
			MAX_START_LATENCY_MS,
			Math.max(this.minStartLatencyMs, this.startLatencyMs + (measured - this.startLatencyMs) * START_LATENCY_WEIGHT)
		)
	}

	private rescheduleFadeEnd(fading: Fading, durationMs: number): void {
		if (fading.timer !== null) {
			clearTimeout(fading.timer)
		}

		fading.endsAt = this.now() + durationMs
		fading.timer = setTimeout(() => {
			this.finishFade(fading)
		}, durationMs + 50)
	}

	private startFading(element: AudioElementAdapter, source: TrackSource | null, durationMs: number): Fading {
		element.rebind(this.fadingEvents(element))

		const fading: Fading = { element, source, timer: null, endsAt: this.now() + durationMs }

		fading.timer = setTimeout(() => {
			this.finishFade(fading)
		}, durationMs + 50)
		this.fading = fading

		return fading
	}

	private onOutgoingEnded(element: AudioElementAdapter): void {
		if (this.starting !== null && this.element === element) {
			this.starting.outgoingEnded = true

			return
		}

		if (this.fading?.element === element) {
			this.finishFade(this.fading)
		}
	}

	private finishFade(fading: Fading): void {
		if (this.fading !== fading) {
			return
		}

		this.dropFading()
		void this.schedulePrefetch()
	}

	private dropFading(): void {
		const fading = this.fading

		if (fading === null) {
			return
		}

		this.fading = null

		if (fading.timer !== null) {
			clearTimeout(fading.timer)
		}

		fading.element.watchStalls?.(null)
		this.element?.watchStalls?.(null)
		this.retire(fading.element)
		fading.source?.release()
	}

	// A newer load superseded a transition still starting: its incoming element goes, the outgoing (still the main
	// element) reports to the transport again.
	private dropStarting(): void {
		const starting = this.starting

		if (starting === null) {
			return
		}

		this.starting = null
		this.retire(starting.incoming)
		starting.source?.release()
		this.element?.rebind(this.playbackEvents())
	}

	// A pause while the incoming's play() is pending: the incoming goes back to being the warm element, so resuming
	// inside the window starts the transition again.
	private parkStarting(): void {
		const starting = this.starting

		if (starting === null) {
			return
		}

		this.starting = null
		starting.incoming.pause()
		this.resetFadeGain(starting.incoming)
		this.element?.rebind(this.playbackEvents())

		if (
			this.prefetchElement === null &&
			starting.advance !== null &&
			useAudioStore.getState().queue[starting.index]?.uuid === starting.uuid
		) {
			// Back where the incoming audio starts, so a restarted transition is not late into it.
			starting.incoming.seek(starting.plan.inStartMs / 1000)
			this.prefetchElement = starting.incoming
			this.prefetchSource = starting.source
			this.prefetchIndex = starting.index
			this.prefetchStartMs = starting.plan.inStartMs
			this.planStale = true

			return
		}

		this.retire(starting.incoming)
		starting.source?.release()
	}

	// ── Smooth transitions: the output watchdog ──

	// `sample` is the current element's, when the caller just read it.
	private checkOutput(sample?: ElementSample): void {
		const smooth = this.deps.smoothTransitions
		const element = this.element

		if (smooth === undefined || this.degraded || element === null || !this.routed.has(element)) {
			return
		}

		const step = watchdogStep(this.watchdog, {
			wallMs: this.now(),
			contextSeconds: smooth.output.contextSeconds,
			elementMs: (sample ?? element.sample()).currentTimeMs,
			contextState: smooth.output.contextState,
			wantPlaying: useAudioStore.getState().status === "playing",
			selfSuspended: smooth.output.selfSuspended
		})

		this.watchdog = step.state

		if (step.action === "resume") {
			log.warn("audio", `audio output ${smooth.output.contextState}, resuming`)
			smooth.output.resume()
		} else if (step.action === "degrade") {
			this.degradeOutput()
		}
	}

	// The output stopped rendering and a resume did not bring it back: the current track reloads into a plain
	// element at its position and the rest of the session plays unrouted.
	private degradeOutput(): void {
		const smooth = this.deps.smoothTransitions
		const element = this.element

		if (smooth === undefined || this.degraded) {
			return
		}

		log.warn("audio", "audio output stopped rendering; playing without smooth transitions for this session")
		this.degraded = true
		setSmoothTransitionsUnavailable("degraded")
		smooth.output.setKeepOpen(false)
		this.teardownPrefetch()
		this.bumpLoadGeneration()

		const state = useAudioStore.getState()
		const current = state.queue[state.currentIndex]

		if (element === null || !this.routed.has(element) || current?.uuid !== this.loadedTrackUuid) {
			return
		}

		this.pendingResume = { uuid: current.uuid, ms: element.sample().currentTimeMs }

		if (state.status !== "playing" && state.status !== "loading") {
			this.loadedTrackUuid = null

			return
		}

		void this.loadAndPlay(state.currentIndex, { degrade: true })
	}

	// ── Playback ──

	// Shared play-start tail: a failure or success that lands after a supersede (new load or pause) is
	// dropped silently.
	private async playAndSettle(
		element: AudioElementAdapter,
		generation: number,
		pauseGeneration: number,
		options: LoadOptions = {}
	): Promise<void> {
		const fadeIn = this.fading !== null && options.manual === true

		if (fadeIn) {
			this.routed.get(element)?.gain.holdFade(0)
		} else {
			this.resetFadeGain(element)
		}

		try {
			await element.play()
		} catch (error) {
			if (this.superseded(generation, pauseGeneration)) {
				return
			}

			if (options.degrade === true) {
				this.holdAfterRefusedPlay(error)

				return
			}

			this.onPlaybackFailure(asErrorDTO(error))

			return
		}

		if (this.superseded(generation, pauseGeneration)) {
			return
		}

		if (fadeIn) {
			this.fadeInto(element)
		}

		this.settlePlaying(element)
	}

	// The degrade reload was refused (no gesture in a background tab): the track holds paused at its position and
	// plays on the next resume (a lock-screen play, a return to the tab).
	private holdAfterRefusedPlay(error: unknown): void {
		log.warn("audio", "the reload of a degraded output was refused", error)
		this.degradeRetry = true
		useAudioStore.getState().setStatus("paused")
		this.deps.mediaSession?.setPlaybackState("paused")
	}

	private ensureElement(source: TrackSource | null): AudioElementAdapter {
		// Routing is permanent: an element routed for a feature that no longer applies (turned off, degraded), or a
		// plain one where routing now applies, is replaced rather than reused.
		if (this.element && this.routed.has(this.element) !== this.eligible(source, this.element)) {
			this.retire(this.element)
			this.element = null
		}

		if (this.element) {
			return this.element
		}

		const element = this.deps.createElement(this.playbackEvents())

		this.applyElementVolume(element, useMediaVolumeStore.getState())
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
		// The element these events belong to, so a late error from one already torn down touches nothing.
		const own: { element: AudioElementAdapter | null } = { element: null }
		const element = factory({
			onTimeUpdate: () => undefined,
			onDurationChange: () => undefined,
			onEnded: () => undefined,
			onError: failure => {
				const failed = this.prefetchElement
				const source = this.prefetchSource

				if (failed === null || failed !== own.element) {
					return
				}

				// Out of the slot at once, so nothing promotes an element that failed: the track loads cold when it
				// comes up. The element and its source are kept until the failure is classified (emptying the
				// element clears its error, releasing the source takes the stream the classification reads); a
				// format the browser cannot play makes the track resolve to its other route.
				this.prefetchElement = null
				this.prefetchSource = null
				this.teardownPrefetch()
				void failure()
					.then(error => {
						if (error?.kind === MEDIA_FORMAT_UNSUPPORTED) {
							source?.demote?.()
						}
					})
					.catch(() => undefined)
					.finally(() => {
						this.retire(failed)
						source?.release()
					})
			}
		})

		own.element = element
		this.applyElementVolume(element, useMediaVolumeStore.getState())
		this.prefetchElement = element

		return element
	}

	// Tears down whatever is currently warmed (element paused/cleared/disposed, its source released) and
	// forgets which index it held. Safe to call when nothing is warmed. Called before every reschedule —
	// this module keeps at most ONE element ahead, never more. Also bumps the generation counter so a
	// schedulePrefetch continuation still awaiting resolveSource when the teardown ran can never
	// repopulate the slot afterwards: without the bump, a warm-up left in flight by a superseded queue
	// would survive the teardown, resurrect a dead element, and a later promotion by raw-index
	// coincidence would play the wrong track's bytes. The transition prepared for it goes with it.
	private teardownPrefetch(): void {
		this.prefetchGeneration++
		this.prefetchAbort?.abort()
		this.prefetchAbort = null
		this.prefetchPendingIndex = null

		if (this.prefetchElement) {
			this.retire(this.prefetchElement)
		}

		this.prefetchElement = null
		this.prefetchIndex = null
		this.prefetchStartMs = 0

		this.prefetchSource?.release()
		this.prefetchSource = null
		this.committed = null
		this.plan = null
		this.planStale = true
		this.clearTransitionTimer()
	}

	// Re-derives "what should be warmed next" from the live queue/nav state and, if it differs from what
	// is already warmed, tears down the stale warm-up and resolves+loads the new one. A no-op when no
	// prefetch dep was supplied (createPrefetchElement absent), when there is nowhere to advance to, or
	// when the target is already warm. Never throws, never surfaces an error — prefetch is a pure nicety,
	// a failure here just costs the next track a cold-start beat. Waits while a transition runs: two
	// elements are already playing, and the fade's end schedules this again.
	private async schedulePrefetch(): Promise<void> {
		if (!this.deps.createPrefetchElement || this.fading !== null || this.starting !== null) {
			return
		}

		const advance = computeNext(this.nav())

		if (advance === null) {
			this.teardownPrefetch()

			return
		}

		// The decision is refreshed even when the warm element stays: the shuffle order behind it may have changed.
		if (advance.index === this.prefetchIndex || advance.index === this.prefetchPendingIndex) {
			this.commit(advance)
			this.planStale = true

			return
		}

		this.teardownPrefetch()
		this.commit(advance)

		const state = useAudioStore.getState()
		const track = state.queue[advance.index]
		const current = state.queue[state.currentIndex]

		this.pruneEdges([current?.uuid ?? "", track?.uuid ?? ""])

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
			source.release()

			return
		}

		this.prefetchPendingIndex = null

		this.scheduleMetadata(track)

		const element = this.ensurePrefetchElement()

		this.prefetchSource = source
		this.prepareLevel(element, source, advance.index)
		element.load(source)
		this.prefetchIndex = advance.index
		this.planStale = true

		// Only the incoming track is analysed: one read gives its head now and its tail for when it is the outgoing.
		this.requestEdges(track, source, false)

		if (current && this.currentSource) {
			this.requestEdges(current, this.currentSource, true)
		}
	}

	// Swaps the warmed element into the "now playing" slot: rebinds it to the real playback events,
	// retires the outgoing main element, and plays. Preserves whatever the browser already
	// buffered/decoded for the promoted element instead of resolving+loading from scratch.
	private async promotePrefetch(index: number, options: LoadOptions): Promise<void> {
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

		// A track the user picked starts at 0:00, not past its leading silence.
		if (options.manual === true && this.prefetchStartMs > 0) {
			promoted.seek(0)
		}

		this.refreshLevel(promoted, index)

		// Detach bookkeeping from the prefetch slot before touching the element — teardownPrefetch would
		// otherwise dispose the very element being promoted.
		this.prefetchElement = null
		const promotedSource = this.prefetchIndex === index ? this.prefetchSource : null
		this.prefetchIndex = null
		this.prefetchSource = null
		this.prefetchAbort = null
		this.prefetchStartMs = 0

		promoted.rebind(this.playbackEvents())
		this.swapSource(promotedSource)

		const outgoing = this.element

		this.element = promoted
		this.loadedTrackUuid = track.uuid

		if (outgoing) {
			this.retire(outgoing)
		}

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
	private settlePlaying(element: AudioElementAdapter, prefetch = true): void {
		this.skipGuard = 0
		this.lastPositionWriteAt = 0
		this.degradeRetry = false
		this.gaplessOnlyUuid = null
		this.planStale = true
		// A stall on the track before still counts: two within a minute degrade, whichever tracks they hit.
		this.watchdog = { ...INITIAL_WATCHDOG_STATE, lastStallMs: this.watchdog.lastStallMs }
		this.clearIdleClose()
		useAudioStore.getState().setError(null)
		useAudioStore.getState().setStatus("playing")
		this.deps.mediaSession?.setPlaybackState("playing")
		this.deps.mediaSession?.setPositionState(element.sample())
		this.deps.smoothTransitions?.output.active()

		if (prefetch) {
			void this.schedulePrefetch()
		}
	}

	// Kicks off the cover (and, with it, tag) read for `track`. Skipped when the track's tags are known and
	// either it has no cover or its cover is still in the cache; a cover the LRU evicted is read again,
	// from the thumbnail cache when it is there, so a revisit normally costs no download. A no-op when no
	// resolveCover dep was supplied.
	private scheduleMetadata(track: QueueTrack): void {
		if (!this.deps.resolveCover) {
			return
		}

		const known = getTrackTags(track.uuid)

		if (known !== undefined && (!known.cover || this.coverCache.get(track.uuid) !== undefined)) {
			return
		}

		void this.deps.resolveCover(track).then(result => {
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
		const element = this.element

		if (!element) {
			return
		}

		// The transition trigger and the output watchdog run on every update; only the store write is throttled.
		if (this.deps.smoothTransitions && (this.smoothOn() || this.routed.has(element))) {
			const live = element.sample()

			if (this.planStale) {
				this.refreshPlan(live)
			}

			this.maybeStartTransition(live)

			if (this.plan?.kind === "gapless" && this.transitionTimer === null) {
				this.armTransitionTimer()
			}

			this.checkOutput(live)
		}

		const now = this.now()

		if (now - this.lastPositionWriteAt < POSITION_WRITE_THROTTLE_MS) {
			return
		}

		this.lastPositionWriteAt = now

		const sample = element.sample()

		useAudioStore.getState().setPosition(Math.max(0, sample.currentTimeMs))
		// WebKit's GStreamer backend can announce a duration of 0 and then learn the real one without a
		// second `durationchange` (a header-less MP3 whose length it estimates), which would leave the
		// scrubber dead for the whole track. The sample read here already carries it, so it is picked up
		// on the next position write.
		this.applyDuration(sample.durationMs)
		this.deps.mediaSession?.setPositionState(sample)
	}

	private onDurationChange(): void {
		if (!this.element) {
			return
		}

		this.planStale = true
		this.applyDuration(this.element.sample().durationMs)
	}

	// Writes the element's duration (0 while unknown) to the store when it differs from what is there.
	private applyDuration(sampledMs: number): void {
		const known = Number.isFinite(sampledMs) && sampledMs > 0
		const durationMs = known ? sampledMs : 0

		if (durationMs === useAudioStore.getState().durationMs) {
			return
		}

		useAudioStore.getState().setDuration(durationMs)

		if (known && this.loadedTrackUuid !== null) {
			backfillTrackDuration(this.loadedTrackUuid, durationMs / 1000)
		}
	}

	// A "short fade" skip wants a fade when the feature is on, the current track plays routed, and no transition
	// is running.
	private manualFadeWanted(options: LoadOptions): boolean {
		return (
			options.manual === true &&
			this.smoothOn() &&
			this.prefs().manualTransition === "fade" &&
			useAudioStore.getState().status === "playing" &&
			this.element !== null &&
			this.routed.has(this.element) &&
			this.fading === null &&
			this.starting === null
		)
	}

	// A "short fade" skip to a track that is not warm: the current element keeps playing as the fading one while
	// the target loads cold into a fresh element; no third element is ever made. If the target is not playing in
	// time, the outgoing fades out on its own.
	private handOffForManualFade(): void {
		const outgoing = this.element

		if (outgoing === null) {
			return
		}

		this.element = null
		this.loadedTrackUuid = null

		const fading: Fading = { element: outgoing, source: this.currentSource, timer: null, endsAt: Number.POSITIVE_INFINITY }

		this.currentSource = null
		outgoing.rebind(this.fadingEvents(outgoing))
		fading.timer = setTimeout(() => {
			this.fadeOutAlone(fading)
		}, MANUAL_FADE_TARGET_TIMEOUT_MS)
		this.fading = fading
	}

	private fadeOutAlone(fading: Fading): void {
		const smooth = this.deps.smoothTransitions
		const routed = this.routed.get(fading.element)

		if (this.fading !== fading || smooth === undefined || routed === undefined) {
			return
		}

		routed.gain.scheduleFade(fadeCurves(routed.peak, 0).out, smooth.output.contextSeconds + CURVE_LEAD_SECONDS, MANUAL_FADE_MS / 1000)
		fading.endsAt = this.now() + MANUAL_FADE_MS
		fading.timer = setTimeout(() => {
			this.finishFade(fading)
		}, MANUAL_FADE_MS + 50)
	}

	// The cold target of a "short fade" skip started: both gains move over the short fade.
	private fadeInto(element: AudioElementAdapter): void {
		const smooth = this.deps.smoothTransitions
		const fading = this.fading
		const outRouted = fading ? this.routed.get(fading.element) : undefined
		const inRouted = this.routed.get(element)

		if (smooth === undefined || fading === null || outRouted === undefined || inRouted === undefined) {
			this.dropFading()
			this.resetFadeGain(element)

			return
		}

		if (fading.timer !== null) {
			clearTimeout(fading.timer)
			fading.timer = null
		}

		this.watchOverlapStalls(fading, element, this.currentSource)
		void inRouted.gain.whenAudible(AUDIBLE_TIMEOUT_MS).then(() => {
			if (this.element !== element) {
				return
			}

			if (this.fading !== fading) {
				inRouted.gain.holdFade(1)

				return
			}

			const t0 = smooth.output.contextSeconds + CURVE_LEAD_SECONDS
			const curves = fadeCurves(outRouted.peak, inRouted.peak)

			outRouted.gain.scheduleFade(curves.out, t0, MANUAL_FADE_MS / 1000)
			inRouted.gain.scheduleFade(curves.in, t0, MANUAL_FADE_MS / 1000)
			this.rescheduleFadeEnd(fading, MANUAL_FADE_MS)
		})
	}

	// Move to `index` and start it. If it is already warmed by the prefetch element, promote it instead
	// (no re-resolve, no reload). Otherwise the cold-start path: resolve a source (a service worker stream,
	// or a MediaSource session without one), swap it onto the element, play. Every await re-checks the
	// generation so a superseding load/skip/dispose bails cleanly; a source resolved for a superseded load is
	// released. A pause is NOT a supersede: the resolved bytes still land on the element, only the
	// playing is dropped. A resolve error or a rejected play() routes into the bounded auto-skip.
	private async loadAndPlay(index: number, options: LoadOptions = {}): Promise<void> {
		const manualFade = this.manualFadeWanted(options)

		if (index === this.prefetchIndex && this.prefetchElement) {
			if (manualFade && this.routed.has(this.prefetchElement)) {
				if (this.prefetchStartMs > 0) {
					this.prefetchElement.seek(0)
				}

				await this.beginTransition(manualFadePlan(this.element?.sample().currentTimeMs ?? 0), null)

				return
			}

			await this.promotePrefetch(index, options)

			return
		}

		if (manualFade) {
			this.teardownPrefetch()
		}

		const generation = this.bumpLoadGeneration()
		const pauseGeneration = this.pauseGeneration
		const track = useAudioStore.getState().queue[index]

		if (!track) {
			return
		}

		if (manualFade) {
			this.handOffForManualFade()
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
			source.release()

			return
		}

		this.scheduleMetadata(track)

		const element = this.ensureElement(source)

		this.swapSource(source)
		this.prepareLevel(element, source, index)
		element.load(source)
		this.loadedTrackUuid = track.uuid

		if (this.pendingResume?.uuid === track.uuid) {
			element.seek(this.pendingResume.ms / 1000)
			useAudioStore.getState().setPosition(this.pendingResume.ms)
		}

		this.pendingResume = null

		// The fresh element could not be routed after all: a cut instead of a fade.
		if (this.fading !== null && !this.routed.has(element)) {
			this.dropFading()
		}

		// Paused while this was resolving: the bytes stay on the element — that is what gives the paused
		// track a duration and a live scrubber, and what lets resume() replay it without a second download
		// — but the playback the user just refused never starts.
		if (this.pauseGeneration !== pauseGeneration) {
			return
		}

		await this.playAndSettle(element, generation, pauseGeneration, options)
	}

	// Releases the outgoing source when another replaces it (or none, `null`).
	private swapSource(source: TrackSource | null): void {
		if (this.currentSource !== null && this.currentSource !== source) {
			this.currentSource.release()
		}

		this.currentSource = source
	}

	// A track failed to load or play. Surface it LABEL-FIRST, then bounded auto-skip: increment the
	// guard, and once a full pass over the queue is exhausted settle instead of spinning. Otherwise
	// advance to the next track and try it.
	private onPlaybackFailure(error: ErrorDTO): void {
		if (this.retryDemoted(error)) {
			return
		}

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

		const advance = withinSkipBudget(this.skipGuard, state.queue.length) ? this.committedOrCompute() : null

		this.reportFormatFailure(error, track, advance === null)

		if (advance === null) {
			this.settleStopped()

			return
		}

		this.applyAdvance(advance)
		void this.loadAndPlay(advance.index)
	}

	// The browser cannot play the current track as it is, but its source has another route (its audio
	// decoded): the source is demoted and the track loaded again, from where it stood. Once only: the route
	// it falls back to has none.
	private retryDemoted(error: ErrorDTO): boolean {
		const source = this.currentSource
		const state = useAudioStore.getState()

		if (
			error.kind !== MEDIA_FORMAT_UNSUPPORTED ||
			source?.demote === undefined ||
			this.demoted.has(source) ||
			state.queue[state.currentIndex]?.uuid !== this.loadedTrackUuid
		) {
			return false
		}

		this.demoted.add(source)
		source.demote()

		// Paused (the user paused while the track loaded): nothing plays now; the element no longer counts as
		// holding the track, so resuming loads it again, through the route it now resolves to.
		if (state.status === "paused") {
			this.loadedTrackUuid = null

			return true
		}

		const resumeAt = this.element?.sample().currentTimeMs ?? 0

		void this.loadAndPlay(state.currentIndex).then(() => {
			if (resumeAt > 0 && useAudioStore.getState().queue[useAudioStore.getState().currentIndex]?.uuid === this.loadedTrackUuid) {
				this.element?.seek(resumeAt / 1000)
			}
		})

		return true
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
		this.deps.smoothTransitions?.output.idle()

		// Stopped at the start: on WebKit, whose context never suspends itself, the output goes now.
		if (this.deps.smoothTransitions?.webkit === true) {
			this.releaseIdleOutput(false)
		}
	}

	private clearIdleClose(): void {
		if (this.idleCloseTimer !== null) {
			clearTimeout(this.idleCloseTimer)
			this.idleCloseTimer = null
		}
	}

	// Hands a paused routed element back and closes the output when nothing else holds it. The track reloads on the
	// next play (a gesture, which starts a new context), from where it stood when `keepPosition`.
	private releaseIdleOutput(keepPosition: boolean): void {
		const element = this.element

		this.clearIdleClose()

		if (element === null || !this.routed.has(element) || useAudioStore.getState().status === "playing") {
			return
		}

		if (keepPosition && this.loadedTrackUuid !== null) {
			this.pendingResume = { uuid: this.loadedTrackUuid, ms: element.sample().currentTimeMs }
		}

		this.teardownPrefetch()
		this.retire(element)
		this.element = null
		this.loadedTrackUuid = null
		this.swapSource(null)
		this.deps.smoothTransitions?.output.closeIfUnused()
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

		const advance = this.committedOrCompute()

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

	// Loop "one": replay the element in place. Reloading would re-resolve the source on every lap — a fresh
	// SW registration, or a fresh decode — and throw away whatever the browser had already buffered.
	// Prefetch can never cover this: it warms what comes AFTER the current track. Falls back to a cold load
	// only when the element no longer holds this track.
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
		this.unlockOutput()

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
		this.unlockOutput()

		if (useAudioStore.getState().queue.length === 0) {
			return
		}

		await this.loadAndPlay(useAudioStore.getState().currentIndex)
	}

	// Resume an already-loaded element in place. When the element holds anything other than the current
	// track — nothing yet, or the previous track because a load was paused/superseded mid-flight — this
	// starts the current track instead of replaying stale bytes.
	public resume(): void {
		this.clearIdleClose()
		this.unlockOutput()

		const state = useAudioStore.getState()
		const current = state.queue[state.currentIndex]

		if (!this.element || current?.uuid !== this.loadedTrackUuid) {
			void this.playCurrent()

			return
		}

		const generation = this.loadGeneration
		const pauseGeneration = this.pauseGeneration
		const element = this.element

		state.setStatus("playing")
		this.deps.mediaSession?.setPlaybackState("playing")
		this.resetFadeGain(element)
		this.deps.smoothTransitions?.output.active()
		void element.play().then(
			() => {
				if (!this.superseded(generation, pauseGeneration)) {
					this.degradeRetry = false
					this.armTransitionTimer()

					if (this.prefetchElement === null) {
						void this.schedulePrefetch()
					}
				}
			},
			(error: unknown) => {
				// A pause landing before this settles rejects it with AbortError; that is the user's own doing,
				// not a broken track, so it must not surface an error or trigger the auto-skip. Nor may a
				// failure the element's error event already reported (and skipped past) count twice.
				if (this.superseded(generation, pauseGeneration)) {
					return
				}

				if (this.degradeRetry) {
					this.holdAfterRefusedPlay(error)

					return
				}

				this.onPlaybackFailure(asErrorDTO(error))
			}
		)
	}

	// Pausing supersedes the PLAYBACK an in-flight load is heading for, not the load itself: without the
	// bump, a load that resolves after this settles to "playing" and starts audio the user just refused —
	// and the element.pause() below would reject that load's own play() promise, surfacing a playback
	// error and auto-skipping to another track. The load still finishes onto the element, so the paused
	// track keeps a duration/scrubber and resume() replays it without re-downloading it. A transition stops
	// with the pause: the outgoing goes, the current plays on alone at full level on resume.
	public pause(): void {
		this.pauseGeneration++
		this.parkStarting()

		const hadFade = this.fading !== null

		this.dropFading()
		this.clearTransitionTimer()
		this.element?.pause()

		if (this.element) {
			this.resetFadeGain(this.element)
		}

		useAudioStore.getState().setStatus("paused")
		this.deps.mediaSession?.setPlaybackState("paused")
		this.deps.smoothTransitions?.output.idle()

		// The fade held the next warm-up back; it warms now, so a resume has its transition again.
		if (hadFade) {
			void this.schedulePrefetch()
		}

		if (this.deps.smoothTransitions?.webkit === true && this.element !== null && this.routed.has(this.element)) {
			this.clearIdleClose()
			this.idleCloseTimer = setTimeout(() => {
				this.idleCloseTimer = null
				this.releaseIdleOutput(true)
			}, WEBKIT_IDLE_CLOSE_MS)
		}
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

	// A seek during a transition drops the outgoing; a seek into the coming transition's window plays the track
	// out instead (gapless into the next one).
	public seek(seconds: number): void {
		const targetMs = Math.max(0, seconds * 1000)

		// A skip the user asked for is still starting: the seek is into the target, which loads there cold.
		if (this.starting?.advance === null) {
			const state = useAudioStore.getState()
			const target = state.queue[state.currentIndex]

			this.dropStarting()

			if (target) {
				this.pendingResume = { uuid: target.uuid, ms: targetMs }
				useAudioStore.getState().setPosition(targetMs)
				void this.loadAndPlay(state.currentIndex)
			}

			return
		}

		this.parkStarting()

		if (this.fading !== null) {
			this.dropFading()

			if (this.element) {
				this.resetFadeGain(this.element)
			}

			void this.schedulePrefetch()
		}

		if (this.plan !== null && seekCancelsCrossfade(targetMs, this.plan)) {
			this.gaplessOnlyUuid = this.loadedTrackUuid
		}

		this.planStale = true
		this.element?.seek(seconds)
		useAudioStore.getState().setPosition(targetMs)

		if (this.element) {
			this.deps.mediaSession?.setPositionState(this.element.sample())
		}

		this.armTransitionTimer()
	}

	public async skipNext(): Promise<void> {
		this.unlockOutput()

		const advance = this.committedOrCompute()

		if (advance === null) {
			this.settleStopped()

			return
		}

		this.applyAdvance(advance)
		await this.loadAndPlay(advance.index, { manual: true })
	}

	public async skipPrevious(): Promise<void> {
		this.unlockOutput()

		const positionMs = this.element ? this.element.sample().currentTimeMs : useAudioStore.getState().positionMs
		const result = smartPrevious(this.nav(), positionMs)

		if (result.kind === "restart") {
			this.seek(0)

			return
		}

		useAudioStore.getState().setCurrent(result.index, result.shuffleOrder)
		await this.loadAndPlay(result.index, { manual: true })
	}

	// Jump straight to a queued track (a now-playing-panel click-to-jump). Re-anchors the shuffle order at
	// the target so shuffle-next continues from there, then loads and plays it.
	public async playIndex(index: number): Promise<void> {
		this.unlockOutput()

		const state = useAudioStore.getState()

		if (index < 0 || index >= state.queue.length) {
			return
		}

		const order = state.shuffleEnabled ? buildShuffleOrder(state.queue.length, index) : []

		state.setCurrent(index, order)
		await this.loadAndPlay(index, { manual: true })
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
		// A transition starting into a track the removal moved or took waits, or goes (parkStarting checks the uuid).
		this.parkStarting()
		void this.schedulePrefetch()
	}

	// Empty the queue and stop — the mini-player disappears (the shell renders it only for a non-empty
	// queue). Supersedes any in-flight load, releases the live source, and clears the OS metadata; the
	// persisted shuffle/loop prefs survive (store.reset keeps them). A routed element goes with the queue, so
	// the output can close.
	public clearQueue(): void {
		this.clearIdleClose()
		this.bumpLoadGeneration()
		this.element?.pause()
		this.element?.clear()

		if (this.element && this.routed.has(this.element)) {
			this.retire(this.element)
			this.element = null
		}

		this.loadedTrackUuid = null
		this.teardownPrefetch()
		this.pruneEdges([])

		this.swapSource(null)

		this.skipGuard = 0
		this.lastPositionWriteAt = 0
		this.gaplessOnlyUuid = null
		this.pendingResume = null
		useAudioStore.getState().reset()
		this.deps.mediaSession?.setMetadata(null)
		this.deps.mediaSession?.setPlaybackState("none")
		this.deps.smoothTransitions?.output.closeIfUnused()
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
		this.planStale = true
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

	// A fade whose timer the hidden tab held back is over by now.
	private finishFadeIfDue(): void {
		const fading = this.fading

		if (fading !== null && (fading.endsAt <= this.now() || fading.element.sample().ended)) {
			this.finishFade(fading)
		}
	}

	private reconcileOnVisible(): void {
		this.finishFadeIfDue()

		if (!this.element) {
			return
		}

		if (this.degradeRetry && useAudioStore.getState().status === "paused") {
			this.resume()

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

	// Full teardown on logout: supersede any in-flight load, stop + tear down the element, release the
	// live source, and clear the store. Nothing leaks across sessions.
	public dispose(): void {
		this.clearIdleClose()
		this.bumpLoadGeneration()

		if (this.visibilityHandler && typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", this.visibilityHandler)
		}

		this.visibilityHandler = null

		if (this.element) {
			this.retire(this.element)
		}

		this.element = null
		this.loadedTrackUuid = null
		this.teardownPrefetch()
		this.pruneEdges([])
		this.coverCache.clear()

		this.swapSource(null)

		this.skipGuard = 0
		this.lastPositionWriteAt = 0
		this.gaplessOnlyUuid = null
		this.pendingResume = null
		this.degradeRetry = false
		useAudioStore.getState().reset()
		useAudioStore.getState().resetMetadata()
		this.deps.mediaSession?.setMetadata(null)
		this.deps.mediaSession?.setPlaybackState("none")
		this.deps.smoothTransitions?.output.close()
	}
}
