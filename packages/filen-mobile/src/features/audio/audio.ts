import { createAudioPlayer, setAudioModeAsync, type AudioStatus } from "expo-audio"
import { AppState } from "react-native"
import { Asset } from "expo-asset"
import audioCache, { type Metadata } from "@/features/audio/audioCache"
import type { DriveItem, DriveItemFileExtracted } from "@/types"
import { useEffect, useState } from "react"
import events from "@/lib/events"
import { run } from "@filen/utils"
import auth from "@/lib/auth"
import { AnyNormalDir, DirMeta_Tags, AnyFile, FileMeta_Tags, FileMeta, ParentUuid, type Dir } from "@filen/sdk-rs"
import { Buffer } from "react-native-quick-crypto"
import { type } from "arktype"
import { wrapAbortSignalForSdk, disposeSdkAbortSignal } from "@/lib/signals"
import { playlistsQueryUpdate } from "@/features/audio/queries/usePlaylists.query"
import cache from "@/lib/cache"
import secureStore, { useSecureStore } from "@/lib/secureStore"
import { convertBigInts } from "@/lib/utils"
import logger from "@/lib/logger"

export type LoopMode = "none" | "track" | "queue"

export type QueueItem = {
	playlistUuid: string
	item: DriveItemFileExtracted
}

export const PlaylistFileSchema = type({
	uuid: "string",
	name: "string",
	mime: "string",
	size: "number",
	bucket: "string",
	key: "string",
	version: "number",
	chunks: "number",
	region: "string",
	playlist: "string"
})

export const PlaylistSchema = type({
	uuid: "string",
	name: "string",
	created: "number",
	updated: "number",
	files: PlaylistFileSchema.array()
})

export type Playlist = typeof PlaylistSchema.infer
export type PlaylistFile = typeof PlaylistFileSchema.infer

export type PlaylistWithItems = Omit<Playlist, "files"> & {
	files: (PlaylistFile & {
		item: DriveItemFileExtracted
	})[]
}

type State = {
	queue: QueueItem[]
	position: number
	loading: boolean
}

// When the native didJustFinish end-of-track signal is missed (observed on short
// 1-5s tracks where iOS can drop AVPlayerItemDidPlayToEndTime), this watchdog
// advances the queue anyway. It arms from the duration reported once a track is
// loaded and fires `buffer` ms after the expected end; a normal didJustFinish
// clears it first, so it only ever acts as a fallback.
const TRACK_END_WATCHDOG_BUFFER_MS = 2000

// How close to the reported duration counts as "ended" when the watchdog fires —
// guards against skipping a track that merely stalled mid-buffer.
const TRACK_END_WATCHDOG_EPSILON_S = 0.5

// Background-safe end detection: a native status update reporting a loaded track that has
// STOPPED at (or past) its reported end is treated as a track-end even when the one-shot
// `didJustFinish` flag was dropped (observed on iOS short tracks). This rides the native
// status stream — which keeps firing in the background — instead of the JS-timer watchdog,
// which iOS/Android freeze while backgrounded. The window is a touch wider than the watchdog
// epsilon since this only fires once the player has actually stopped.
const TRACK_END_STATUS_EPSILON_S = 0.75

// Foreground watchdog recovery: how many consecutive fires with no playback progress — while
// we still intend to play AND the player has stopped — count as "ended". Recovers from a track
// whose reported duration over-estimates the real end, so currentTime plateaus short of it and
// the watchdog would otherwise re-arm forever. A track the player still reports as `playing`
// (buffering) is never stall-skipped.
const TRACK_END_WATCHDOG_MAX_STALLS = 3

export class Audio {
	private readonly player = createAudioPlayer(undefined, {
		updateInterval: 1000,
		crossOrigin: "anonymous"
	})

	// Runtime-only shuffle state. The queue itself isn't persisted, so
	// persisting the shuffle order would be meaningless across restarts.
	private shuffleOrder: number[] = []
	private shufflePosition: number = 0

	// Generation counter for loadAndPlay; bumped on each call so older in-flight loads can detect they've been superseded.
	private loadGeneration: number = 0

	// Fallback timer for the missed-didJustFinish watchdog (see TRACK_END_WATCHDOG_* above).
	private trackEndWatchdog: ReturnType<typeof setTimeout> | null = null

	// loadGeneration whose track-end has already been handled, so the watchdog and a
	// late didJustFinish can't both advance the same track.
	private trackEndHandledGeneration: number = -1

	// Whether we currently intend to be playing; gates the watchdog so it doesn't poll while paused/stopped.
	private intendPlaying: boolean = false

	// Consecutive watchdog fires with no playback progress while stopped — see TRACK_END_WATCHDOG_MAX_STALLS.
	// Reset to 0 on every real status update (which means playback is progressing).
	private watchdogStalls: number = 0

	// Aborts the previous next-track prefetch when a newer track starts, so only the most
	// recent upcoming track is downloaded ahead of time.
	private prefetchAbort: AbortController | null = null

	// Last status emitted by the player. A PAUSED player emits no further playbackStatusUpdate
	// events, so freshly-mounted consumers (playlist toolbar slider, floating-bar progress) would
	// otherwise hydrate from null and show no position until playback resumes. getStatus() lets
	// them seed from the value the player reported at pause time.
	private lastStatus: AudioStatus | null = null

	// Lazily-resolved file:// URI for the lock-screen artwork placeholder shown when a track has no embedded cover art.
	private placeholderArtworkUri: string | null = null

	// Tracks playlist UUIDs whose missing-file cleanup has already been initiated this session, to avoid rewriting on every read.
	private playlistCleanupDone: Set<string> = new Set()

	private state = new Proxy<State>(
		{
			queue: [],
			position: 0,
			loading: false
		},
		{
			set: (target, prop, value): boolean => {
				const result = Reflect.set(target, prop, value)

				switch (prop) {
					case "queue": {
						events.emit("audioQueue", value as QueueItem[])

						break
					}

					case "position": {
						events.emit("audioQueuePosition", value as number)

						break
					}

					case "loading": {
						events.emit("audioLoading", value as boolean)

						break
					}
				}

				return result
			}
		}
	)

	public readonly loopModeKey = "audioLoopMode"
	public readonly shuffleEnabledKey = "audioShuffleEnabled"

	public constructor() {
		this.setAudioMode()

		this.player.addListener("playbackStatusUpdate", status => {
			this.lastStatus = status

			events.emit("audioStatus", status)

			// AU-02: a track whose bytes loaded but won't actually play (corrupt/unsupported codec, DRM,
			// mediaServicesReset) surfaces status.error and never fires didJustFinish — the queue would
			// wedge silently (no sound, no skip), permanently in the background. Treat a playback error on
			// the track we intend to be playing as terminal and skip-advance (forceAdvance), so even
			// loop-track moves off the broken track instead of re-playing it. handleTrackEnd dedupes per
			// loadGeneration, so repeated error statuses for the same track advance at most once. Gated on
			// intendPlaying so an error while paused doesn't resurrect playback.
			if (status.error && this.intendPlaying) {
				logger.error("audio", "player reported a playback error; skip-advancing", {
					generation: this.loadGeneration,
					error: status.error
				})

				this.clearTrackEndWatchdog()
				this.handleTrackEnd(true).catch(e =>
					logger.error("audio", "handleTrackEnd failed from playback-error branch", {
						generation: this.loadGeneration,
						error: e
					})
				)

				return
			}

			if (status.didJustFinish || this.statusIndicatesTrackEnded(status)) {
				this.clearTrackEndWatchdog()
				this.handleTrackEnd().catch(e =>
					logger.error("audio", "handleTrackEnd failed from status listener", {
						generation: this.loadGeneration,
						error: e
					})
				)

				return
			}

			this.maybeArmTrackEndWatchdog(status)
		})

		this.player.addListener("remoteNextTrack", () => {
			this.next().catch(e =>
				logger.error("audio", "next() failed from remote control", {
					position: this.state.position,
					error: e
				})
			)
		})

		this.player.addListener("remotePreviousTrack", () => {
			this.previous().catch(e =>
				logger.error("audio", "previous() failed from remote control", {
					position: this.state.position,
					error: e
				})
			)
		})

		// Recover advances missed while backgrounded. The watchdog (a setTimeout) is frozen in
		// the background and a dropped native didJustFinish leaves the queue stuck, so the moment
		// we're foregrounded again, reconcile the player against our intent.
		AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "active") {
				this.reconcileOnForeground()
			}
		})
	}

	public setAudioMode(): void {
		run(async () => {
			await setAudioModeAsync({
				interruptionMode: "doNotMix",
				playsInSilentMode: true,
				allowsRecording: false,
				shouldPlayInBackground: true,
				shouldRouteThroughEarpiece: false,
				allowsBackgroundRecording: false
			})
		})
	}

	private async isShuffleEnabled(): Promise<boolean> {
		return (await secureStore.get<boolean>(this.shuffleEnabledKey)) ?? false
	}

	private async getLoopMode(): Promise<LoopMode> {
		return (await secureStore.get<LoopMode>(this.loopModeKey)) ?? "none"
	}

	/**
	 * Generates a shuffled list of queue indices.
	 * If `firstIdx` is provided, that index is placed first (used when toggling
	 * shuffle on so the current track keeps playing). Otherwise full random.
	 */
	private generateShuffleOrder(firstIdx?: number): number[] {
		const indices = Array.from(
			{
				length: this.state.queue.length
			},
			(_, i) => i
		)

		if (firstIdx === undefined) {
			for (let i = indices.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1))

				const tmp = indices[i] ?? 0
				indices[i] = indices[j] ?? 0
				indices[j] = tmp
			}

			return indices
		}

		const others = indices.filter(i => i !== firstIdx)

		for (let i = others.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1))

			const tmp = others[i] ?? 0
			others[i] = others[j] ?? 0
			others[j] = tmp
		}

		return [firstIdx, ...others]
	}

	private async advanceToNext(): Promise<boolean> {
		const shuffle = await this.isShuffleEnabled()

		if (shuffle) {
			// Stale order (queue changed without shuffle being aware) — rebuild from current position.
			if (this.shuffleOrder.length !== this.state.queue.length) {
				this.shuffleOrder = this.generateShuffleOrder(this.state.position)
				this.shufflePosition = 0
			}

			const next = this.shufflePosition + 1

			if (next >= this.shuffleOrder.length) {
				return false
			}

			this.shufflePosition = next
			this.state.position = this.shuffleOrder[next]!

			return true
		}

		const next = this.state.position + 1

		if (next >= this.state.queue.length) {
			return false
		}

		this.state.position = next

		return true
	}

	private async advanceToPrevious(): Promise<boolean> {
		const shuffle = await this.isShuffleEnabled()

		if (shuffle) {
			if (this.shuffleOrder.length !== this.state.queue.length) {
				this.shuffleOrder = this.generateShuffleOrder(this.state.position)
				this.shufflePosition = 0
			}

			const prev = this.shufflePosition - 1

			if (prev < 0) {
				return false
			}

			this.shufflePosition = prev
			this.state.position = this.shuffleOrder[prev]!

			return true
		}

		const prev = this.state.position - 1

		if (prev < 0) {
			return false
		}

		this.state.position = prev

		return true
	}

	private async wrapToStart(): Promise<void> {
		const shuffle = await this.isShuffleEnabled()

		if (shuffle && this.state.queue.length > 0) {
			// Reshuffle on loop so the second pass isn't the same order.
			this.shuffleOrder = this.generateShuffleOrder()
			this.shufflePosition = 0
			this.state.position = this.shuffleOrder[0] ?? 0

			return
		}

		this.state.position = 0
	}

	private async wrapToEnd(): Promise<void> {
		const shuffle = await this.isShuffleEnabled()

		if (shuffle && this.state.queue.length > 0) {
			if (this.shuffleOrder.length !== this.state.queue.length) {
				this.shuffleOrder = this.generateShuffleOrder(this.state.position)
			}

			this.shufflePosition = this.shuffleOrder.length - 1
			this.state.position = this.shuffleOrder[this.shufflePosition] ?? 0

			return
		}

		this.state.position = this.state.queue.length - 1
	}

	private async handleTrackEnd(forceAdvance: boolean = false): Promise<void> {
		// Both the native didJustFinish event and the watchdog funnel through here, plus the playback-
		// error branch (forceAdvance=true). Dedupe per loaded track so a late didJustFinish can't
		// double-advance after the watchdog already recovered (or vice-versa).
		if (this.trackEndHandledGeneration === this.loadGeneration) {
			return
		}

		this.trackEndHandledGeneration = this.loadGeneration

		// Capture the generation we are acting on. Any user-initiated next()/previous()/
		// skipTo() that arrives while we are suspended at an await will call loadAndPlay(),
		// which increments loadGeneration. Re-checking gen after each await lets us bail
		// out before double-advancing the queue on top of the user navigation. We also
		// re-sync `gen` after our OWN loadAndPlay (which bumps the generation) when skipping
		// a failed track, so the supersede check keeps detecting only EXTERNAL navigation.
		let gen = this.loadGeneration

		this.clearTrackEndWatchdog()

		const loopMode = await this.getLoopMode()

		if (gen !== this.loadGeneration) {
			return
		}

		// On a normal end, loop-track re-plays the same track. On a FORCED advance (a playback error on
		// the current track — AU-02), skip it instead: re-playing a corrupt/unplayable track would
		// busy-loop (error → re-play → error → ...).
		if (loopMode === "track" && !forceAdvance) {
			try {
				await this.loadAndPlay(this.state.position)
			} catch (e) {
				logger.error("audio", "loadAndPlay failed in track-loop", {
					uuid: this.state.queue[this.state.position]?.item.data.uuid,
					error: e
				})
			}

			return
		}

		// Advance to the next playable track, skipping any that fail to load so one bad/slow
		// track can't stall the whole queue. Bounded by the queue length so a queue where every
		// remaining track fails can't loop forever.
		for (let attempt = 0; attempt < this.state.queue.length; attempt++) {
			const advanced = await this.advanceToNext()

			if (gen !== this.loadGeneration) {
				return
			}

			if (!advanced) {
				break
			}

			// Capture the generation OUR loadAndPlay assigns, synchronously — it does `++loadGeneration`
			// on its first line, before any await, so reading loadGeneration right after the call (with
			// no await in between) yields our own generation. On a load failure we re-sync `gen` to THAT,
			// NOT a re-read of loadGeneration, so an external next()/skipTo() that bumped the counter
			// during our failed load is still detected as a supersede on the next iteration (AU-03).
			const loadPromise = this.loadAndPlay(this.state.position)
			const ownGeneration = this.loadGeneration

			try {
				await loadPromise

				return
			} catch (e) {
				logger.warn("audio", "track skipped during auto-advance due to load failure", {
					position: this.state.position,
					uuid: this.state.queue[this.state.position]?.item.data.uuid,
					error: e
				})

				gen = ownGeneration
			}
		}

		// Reached the end with nothing playing. Loop back to the start if asked, again skipping
		// any tracks that fail to load (bounded to a single pass over the queue).
		if (loopMode === "queue" && this.state.queue.length > 0) {
			await this.wrapToStart()

			if (gen !== this.loadGeneration) {
				return
			}

			for (let attempt = 0; attempt < this.state.queue.length; attempt++) {
				// Same own-generation capture as the forward pass above (AU-03).
				const loadPromise = this.loadAndPlay(this.state.position)
				const ownGeneration = this.loadGeneration

				try {
					await loadPromise

					return
				} catch (e) {
					logger.warn("audio", "track skipped during queue loop-wrap due to load failure", {
						position: this.state.position,
						uuid: this.state.queue[this.state.position]?.item.data.uuid,
						error: e
					})

					gen = ownGeneration
				}

				const advanced = await this.advanceToNext()

				if (gen !== this.loadGeneration) {
					return
				}

				if (!advanced) {
					break
				}
			}
		}

		this.intendPlaying = false

		this.player.pause()
	}

	private async loadAndPlay(queueIndex: number): Promise<void> {
		const generation = ++this.loadGeneration

		await run(
			async defer => {
				this.state.loading = true

				defer(() => {
					if (generation === this.loadGeneration) {
						this.state.loading = false
					}
				})

				const entry = this.state.queue[queueIndex]

				if (!entry) {
					return
				}

				// AU-04: establish intent-to-play BEFORE the (possibly long) download so a pause() that
				// lands during it flips this to false and is honored by the guard below.
				this.intendPlaying = true

				const { audio, metadata } = await audioCache.get({
					item: {
						type: "drive",
						data: entry.item
					}
				})

				// Bail if superseded by a newer load, OR if the user paused during the download (AU-04) —
				// otherwise a pause issued mid-load would be silently overridden and audio would resume.
				if (generation !== this.loadGeneration || !this.intendPlaying) {
					return
				}

				// Clear any pending watchdog from the outgoing track before swapping sources;
				// the incoming track re-arms it from its own status updates.
				this.clearTrackEndWatchdog()

				this.player.replace({
					uri: audio.uri,
					name: metadata?.title ?? entry.item.data.decryptedMeta?.name ?? entry.item.data.uuid
				})

				// No seekTo(0) here on purpose: a freshly-replaced AVPlayerItem is already at
				// time 0, and the previous `await seekTo(0)` opened a gap between replace() and
				// play() that could lose the end-of-track observer on very short tracks. Keeping
				// replace()/play() in one synchronous tick avoids that race. intendPlaying was set
				// before the download and re-checked after it (AU-04), so it is still true here.
				this.player.play()

				this.updateLockScreen({
					item: entry,
					metadata,
					generation
				}).catch(e =>
					logger.error("audio", "lock screen update failed", {
						uuid: entry.item.data.uuid,
						error: e
					})
				)

				// Pre-stage the next track so that when this one ends, loadAndPlay resolves from
				// disk in a single tick instead of awaiting a download mid-gap. A long inter-track
				// gap lets iOS deactivate the audio session and suspend the app in the background,
				// which is the main reason auto-advance stalls there. Best-effort.
				this.prefetchNextTrack().catch(() => {})
			},
			{
				throw: true
			}
		)
	}

	private async updateLockScreen({
		item,
		metadata,
		generation
	}: {
		item: QueueItem
		metadata: Metadata
		generation: number
	}): Promise<void> {
		// Fall back to a bundled placeholder when the track has no embedded cover art,
		// otherwise iOS keeps showing the previous track's artwork (it never clears a
		// now-playing key that isn't overwritten).
		const artworkUrl = metadata?.pictureUri ?? (await this.getPlaceholderArtworkUri())

		// Resolving the placeholder is async on first use; bail if a newer load has
		// since superseded this one so we don't overwrite the current track's info.
		if (generation !== this.loadGeneration) {
			return
		}

		this.player.setActiveForLockScreen(
			true,
			{
				title: metadata?.title ?? item.item.data.decryptedMeta?.name ?? item.item.data.uuid,
				artist: metadata?.artist ?? undefined,
				albumTitle: metadata?.album ?? undefined,
				artworkUrl: artworkUrl ?? undefined
			},
			{
				// iOS gives the two Now Playing side-button slots to the 10s skip-interval
				// commands when they're enabled, hiding previous/next track. Disable them on
				// iOS so prev/next show; keep them on Android where they coexist in the
				// notification with prev/next.
				showSeekBackward: false,
				showSeekForward: false
			}
		)
	}

	private clearTrackEndWatchdog(): void {
		if (this.trackEndWatchdog !== null) {
			clearTimeout(this.trackEndWatchdog)

			this.trackEndWatchdog = null
		}
	}

	private scheduleTrackEndWatchdog(generation: number, delayMs: number): void {
		this.clearTrackEndWatchdog()

		this.trackEndWatchdog = setTimeout(() => {
			this.onTrackEndWatchdogFired(generation)
		}, delayMs)
	}

	private maybeArmTrackEndWatchdog(status: AudioStatus): void {
		if (!this.intendPlaying || !status.isLoaded || !Number.isFinite(status.duration) || status.duration <= 0) {
			return
		}

		// A real status update means playback is progressing — reset the stall recovery counter.
		this.watchdogStalls = 0

		const remainingMs = Math.max(0, (status.duration - status.currentTime) * 1000)

		this.scheduleTrackEndWatchdog(this.loadGeneration, remainingMs + TRACK_END_WATCHDOG_BUFFER_MS)
	}

	private onTrackEndWatchdogFired(generation: number): void {
		this.trackEndWatchdog = null

		if (generation !== this.loadGeneration) {
			return
		}

		const duration = this.player.duration
		const currentTime = this.player.currentTime

		// Duration not known yet (still loading/buffering). Keep polling while we intend to play
		// rather than dead-ending — giving up here would strand the track with no advance.
		if (!Number.isFinite(duration) || duration <= 0) {
			if (!this.intendPlaying) {
				return
			}

			this.scheduleTrackEndWatchdog(generation, TRACK_END_WATCHDOG_BUFFER_MS)

			return
		}

		// Short of the reported end. Either the track is still playing/buffering (wait it out), or
		// playback has STOPPED below the reported duration because that duration over-estimates the
		// real end — in which case currentTime plateaus and we'd otherwise re-arm forever. Advance
		// after a few stalled fires once the player has stopped; a still-playing track is never skipped.
		if (currentTime < duration - TRACK_END_WATCHDOG_EPSILON_S) {
			if (!this.intendPlaying) {
				return
			}

			if (!this.player.playing) {
				this.watchdogStalls++

				if (this.watchdogStalls >= TRACK_END_WATCHDOG_MAX_STALLS) {
					this.handleTrackEnd().catch(e =>
						logger.error("audio", "handleTrackEnd failed from status listener", {
							generation: this.loadGeneration,
							error: e
						})
					)

					return
				}
			}

			const remainingMs = Math.max(0, (duration - currentTime) * 1000)

			this.scheduleTrackEndWatchdog(generation, remainingMs + TRACK_END_WATCHDOG_BUFFER_MS)

			return
		}

		// Reached the end but didJustFinish never arrived — advance the queue.
		this.handleTrackEnd().catch(e =>
			logger.error("audio", "handleTrackEnd failed from status listener", {
				generation: this.loadGeneration,
				error: e
			})
		)
	}

	private statusIndicatesTrackEnded(status: AudioStatus): boolean {
		// Background-safe fallback for a dropped didJustFinish: a loaded track that has stopped
		// playing at/after its reported end has finished. Rides the native status stream (which
		// fires in the background) rather than the JS-timer watchdog (which does not). The
		// per-generation dedupe in handleTrackEnd keeps this from double-advancing alongside a
		// real didJustFinish. `currentTime > 0` rules out a freshly-replaced (time 0) track.
		return (
			this.intendPlaying &&
			status.isLoaded &&
			!status.playing &&
			Number.isFinite(status.duration) &&
			status.duration > 0 &&
			status.currentTime > 0 &&
			status.currentTime >= status.duration - TRACK_END_STATUS_EPSILON_S
		)
	}

	private reconcileOnForeground(): void {
		// A track that finished while the app was backgrounded may not have advanced (frozen
		// watchdog + dropped didJustFinish). The instant we're foregrounded, recover by advancing
		// if the current track has ended while we still intend to play. Skip while a load is in
		// flight — a suspended loadAndPlay await may be resuming and would otherwise double-advance.
		if (!this.intendPlaying || this.state.loading || this.state.queue.length === 0) {
			return
		}

		const duration = this.player.duration
		const currentTime = this.player.currentTime

		if (!Number.isFinite(duration) || duration <= 0) {
			return
		}

		// Still playing, or paused mid-track — nothing to recover.
		if (this.player.playing || currentTime < duration - TRACK_END_STATUS_EPSILON_S) {
			return
		}

		this.handleTrackEnd().catch(e =>
			logger.error("audio", "handleTrackEnd failed from status listener", {
				generation: this.loadGeneration,
				error: e
			})
		)
	}

	private peekNextPlayIndex(shuffle: boolean, loopMode: LoopMode): number | null {
		// The queue index that WILL play after the current track ends, computed without mutating
		// any playback state. Returns null when there is nothing worth prefetching: an empty
		// queue, track-loop (same track, already cached), the end of a non-looping queue, or a
		// shuffle wrap (loop reshuffles unpredictably, so the next track can't be known here).
		if (this.state.queue.length === 0 || loopMode === "track") {
			return null
		}

		if (shuffle) {
			if (this.shuffleOrder.length !== this.state.queue.length) {
				return null
			}

			const next = this.shufflePosition + 1

			return next < this.shuffleOrder.length ? (this.shuffleOrder[next] ?? null) : null
		}

		const next = this.state.position + 1

		if (next < this.state.queue.length) {
			return next
		}

		return loopMode === "queue" ? 0 : null
	}

	private async prefetchNextTrack(): Promise<void> {
		try {
			const shuffle = await this.isShuffleEnabled()
			const loopMode = await this.getLoopMode()
			const index = this.peekNextPlayIndex(shuffle, loopMode)

			if (index === null) {
				return
			}

			const entry = this.state.queue[index]

			if (!entry || entry.item.data.undecryptable) {
				return
			}

			// Only the most recent upcoming track matters — abort any in-flight prefetch.
			this.prefetchAbort?.abort()

			const abort = new AbortController()

			this.prefetchAbort = abort

			await audioCache.get({
				item: {
					type: "drive",
					data: entry.item
				},
				signal: abort.signal
			})
		} catch {
			// Best-effort: a failed or aborted prefetch must never disrupt current playback.
		}
	}

	private async getPlaceholderArtworkUri(): Promise<string | undefined> {
		if (this.placeholderArtworkUri !== null) {
			return this.placeholderArtworkUri
		}

		const result = await run(async () => {
			const asset = Asset.fromModule(require("@/assets/images/icon-light.png"))

			if (!asset.localUri) {
				await asset.downloadAsync()
			}

			return asset.localUri
		})

		if (!result.success) {
			logger.error("audio", "failed to resolve placeholder artwork asset", {
				error: result.error
			})

			return undefined
		}

		this.placeholderArtworkUri = result.data ?? null

		return this.placeholderArtworkUri ?? undefined
	}

	public async addToQueue({ item, position = "end" }: { item: QueueItem; position?: "start" | "end" }): Promise<boolean> {
		if (item.item.data.undecryptable) {
			return false
		}

		const shuffle = await this.isShuffleEnabled()

		if (position === "start") {
			this.state.queue = [item, ...this.state.queue]

			if (this.state.queue.length > 1) {
				this.state.position++
			}

			if (shuffle) {
				// Existing entries pointed to old indices — bump each by 1, then add new index 0 at the end.
				if (this.shuffleOrder.length + 1 === this.state.queue.length) {
					this.shuffleOrder = [...this.shuffleOrder.map(i => i + 1), 0]
				} else {
					this.shuffleOrder = this.generateShuffleOrder(this.state.position)
					this.shufflePosition = 0
				}
			}
		} else {
			this.state.queue = [...this.state.queue, item]

			if (shuffle) {
				const newIdx = this.state.queue.length - 1

				if (this.shuffleOrder.length === newIdx) {
					// Insert at a uniformly random slot strictly after the current shufflePosition so the
					// new track is reachable within the remaining shuffle pass.
					const insertAt =
						this.shufflePosition + 1 + Math.floor(Math.random() * (this.shuffleOrder.length - this.shufflePosition))

					this.shuffleOrder = [...this.shuffleOrder.slice(0, insertAt), newIdx, ...this.shuffleOrder.slice(insertAt)]
				} else {
					this.shuffleOrder = this.generateShuffleOrder(this.state.position)
					this.shufflePosition = 0
				}
			}
		}

		return true
	}

	public async replaceQueue({
		items,
		startingPosition = 0
	}: {
		items: QueueItem[]
		startingPosition?: number
	}): Promise<{ droppedUndecryptable: boolean }> {
		// AU-01: synchronously supersede the outgoing track's end-handling BEFORE any await. replaceQueue
		// swaps the queue/position but does NOT load — the caller's subsequent play() does. Without this,
		// the outgoing track's didJustFinish (firing during the await below) would run handleTrackEnd
		// against the NEW queue and over-advance past the position just set. Bumping the generation AND
		// marking it handled makes any in-flight or about-to-fire handleTrackEnd bail; intendPlaying=false
		// + clearing the watchdog avoid a stray resume/fire in the gap before the caller's play().
		this.loadGeneration++
		this.trackEndHandledGeneration = this.loadGeneration
		this.intendPlaying = false
		this.clearTrackEndWatchdog()

		const droppedBeforePosition = items.slice(0, startingPosition).filter(i => i.item.data.undecryptable).length
		const filteredItems = items.filter(i => !i.item.data.undecryptable)
		const adjustedPosition =
			filteredItems.length === 0 ? 0 : Math.max(0, Math.min(filteredItems.length - 1, startingPosition - droppedBeforePosition))
		const droppedUndecryptable = items.length > filteredItems.length

		this.state.queue = filteredItems
		this.state.position = adjustedPosition

		const shuffle = await this.isShuffleEnabled()

		if (shuffle && filteredItems.length > 0) {
			this.shuffleOrder = this.generateShuffleOrder(adjustedPosition)
			this.shufflePosition = 0
		} else {
			this.shuffleOrder = []
			this.shufflePosition = 0
		}

		return {
			droppedUndecryptable
		}
	}

	public async clearQueue(): Promise<void> {
		await this.stop()

		this.state.queue = []
		this.state.position = 0
		this.shuffleOrder = []
		this.shufflePosition = 0
		// Nothing is loaded anymore — don't let consumers hydrate from the cleared track's status.
		this.lastStatus = null
	}

	public async play(): Promise<void> {
		if (this.state.queue.length > 0) {
			await this.loadAndPlay(this.state.position)
		}
	}

	public pause(): void {
		this.intendPlaying = false

		this.clearTrackEndWatchdog()

		this.player.pause()
	}

	public resume(): void {
		if (this.state.queue.length > 0) {
			this.intendPlaying = true

			this.player.play()
		}
	}

	public async next(): Promise<void> {
		if (await this.advanceToNext()) {
			await this.loadAndPlay(this.state.position)

			return
		}

		const loopMode = await this.getLoopMode()

		if (loopMode === "queue" && this.state.queue.length > 0) {
			await this.wrapToStart()
			await this.loadAndPlay(this.state.position)
		}
	}

	public async previous(): Promise<void> {
		// If more than 3 seconds in, restart the current track instead of going back.
		// Guard against NaN/undefined currentTime (e.g. before playback has started).
		if (Number.isFinite(this.player.currentTime) && this.player.currentTime > 3) {
			await this.player.seekTo(0)

			return
		}

		if (await this.advanceToPrevious()) {
			await this.loadAndPlay(this.state.position)

			return
		}

		const loopMode = await this.getLoopMode()

		if (loopMode === "queue" && this.state.queue.length > 0) {
			await this.wrapToEnd()
			await this.loadAndPlay(this.state.position)

			return
		}

		await this.player.seekTo(0)
	}

	public async seek(seconds: number): Promise<void> {
		await this.player.seekTo(seconds)
	}

	public async stop(): Promise<void> {
		this.intendPlaying = false

		this.clearTrackEndWatchdog()

		this.player.pause()

		await this.player.seekTo(0)

		this.player.clearLockScreenControls()
	}

	public async skipTo(index: number): Promise<void> {
		if (index < 0 || index >= this.state.queue.length) {
			return
		}

		this.state.position = index

		const shuffle = await this.isShuffleEnabled()

		if (shuffle) {
			const shufIdx = this.shuffleOrder.indexOf(index)

			if (shufIdx !== -1) {
				this.shufflePosition = shufIdx
			} else {
				// Stale order — regenerate with this index first so playback continues from here.
				this.shuffleOrder = this.generateShuffleOrder(index)
				this.shufflePosition = 0
			}
		}

		await this.loadAndPlay(index)
	}

	public async setLoopMode(mode: LoopMode): Promise<void> {
		await secureStore.set(this.loopModeKey, mode)
	}

	public async setShuffleEnabled(enabled: boolean): Promise<void> {
		await secureStore.set(this.shuffleEnabledKey, enabled)

		if (enabled) {
			this.shuffleOrder = this.generateShuffleOrder(this.state.position)
			this.shufflePosition = 0
		} else {
			this.shuffleOrder = []
			this.shufflePosition = 0
		}
	}

	public getCurrentQueueItem() {
		return this.state.queue[this.state.position] ?? null
	}

	public getQueue() {
		return this.state.queue
	}

	public getPosition() {
		return this.state.position
	}

	public getLoading() {
		return this.state.loading
	}

	public getStatus(): AudioStatus | null {
		return this.lastStatus
	}

	public async getPlaylistsDirectory(signal?: AbortSignal): Promise<Dir> {
		const { authedSdkClient } = await auth.getSdkClients()

		let dotFilenDir = (
			await authedSdkClient.listDir(
				new AnyNormalDir.Root({
					uuid: authedSdkClient.root().uuid
				}),
				signal
					? {
							signal
						}
					: undefined
			)
		).dirs.find(d => d.meta.tag === DirMeta_Tags.Decoded && d.meta.inner[0].name.trim().toLowerCase() === ".filen")

		if (!dotFilenDir) {
			dotFilenDir = await authedSdkClient.createDir(
				new AnyNormalDir.Root({
					uuid: authedSdkClient.root().uuid
				}),
				".filen",
				signal
					? {
							signal
						}
					: undefined
			)
		}

		let playlistsDir = (
			await authedSdkClient.listDir(
				new AnyNormalDir.Dir(dotFilenDir),
				signal
					? {
							signal
						}
					: undefined
			)
		).dirs.find(d => d.meta.tag === DirMeta_Tags.Decoded && d.meta.inner[0].name.trim().toLowerCase() === "playlists")

		if (!playlistsDir) {
			playlistsDir = await authedSdkClient.createDir(
				new AnyNormalDir.Dir(dotFilenDir),
				"Playlists",
				signal
					? {
							signal
						}
					: undefined
			)
		}

		return playlistsDir
	}

	private playlistFileToDriveItem(file: PlaylistFile, now: number): DriveItemFileExtracted {
		const meta = {
			name: file.name,
			mime: file.mime,
			created: undefined,
			modified: BigInt(now),
			hash: undefined,
			size: BigInt(file.size),
			key: file.key,
			version: file.version
		}

		const item: DriveItemFileExtracted = {
			type: "file",
			data: {
				uuid: file.uuid,
				meta: new FileMeta.Decoded(meta),
				parent: new ParentUuid.Uuid(file.uuid),
				size: BigInt(file.size),
				favorited: false,
				region: file.region,
				bucket: file.bucket,
				timestamp: BigInt(now),
				chunks: BigInt(file.chunks),
				canMakeThumbnail: false,
				decryptedMeta: meta,
				undecryptable: false
			}
		}

		// We need to cache it here for the audioMetadata query to work later, since it relies on the cache
		cache.uuidToAnyDriveItem.set(file.uuid, item)

		return item
	}

	private parsePlaylistBytes(bytes: ArrayBuffer): Playlist | null {
		let parsed: unknown

		try {
			parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"))
		} catch {
			return null
		}

		const result = PlaylistSchema(parsed)

		if (result instanceof type.errors) {
			return null
		}

		return result
	}

	public async getPlaylists(signal?: AbortSignal): Promise<PlaylistWithItems[]> {
		const { authedSdkClient } = await auth.getSdkClients()
		const playlistsDir = await this.getPlaylistsDirectory(signal)
		const playlists = await authedSdkClient.listDir(
			new AnyNormalDir.Dir(playlistsDir),
			signal
				? {
						signal
					}
				: undefined
		)

		const parsedPlaylists = await Promise.all(
			playlists.files.map(async file => {
				// AU-05: isolate each playlist. A transient SDK error (network/decrypt/rate-limit) on one
				// playlist's download must NOT reject Promise.all and collapse the WHOLE playlists screen —
				// skip just this one and keep the rest. The wrapped abort handle (uniffi, no GC) is freed in
				// finally — the previously-inline wrap leaked it on every read (TC-01 class).
				const wrappedAbortSignal = signal ? wrapAbortSignalForSdk(signal) : undefined

				try {
					const read = await authedSdkClient.downloadFileToBytes(
						new AnyFile.File(file),
						{
							abortSignal: wrappedAbortSignal,
							pauseSignal: undefined
						},
						signal
							? {
									signal
								}
							: undefined
					)

					const result = this.parsePlaylistBytes(read)

					if (!result) {
						logger.warn("audio", "playlist file failed to parse", { uuid: file.uuid })

						return null
					}

					const now = Date.now()
					const nonExistentFileUuids = new Set<string>()

					const filesWithItems = (
						await Promise.all(
							result.files.map(async file => {
								try {
									const fileExists = await authedSdkClient.getFileOptional(
										file.uuid,
										signal
											? {
													signal
												}
											: undefined
									)

									if (!fileExists) {
										nonExistentFileUuids.add(file.uuid)

										return null
									}

									return {
										...file,
										item: this.playlistFileToDriveItem(file, now)
									}
								} catch (e) {
									// AU-05: a transient getFileOptional error is NOT a definitive not-found.
									// Keep the track (present-unknown) rather than dropping it or feeding the
									// cleanup deletion path — only an explicit not-found (undefined) removes it.
									logger.warn("audio", "getFileOptional failed for playlist track; keeping it", { uuid: file.uuid, error: e })

									return {
										...file,
										item: this.playlistFileToDriveItem(file, now)
									}
								}
							})
						)
					).filter(file => file !== null)

					if (nonExistentFileUuids.size > 0 && !this.playlistCleanupDone.has(result.uuid)) {
						this.playlistCleanupDone.add(result.uuid)

						// Fire-and-forget: don't block the read on cleanup persistence. UI already sees the
						// filtered list via filesWithItems, so a delayed persist is harmless.
						this.savePlaylist({
							playlist: {
								...result,
								files: result.files.filter(file => !nonExistentFileUuids.has(file.uuid))
							},
							signal
						}).catch(e =>
							logger.error("audio", "playlist cleanup persist failed", {
								playlistUuid: result.uuid,
								removedCount: nonExistentFileUuids.size,
								error: e
							})
						)
					}

					return {
						...result,
						files: filesWithItems
					}
				} catch (e) {
					// AU-05: skip just this playlist on a transient read error; keep the rest.
					logger.warn("audio", "playlist read failed; skipping it", { uuid: file.uuid, error: e })

					return null
				} finally {
					disposeSdkAbortSignal(wrappedAbortSignal)
				}
			})
		)

		return parsedPlaylists.filter(p => p !== null)
	}

	public async savePlaylist({ playlist, signal }: { playlist: Playlist; signal?: AbortSignal }): Promise<void> {
		const { authedSdkClient } = await auth.getSdkClients()
		const playlistsDir = await this.getPlaylistsDirectory(signal)

		// Strip runtime-only `item` fields from playlist files and convert any residual
		// BigInt values to numbers so the stock JSON.stringify doesn't throw when
		// addFilesToPlaylist appends files that carry the DriveItemFileExtracted shape.
		// Plain JSON is deliberate here: playlist files are read back with plain
		// JSON.parse + arktype validation, never through the envelope serializer.
		const playlistToSerialize = convertBigInts({
			...playlist,
			files: playlist.files.map(({ item: _item, ...rest }: PlaylistFile & { item?: unknown }) => rest)
		})

		// TC-01: hoist the wrapped abort handle so its uniffi handles (controller + signal) are freed
		// after the upload settles — an inline wrap here leaked both on every playlist save.
		const wrappedAbortSignal = signal ? wrapAbortSignalForSdk(signal) : undefined

		try {
			await authedSdkClient.uploadFileFromBytes(Buffer.from(JSON.stringify(playlistToSerialize), "utf-8").buffer, {
				fileBuilderParams: {
					parent: new AnyNormalDir.Dir(playlistsDir),
					name: `${playlist.uuid}.json`,
					created: BigInt(Date.now()),
					modified: BigInt(Date.now()),
					mime: "application/json",
					noExif: false,
					noExifOverride: false
				},
				managedFuture: {
					abortSignal: wrappedAbortSignal,
					pauseSignal: undefined
				}
			})
		} finally {
			disposeSdkAbortSignal(wrappedAbortSignal)
		}

		const now = Date.now()
		const playlistWithItems = {
			...playlist,
			files: playlist.files.map(file => {
				const item = this.playlistFileToDriveItem(file, now)

				return {
					...file,
					item
				}
			})
		}

		playlistsQueryUpdate({
			updater: prev => [...prev.filter(p => p.uuid !== playlist.uuid), playlistWithItems]
		})
	}

	/**
	 * Appends drive-selected files to a playlist and persists it. Accepts the raw
	 * `selectedItems` payload returned by the drive picker; filters down to decryptable
	 * audio file items that aren't already in the playlist, maps them to playlist file
	 * objects and saves once. Returns the number of files that were actually added.
	 */
	public async addFilesToPlaylist({
		playlist,
		items,
		signal
	}: {
		playlist: Playlist
		items: (
			| {
					type: "driveItem"
					data: DriveItem
			  }
			| {
					type: "root"
					data: AnyNormalDir
			  }
		)[]
		signal?: AbortSignal
	}): Promise<number> {
		const currentFilesUuids = new Set(playlist.files.map(file => file.uuid))
		const newItems = items
			.filter(
				(
					item
				): item is {
					type: "driveItem"
					data: DriveItemFileExtracted
				} =>
					item.type === "driveItem" &&
					!currentFilesUuids.has(item.data.data.uuid) &&
					!item.data.data.undecryptable &&
					Boolean(item.data.data.decryptedMeta) &&
					(item.data.type === "file" || item.data.type === "sharedFile" || item.data.type === "sharedRootFile")
			)
			.map(item => item.data)

		if (newItems.length === 0) {
			return 0
		}

		await this.savePlaylist({
			playlist: {
				...playlist,
				files: [
					...playlist.files,
					...newItems.map(item => ({
						uuid: item.data.uuid,
						name: item.data.decryptedMeta?.name ?? item.data.uuid,
						mime: item.data.decryptedMeta?.mime ?? "application/octet-stream",
						size: Number(item.data.size),
						bucket: item.data.bucket,
						key: item.data.decryptedMeta?.key ?? "",
						version: item.data.decryptedMeta?.version ? Number(item.data.decryptedMeta?.version) : 0,
						chunks: Number(item.data.chunks),
						region: item.data.region,
						playlist: playlist.uuid,
						item
					}))
				]
			},
			signal
		})

		return newItems.length
	}

	/**
	 * Persists a playlist under a new name. The prompt and name validation (trim,
	 * empty-name guard) stay in the UI; this only stamps `updated` and saves.
	 */
	public async renamePlaylist({ playlist, name, signal }: { playlist: Playlist; name: string; signal?: AbortSignal }): Promise<void> {
		await this.savePlaylist({
			playlist: {
				...playlist,
				name,
				updated: Date.now()
			},
			signal
		})
	}

	public async deletePlaylist({ playlist, signal }: { playlist: Playlist; signal?: AbortSignal }): Promise<void> {
		const { authedSdkClient } = await auth.getSdkClients()
		const playlistsDir = await this.getPlaylistsDirectory(signal)

		const file = (
			await authedSdkClient.listDir(
				new AnyNormalDir.Dir(playlistsDir),
				signal
					? {
							signal
						}
					: undefined
			)
		).files.find(
			f =>
				f.meta.tag === FileMeta_Tags.Decoded &&
				f.meta.inner[0].name.toLowerCase().trim() === `${playlist.uuid}.json`.toLowerCase().trim()
		)

		if (file) {
			await authedSdkClient.deleteFilePermanently(
				file,
				signal
					? {
							signal
						}
					: undefined
			)
		}

		playlistsQueryUpdate({
			updater: prev => prev.filter(p => p.uuid !== playlist.uuid)
		})
	}
}

const audio = new Audio()

export function useAudio() {
	// Seed from the cached status: a paused player emits no events, so a null seed would leave
	// freshly-mounted consumers (toolbar slider position, durations) empty until resume.
	const [status, setStatus] = useState<AudioStatus | null>(audio.getStatus())
	const [loading, setLoadingState] = useState<boolean>(audio.getLoading())
	const [queue, setQueue] = useState<QueueItem[]>(audio.getQueue())
	const [queuePosition, setQueuePosition] = useState<number>(audio.getPosition())
	const [shuffleEnabled] = useSecureStore<boolean>(audio.shuffleEnabledKey, false)
	const [loopMode] = useSecureStore<LoopMode>(audio.loopModeKey, "none")

	useEffect(() => {
		const statusSubscription = events.subscribe("audioStatus", setStatus)
		const loadingSubscription = events.subscribe("audioLoading", setLoadingState)
		const queueSubscription = events.subscribe("audioQueue", setQueue)
		const positionSubscription = events.subscribe("audioQueuePosition", setQueuePosition)

		return () => {
			statusSubscription.remove()
			loadingSubscription.remove()
			queueSubscription.remove()
			positionSubscription.remove()
		}
	}, [])

	return {
		status,
		loading,
		queueItem: queue[queuePosition] ?? null,
		shuffleEnabled,
		loopMode
	}
}

export function useAudioQueue() {
	const [queue, setQueue] = useState<QueueItem[]>(audio.getQueue())
	const [position, setPosition] = useState<number>(audio.getPosition())

	useEffect(() => {
		const queueSubscription = events.subscribe("audioQueue", setQueue)
		const positionSubscription = events.subscribe("audioQueuePosition", setPosition)

		return () => {
			queueSubscription.remove()
			positionSubscription.remove()
		}
	}, [])

	return {
		queue,
		position,
		queueItem: queue[position] ?? null
	}
}

export function useIsCurrentTrack(trackUuid: string): boolean {
	const [queue, setQueue] = useState<QueueItem[]>(audio.getQueue())
	const [position, setPosition] = useState<number>(audio.getPosition())

	useEffect(() => {
		const queueSubscription = events.subscribe("audioQueue", setQueue)
		const positionSubscription = events.subscribe("audioQueuePosition", setPosition)

		return () => {
			queueSubscription.remove()
			positionSubscription.remove()
		}
	}, [])

	return (queue[position] ?? null)?.item.data.uuid === trackUuid
}

export default audio
