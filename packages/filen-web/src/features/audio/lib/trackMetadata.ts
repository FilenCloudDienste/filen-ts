import { onlineManager } from "@tanstack/react-query"
import { InFlight } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { defaultObjectUrlFns, type ObjectUrlFns } from "@/lib/objectUrl"
import { readThumbnailBlob } from "@/features/drive/lib/thumbCache"
import { capacityForVisibleSlots, createThumbnailUrlCache, type ThumbnailUrlCache } from "@/features/drive/lib/thumbnailUrlCache"
import { JobQueue, type QueuedJob } from "@/features/audio/lib/trackMetadata.logic"
import { COVER_THUMBNAIL_TYPE, type TrackTagRecord } from "@/features/audio/lib/trackTags.logic"
import {
	adoptPersistedTrackTags,
	getTrackTags,
	hydrateTrackTags,
	putTrackTags,
	resetTrackTags
} from "@/features/audio/store/useTrackTagsStore"
import type { QueueTrack } from "@/features/audio/store/audioQueue"
import type { AudioMetadataResult } from "@/workers/audioMetadata"

// Reads a track's tags and cover thumbnail on demand, for whichever surface is showing that track right
// now: a playlist row on screen, or the player's current/next track. Every answer is persisted (tags in
// kv, the thumbnail in the OPFS thumbnail cache), so each track is read once, ever, per content version.
// The SDK owns network concurrency and retries; the queue here only bounds how many parses this page has
// in flight, which is what bounds their memory.

const CONCURRENT_READS = 4

// A track whose bytes would not arrive this many times is left alone for the rest of the session, until
// the connection comes back.
const FAILURE_LIMIT = 3

// Rows on screen plus the playlist sidebar's artwork.
const COVER_URL_SLOTS = 48

export type TrackMetadataOutcome = { type: "ready"; record: TrackTagRecord; thumbnail: Blob | null } | { type: "unavailable" }

export interface TrackMetadataRequest {
	promise: Promise<TrackMetadataOutcome>
	// Drops the caller's interest; the read itself is dropped only if nobody else wants it and it has not
	// started.
	cancel: () => void
}

export interface TrackMetadataRequestOptions {
	// The player's track: goes to the front of the queue.
	priority?: boolean
	// The file's bytes, when the page already holds them: parsed locally, with no download.
	local?: Blob
	// Parse again although a record exists: its cover thumbnail left the cache.
	refresh?: boolean
}

export interface TrackMetadataDeps extends ObjectUrlFns {
	readRemote: (track: QueueTrack, token: string) => Promise<AudioMetadataResult>
	readLocal: (blob: Blob, uuid: string, token: string) => Promise<AudioMetadataResult>
	cancelRead: (token: string) => void
	readThumbnail: (uuid: string) => Promise<Blob | null>
	isOnline: () => boolean
	now: () => number
}

interface Pending {
	promise: Promise<TrackMetadataOutcome>
	resolve: (outcome: TrackMetadataOutcome) => void
	job: QueuedJob | null
	holders: number
	started: boolean
}

const UNAVAILABLE: TrackMetadataOutcome = { type: "unavailable" }

export class TrackMetadataService {
	private readonly deps: TrackMetadataDeps
	private readonly queue = new JobQueue(CONCURRENT_READS)
	private readonly pending = new Map<string, Pending>()
	private readonly failures = new Map<string, number>()
	// Tracks already re-read this session for an evicted cover, so a thumbnail cache that keeps losing
	// the write can never turn every remount into another download.
	private readonly refreshed = new Set<string>()
	private readonly readTokens = new Set<string>()
	private readonly coverUrls: ThumbnailUrlCache
	private readonly coverReads = new InFlight<string, string | null>()
	// Bumped by reset, so a read that settles after logout writes nothing back.
	private epoch = 0

	public constructor(deps: TrackMetadataDeps) {
		this.deps = deps
		this.coverUrls = createThumbnailUrlCache(capacityForVisibleSlots(COVER_URL_SLOTS), (_uuid, url) => {
			deps.revokeObjectUrl(url)
		})
	}

	// Coming back online gives every track that failed to read a fresh budget.
	public onReconnect(): void {
		this.failures.clear()
	}

	public request(track: QueueTrack, options: TrackMetadataRequestOptions = {}): TrackMetadataRequest {
		const existing = this.pending.get(track.uuid)

		if (existing !== undefined) {
			existing.holders++

			if (options.priority === true) {
				existing.job?.prioritize()
			}

			return this.handle(track.uuid, existing)
		}

		if (
			(this.failures.get(track.uuid) ?? 0) >= FAILURE_LIMIT ||
			(options.local === undefined && !this.deps.isOnline()) ||
			(options.refresh === true && this.refreshed.has(track.uuid))
		) {
			return { promise: Promise.resolve(UNAVAILABLE), cancel: () => undefined }
		}

		const { promise, resolve } = Promise.withResolvers<TrackMetadataOutcome>()
		const entry: Pending = { promise, resolve, job: null, holders: 1, started: false }
		const epoch = this.epoch

		this.pending.set(track.uuid, entry)
		entry.job = this.queue.enqueue(async () => {
			entry.started = true

			// Counted once it runs: a refresh dropped before starting (its row scrolled away) used nothing.
			if (options.refresh === true) {
				this.refreshed.add(track.uuid)
			}

			resolve(await this.read(track, options, epoch).catch(() => UNAVAILABLE))
		}, options.priority === true)

		void promise.finally(() => {
			if (this.pending.get(track.uuid) === entry) {
				this.pending.delete(track.uuid)
			}
		})

		return this.handle(track.uuid, entry)
	}

	private handle(uuid: string, entry: Pending): TrackMetadataRequest {
		let cancelled = false

		return {
			promise: entry.promise,
			cancel: () => {
				if (cancelled) {
					return
				}

				cancelled = true
				entry.holders--

				if (entry.holders > 0 || entry.started) {
					return
				}

				entry.job?.cancel()

				if (this.pending.get(uuid) === entry) {
					this.pending.delete(uuid)
				}

				entry.resolve(UNAVAILABLE)
			}
		}
	}

	private async read(track: QueueTrack, options: TrackMetadataRequestOptions, epoch: number): Promise<TrackMetadataOutcome> {
		await hydrateTrackTags()

		if (options.refresh !== true) {
			const known = getTrackTags(track.uuid) ?? (await adoptPersistedTrackTags(track.uuid))

			if (known !== null) {
				return { type: "ready", record: known, thumbnail: null }
			}
		}

		if (epoch !== this.epoch) {
			return UNAVAILABLE
		}

		const token = crypto.randomUUID()
		let result: AudioMetadataResult

		this.readTokens.add(token)

		try {
			result =
				options.local !== undefined
					? await this.deps.readLocal(options.local, track.uuid, token)
					: await this.deps.readRemote(track, token)
		} catch (error) {
			if (epoch === this.epoch) {
				log.warn("audio", "track metadata read failed", error)
				this.countFailure(track.uuid)
			}

			return UNAVAILABLE
		} finally {
			this.readTokens.delete(token)
		}

		if (epoch !== this.epoch) {
			return UNAVAILABLE
		}

		if (result.type === "readFailed") {
			this.countFailure(track.uuid)

			return UNAVAILABLE
		}

		if (result.type === "unparseable") {
			const record: TrackTagRecord = {
				title: null,
				artist: null,
				album: null,
				durationSec: null,
				cover: false,
				parsed: false,
				at: this.deps.now()
			}

			putTrackTags(track.uuid, record)

			return { type: "ready", record, thumbnail: null }
		}

		const thumbnail =
			result.thumbnail !== null ? new Blob([result.thumbnail as Uint8Array<ArrayBuffer>], { type: COVER_THUMBNAIL_TYPE }) : null
		const record: TrackTagRecord = { ...result.tags, cover: thumbnail !== null, parsed: true, at: this.deps.now() }

		putTrackTags(track.uuid, record)

		if (thumbnail !== null) {
			this.setCoverUrl(track.uuid, thumbnail)
		}

		return { type: "ready", record, thumbnail }
	}

	private countFailure(uuid: string): void {
		this.failures.set(uuid, (this.failures.get(uuid) ?? 0) + 1)
	}

	private setCoverUrl(uuid: string, blob: Blob): string {
		const previous = this.coverUrls.delete(uuid)

		if (previous !== undefined) {
			this.deps.revokeObjectUrl(previous)
		}

		const url = this.deps.createObjectUrl(blob)

		this.coverUrls.set(uuid, url)

		return url
	}

	// A live cover URL for `uuid`, without any I/O.
	public peekCoverUrl(uuid: string): string | null {
		return this.coverUrls.get(uuid) ?? null
	}

	// A cover URL from the thumbnail cache: a local read, never a download. null when the cache holds none.
	public loadCoverUrl(uuid: string): Promise<string | null> {
		const cached = this.coverUrls.get(uuid)

		if (cached !== undefined) {
			return Promise.resolve(cached)
		}

		const epoch = this.epoch

		return this.coverReads.coalesce(uuid, async () => {
			const blob = await this.deps.readThumbnail(uuid).catch((error: unknown) => {
				log.warn("audio", "cover thumbnail read failed", error)

				return null
			})

			if (blob === null || epoch !== this.epoch) {
				return null
			}

			return this.setCoverUrl(uuid, blob)
		})
	}

	// The thumbnail the player hands to its own cover cache: from the thumbnail cache when the track has
	// been read before (no network), otherwise from a priority read of the track itself. `local` is the
	// file's bytes when the player already holds them, read in place of a download. null when the track
	// could not be read this time.
	public async playbackCover(track: QueueTrack, local?: Blob): Promise<{ cover: Blob | null } | null> {
		await hydrateTrackTags()

		const known = getTrackTags(track.uuid)

		if (known !== undefined && !known.cover) {
			return { cover: null }
		}

		if (known !== undefined) {
			const cached = await this.deps.readThumbnail(track.uuid).catch(() => null)

			if (cached !== null) {
				return { cover: cached }
			}
		}

		const outcome = await this.request(track, {
			priority: true,
			refresh: known !== undefined,
			...(local !== undefined ? { local } : {})
		}).promise

		return outcome.type === "ready" ? { cover: outcome.thumbnail } : null
	}

	// Logout: abort what is running, drop what is waiting, forget every URL and verdict.
	public reset(): void {
		this.epoch++
		this.queue.clear()

		for (const entry of this.pending.values()) {
			entry.resolve(UNAVAILABLE)
		}

		this.pending.clear()

		for (const token of this.readTokens) {
			this.deps.cancelRead(token)
		}

		this.readTokens.clear()
		this.failures.clear()
		this.refreshed.clear()

		this.coverUrls.clear()
		resetTrackTags()
	}
}

export const trackMetadata = new TrackMetadataService({
	readRemote: (track, token) => sdkApi.readAudioMetadata(track.file, track.uuid, track.mime, token),
	readLocal: (blob, uuid, token) => sdkApi.readAudioMetadataFromBlob(blob, uuid, token),
	cancelRead: token => {
		void sdkApi.cancelPreviewDownload(token)
	},
	readThumbnail: readThumbnailBlob,
	...defaultObjectUrlFns,
	isOnline: () => onlineManager.isOnline(),
	now: () => Date.now()
})

// Module scope and without React, like the thumbnail service's own reconnect hook: the subscription
// lives as long as the tab does.
onlineManager.subscribe(online => {
	if (online) {
		trackMetadata.onReconnect()
	}
})
