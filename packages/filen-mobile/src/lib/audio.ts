import { createAudioPlayer, setAudioModeAsync, type AudioStatus } from "expo-audio"
import { Platform } from "react-native"
import { Asset } from "expo-asset"
import audioCache, { type Metadata } from "@/lib/audioCache"
import type { DriveItemFileExtracted } from "@/types"
import { useEffect, useState } from "react"
import events from "@/lib/events"
import { run } from "@filen/utils"
import auth from "@/lib/auth"
import { AnyNormalDir, DirMeta_Tags, AnyFile, FileMeta_Tags, FileMeta, ParentUuid, type Dir } from "@filen/sdk-rs"
import { Buffer } from "react-native-quick-crypto"
import { type } from "arktype"
import { wrapAbortSignalForSdk } from "@/lib/utils"
import { playlistsQueryUpdate } from "@/queries/usePlaylists.query"
import cache from "@/lib/cache"
import secureStore, { useSecureStore } from "@/lib/secureStore"

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
			events.emit("audioStatus", status)

			if (status.didJustFinish) {
				this.clearTrackEndWatchdog()
				this.handleTrackEnd().catch(console.error)

				return
			}

			this.maybeArmTrackEndWatchdog(status)
		})

		this.player.addListener("remoteNextTrack", () => {
			this.next().catch(console.error)
		})

		this.player.addListener("remotePreviousTrack", () => {
			this.previous().catch(console.error)
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

				;[indices[i], indices[j]] = [indices[j]!, indices[i]!]
			}

			return indices
		}

		const others = indices.filter(i => i !== firstIdx)

		for (let i = others.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1))

			;[others[i], others[j]] = [others[j]!, others[i]!]
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

	private async handleTrackEnd(): Promise<void> {
		// Both the native didJustFinish event and the watchdog funnel through here.
		// Dedupe per loaded track so a late didJustFinish can't double-advance after
		// the watchdog already recovered (or vice-versa).
		if (this.trackEndHandledGeneration === this.loadGeneration) {
			return
		}

		this.trackEndHandledGeneration = this.loadGeneration

		this.clearTrackEndWatchdog()

		const loopMode = await this.getLoopMode()

		if (loopMode === "track") {
			await this.loadAndPlay(this.state.position)

			return
		}

		if (await this.advanceToNext()) {
			await this.loadAndPlay(this.state.position)

			return
		}

		if (loopMode === "queue" && this.state.queue.length > 0) {
			await this.wrapToStart()
			await this.loadAndPlay(this.state.position)

			return
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

				const { audio, metadata } = await audioCache.get({
					item: {
						type: "drive",
						data: entry.item
					}
				})

				if (generation !== this.loadGeneration) {
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
				// replace()/play() in one synchronous tick avoids that race.
				this.intendPlaying = true

				this.player.play()

				this.updateLockScreen({
					item: entry,
					metadata,
					generation
				}).catch(console.error)
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
				showSeekBackward: Platform.OS !== "ios",
				showSeekForward: Platform.OS !== "ios"
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

		if (!Number.isFinite(duration) || duration <= 0) {
			return
		}

		// Still short of the end — the track stalled (buffering) rather than finished.
		// Keep waiting instead of skipping, but only while we still intend to play.
		if (currentTime < duration - TRACK_END_WATCHDOG_EPSILON_S) {
			if (!this.intendPlaying) {
				return
			}

			const remainingMs = Math.max(0, (duration - currentTime) * 1000)

			this.scheduleTrackEndWatchdog(generation, remainingMs + TRACK_END_WATCHDOG_BUFFER_MS)

			return
		}

		// Reached the end but didJustFinish never arrived — advance the queue.
		this.handleTrackEnd().catch(console.error)
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
			console.error(result.error)

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
				const read = await authedSdkClient.downloadFileToBytes(
					new AnyFile.File(file),
					{
						abortSignal: signal ? wrapAbortSignalForSdk(signal) : undefined,
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
					console.warn(`Skipping malformed playlist file: ${file.uuid}`)

					return null
				}

				const now = Date.now()
				const nonExistentFileUuids = new Set<string>()

				const filesWithItems = (
					await Promise.all(
						result.files.map(async file => {
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

							return {
								...file,
								item
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
					}).catch(console.error)
				}

				return {
					...result,
					files: filesWithItems
				}
			})
		)

		return parsedPlaylists.filter(p => p !== null)
	}

	public async savePlaylist({ playlist, signal }: { playlist: Playlist; signal?: AbortSignal }): Promise<void> {
		const { authedSdkClient } = await auth.getSdkClients()
		const playlistsDir = await this.getPlaylistsDirectory(signal)

		await authedSdkClient.uploadFileFromBytes(Buffer.from(JSON.stringify(playlist), "utf-8").buffer, {
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
				abortSignal: signal ? wrapAbortSignalForSdk(signal) : undefined,
				pauseSignal: undefined
			}
		})

		const now = Date.now()
		const playlistWithItems = {
			...playlist,
			files: playlist.files.map(file => {
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
	const [status, setStatus] = useState<AudioStatus | null>(null)
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

export default audio
