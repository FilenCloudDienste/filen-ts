import * as Comlink from "comlink"
import { type } from "arktype"
import { activeLibraryOverrides, activeLibraryRoots, type ItemRec, type LibraryConfigDoc } from "@filen/shared/videos"
import type { File as SdkFile } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { settleGuard } from "@/lib/workers/settleGuard"
import { kvEntriesJsonInSlices } from "@/lib/storage/adapter"
import { nextTask } from "@/lib/nextTask"
import { createListenerSet } from "@/lib/listenerSet"
import { onSignOutPending, readSignOutPending } from "@/lib/signOutPending"
import { onAuthBroadcast } from "@/lib/sdk/session"
import {
	cachedLibraryConfig,
	ensureLibraryConfig,
	holdLibraryConfig,
	libraryConfigNeedsRead,
	persistLibraryConfigWatermark,
	setLibraryAccount
} from "@/features/videos/lib/library"
import { queryClient } from "@/queries/client"
import type { IndexRootConfig } from "@/workers/videoIndex/engine"
import type { CatalogSummary, FactsResult, GridQuery } from "@/workers/videoIndex/catalog.logic"
import type { TitleArtCandidates, VideoFileRef, VideoIndexUpdate, VideoRootStatus } from "@/workers/videoIndex/view.logic"
import type { ArtFile } from "@/features/videos/lib/artwork"
import type { ArtCandidate } from "@/features/videos/lib/artwork.logic"
import type { ArtSlotCode } from "@/features/videos/lib/artStore.logic"
import type { VideoKindCounts } from "@/features/videos/lib/libraryView.logic"
import { needsProbeFacts } from "@/features/videos/lib/videoGrid.logic"
import { PROBE_KV_PREFIX, type ProbeRecord } from "@/features/videos/lib/probeService.logic"
import { probeService } from "@/features/videos/lib/probeService"
import { holdRecordStores } from "@/features/videos/lib/recordStore.logic"
import { watchState } from "@/features/videos/lib/watchState"
import { filesWithVerdict, subscribeFileKindVerdicts } from "@/features/drive/lib/fileKindVerdicts"

// The main thread's side of the library index. The library itself stays in the SDK worker: screens ask it for the
// rows, grid pages and results they show (queries/catalog.ts), and this keeps only the root statuses, the library's
// counts and a version that changes with its content. The page's watch state and probe facts are handed to the
// worker as they change, since its rows, filters and sorts read them. Nothing here holds key material; a playable
// file is asked for when it is about to be played.

export const VIDEO_TITLE_DETAIL_KEY_PREFIX = ["videos", "title"] as const
// Every catalog query (rows, pages, results, titles): fetched again whenever the catalog or what it reads changes.
export const VIDEO_CATALOG_KEY_PREFIX = ["videos", "catalog"] as const

export interface VideoLibrarySummary {
	// Titles the library shows (hidden ones left out).
	titleCount: number
	total: VideoKindCounts
	byRoot: ReadonlyMap<string, VideoKindCounts>
	hiddenCount: number
}

export interface VideoLibrarySnapshot {
	roots: readonly VideoRootStatus[]
	// Whether the worker holds a catalog yet this session (persisted or classified).
	loaded: boolean
	// Changes with the catalog's content.
	version: number
	summary: VideoLibrarySummary
}

// How long probe facts gather before going to the worker, and how many go in one message.
const FACTS_BATCH_MS = 250
const FACTS_PART = 4000

const EMPTY_COUNTS: VideoKindCounts = { movies: 0, shows: 0, other: 0, episodes: 0 }

const EMPTY: VideoLibrarySnapshot = {
	roots: [],
	loaded: false,
	version: 0,
	summary: { titleCount: 0, total: EMPTY_COUNTS, byRoot: new Map(), hiddenCount: 0 }
}

export function indexRootsOf(doc: LibraryConfigDoc): IndexRootConfig[] {
	return activeLibraryRoots(doc).map(root => ({
		uuid: root.dirUuid,
		type: root.type,
		enabled: root.enabled
	}))
}

function summaryOf(summary: CatalogSummary): VideoLibrarySummary {
	return {
		titleCount: summary.titleCount,
		total: summary.total,
		byRoot: new Map(summary.byRoot),
		hiddenCount: summary.hiddenCount
	}
}

export interface VideoArtCandidates {
	candidates: ArtCandidate[]
	// The keyless uuid of a candidate's file: all a stored-art or drive-thumbnail lookup needs.
	fileUuid: (file: number) => string | null
	// The keyed file, rebuilt in the worker, only for a read that is about to happen.
	resolveFile: (file: number) => Promise<ArtFile | null>
}

// The watch-state records last handed to the worker, by key.
type SentWatch = Readonly<Record<string, ItemRec>>

// The two fields of a stored probe record the facts read: validating whole records (tracks, chapters) would cost
// most of a 20k-record load.
const probeFactsSchema = type({
	probe: type({ v: "1", durationSec: "number | null", video: type({ h: "number" }).or("null") }).or("null")
})

function factsOf(record: Pick<ProbeRecord, "probe"> | typeof probeFactsSchema.infer): { durationSec: number | null; height: number } {
	return {
		durationSec: record.probe?.durationSec ?? null,
		height: record.probe?.video?.h ?? 0
	}
}

// Held by the one tab that writes the index snapshots while its library is open; the next tab takes over once it
// closes.
const INDEX_WRITER_LOCK = "filen-web-videos-index-writer"

class VideoLibraryClient {
	private snapshot = EMPTY
	private readonly changes = createListenerSet("videos.library")
	private attached = false
	private detach: (() => void) | null = null
	private opening: Promise<void> | null = null
	private releaseWriter: (() => void) | null = null
	// Keyed files asked for and not resolved yet; nothing keyed is kept once handed over.
	private readonly artFiles = new Map<string, Promise<ArtFile | null>>()
	private readonly artBatch = new Map<string, { ref: VideoFileRef; resolve: (file: ArtFile | null) => void }>()
	// The manual corrections last handed to the worker, serialized.
	private sentOverrides = "{}"
	// The notTransportStream verdicts last handed to the index, as a signature.
	private sentNotTransportStream = ""
	private sentWatch: SentWatch | null = null
	private sentCeiling: number | undefined = undefined
	// Probe facts gathered for a while (probes land in bursts) to go to the worker together.
	private readonly pendingFacts = new Map<string, { durationSec: number | null; height: number }>()
	private factsTimer: ReturnType<typeof setTimeout> | null = null
	private allFacts: Promise<void> | null = null
	private generation = 0

	public readonly subscribe = (listener: () => void): (() => void) => this.changes.subscribe(listener)

	public readonly getSnapshot = (): VideoLibrarySnapshot => this.snapshot

	private apply(update: VideoIndexUpdate): void {
		if (update.type === "roots") {
			this.snapshot = {
				...this.snapshot,
				roots: update.roots
			}
			this.changes.emit()

			return
		}

		this.snapshot = {
			...this.snapshot,
			loaded: true,
			version: update.version,
			summary: summaryOf(update.summary)
		}

		this.invalidateCatalog()

		// A title's details follow its view: those of the titles that changed, all of them when the catalog was
		// (re)loaded (it may bring a title a detail page asked for before it was known).
		if (update.titles === null) {
			void queryClient.invalidateQueries({ queryKey: VIDEO_TITLE_DETAIL_KEY_PREFIX })
		} else if (update.titles.length > 0) {
			const changed = new Set(update.titles)

			void queryClient.invalidateQueries({
				queryKey: VIDEO_TITLE_DETAIL_KEY_PREFIX,
				predicate: query => typeof query.queryKey[2] === "string" && changed.has(query.queryKey[2])
			})
		}

		this.changes.emit()
	}

	// The screens fetch what they show again (only mounted queries refetch; the others are dropped soon).
	private invalidateCatalog(): void {
		void queryClient.invalidateQueries({ queryKey: VIDEO_CATALOG_KEY_PREFIX })
	}

	// Hands the watch state's changed records to the worker; the screens refetch once it holds them.
	private sendWatch(): void {
		const { doc, lastPlayedCeilingMs } = watchState.getSnapshot()
		const previous = this.sentWatch

		if (previous === doc.items && this.sentCeiling === lastPlayedCeilingMs) {
			return
		}

		const upserts: Record<string, ItemRec> = {}
		const removed: string[] = []
		let changes = 0

		for (const [key, rec] of Object.entries(doc.items)) {
			const before = previous?.[key]

			if (before !== rec && (before === undefined || JSON.stringify(before) !== JSON.stringify(rec))) {
				upserts[key] = rec
				changes++
			}
		}

		for (const key of Object.keys(previous ?? {})) {
			if (!(key in doc.items)) {
				removed.push(key)
				changes++
			}
		}

		const reset = previous === null

		this.sentWatch = doc.items

		if (!reset && changes === 0 && this.sentCeiling === lastPlayedCeilingMs) {
			return
		}

		this.sentCeiling = lastPlayedCeilingMs
		sdkApi
			.videoCatalogSetWatch({ reset, upserts, removed, lastPlayedCeilingMs })
			.then(() => {
				this.invalidateCatalog()
			})
			.catch((e: unknown) => {
				log.warn("videos.library", "handing the watch state to the library failed", e)
				// The next change sends everything again.
				this.sentWatch = null
			})
	}

	private queueFacts(uuid: string, record: ProbeRecord): void {
		this.pendingFacts.set(uuid, factsOf(record))

		this.factsTimer ??= setTimeout(() => {
			const entries = [...this.pendingFacts]

			this.factsTimer = null
			this.pendingFacts.clear()
			this.sendFacts(entries).catch((e: unknown) => {
				log.warn("videos.library", "handing probe facts to the library failed", e)
			})
		}, FACTS_BATCH_MS)
	}

	// In parts, so no single message (or its handling on either side) holds a thread for long; sent one task apart
	// without waiting for the answers (the worker takes them in order), the screens refetching once, after the last.
	private async sendFacts(entries: readonly [string, { durationSec: number | null; height: number }][]): Promise<void> {
		const parts: Promise<FactsResult>[] = []

		for (let at = 0; at < entries.length; at += FACTS_PART) {
			const part = entries.slice(at, at + FACTS_PART)

			if (at > 0) {
				await nextTask()
			}

			parts.push(
				sdkApi.videoCatalogSetFacts({
					reset: false,
					uuids: part.map(([uuid]) => uuid),
					durations: part.map(([, facts]) => facts.durationSec),
					heights: part.map(([, facts]) => facts.height)
				})
			)
		}

		const results = await Promise.all(parts)

		this.invalidateForFacts({
			changed: results.some(result => result.changed),
			affectsWatch: results.some(result => result.affectsWatch)
		})
	}

	// Facts change the grids whose order reads them; rows too when they reached a title with watch-state records
	// (they decide what counts as played).
	private invalidateForFacts({ changed, affectsWatch }: FactsResult): void {
		if (affectsWatch) {
			this.invalidateCatalog()

			return
		}

		if (changed) {
			void queryClient.invalidateQueries({
				queryKey: [...VIDEO_CATALOG_KEY_PREFIX, "grid"],
				predicate: query =>
					typeof query.queryKey[3] === "string" && needsProbeFacts((JSON.parse(query.queryKey[3]) as GridQuery).prefs)
			})
		}
	}

	// Every stored probe's runtime and picture height, handed to the worker once per session (the grids' runtime
	// sort and resolution filter read them). Local reads only; never probes.
	public loadProbeFacts(): Promise<void> {
		const generation = this.generation

		this.allFacts ??= kvEntriesJsonInSlices(PROBE_KV_PREFIX, probeFactsSchema, (key, record): [string, ReturnType<typeof factsOf>] => [
			key.startsWith(PROBE_KV_PREFIX) ? key.slice(PROBE_KV_PREFIX.length) : key,
			factsOf(record)
		])
			.then(entries => (generation === this.generation ? this.sendFacts(entries) : undefined))
			.catch((e: unknown) => {
				this.allFacts = null

				throw e
			})

		return this.allFacts
	}

	// Subscribes to the worker once per session. One tab with the library open writes the snapshots, now and when
	// the page goes away, until a sign-out starts here or in any other tab: from then on nothing of the account is
	// persisted.
	private attach(): void {
		if (this.attached) {
			return
		}

		this.attached = true

		// Detached at sign-out: an update the worker sent before it dropped its index would bring the account's back.
		const updates = settleGuard((update: VideoIndexUpdate) => {
			this.apply(update)
		})

		void sdkApi.videoIndexSubscribe(Comlink.proxy(updates.callback))

		const flush = (): void => {
			if (readSignOutPending()) {
				this.hold()

				return
			}

			persistLibraryConfigWatermark()
			void sdkApi.videoIndexFlush()
		}
		const onVisibility = (): void => {
			if (document.visibilityState === "hidden") {
				flush()
			}
		}
		const hold = (): void => {
			this.hold()
		}

		this.claimWriter()

		const unwatchSignOut = onSignOutPending(hold)
		const unwatchAuth = onAuthBroadcast(message => {
			if (message.kind === "logout") {
				hold()
			}
		})

		document.addEventListener("visibilitychange", onVisibility)
		window.addEventListener("pagehide", flush)

		// A `.ts` a content read found to be TypeScript leaves the library (the index keeps it otherwise).
		const sendVerdicts = (): void => {
			const uuids = filesWithVerdict("notTransportStream")
			const signature = uuids.join(",")

			if (signature !== this.sentNotTransportStream) {
				this.sentNotTransportStream = signature
				void sdkApi.videoIndexSetNotTransportStreams(uuids)
			}
		}
		const unwatchVerdicts = subscribeFileKindVerdicts(sendVerdicts)
		const unwatchState = watchState.subscribe(() => {
			this.sendWatch()
		})
		const unwatchProbes = probeService.onRecord((uuid, record) => {
			this.queueFacts(uuid, record)
		})

		sendVerdicts()
		this.sendWatch()

		this.detach = () => {
			updates.settle()
			unwatchVerdicts()
			unwatchState()
			unwatchProbes()
			unwatchSignOut()
			unwatchAuth()
			document.removeEventListener("visibilitychange", onVisibility)
			window.removeEventListener("pagehide", flush)
		}
	}

	// This tab writes the snapshots once it holds the writer lock (at once where Web Locks are missing).
	private claimWriter(): void {
		const generation = this.generation
		const take = (): void => {
			if (!readSignOutPending()) {
				void sdkApi.videoIndexSetWriter(true)
			}
		}

		if (typeof navigator.locks === "undefined") {
			take()

			return
		}

		navigator.locks
			.request(INDEX_WRITER_LOCK, () => {
				if (generation !== this.generation) {
					return undefined
				}

				take()

				return new Promise<void>(resolve => {
					this.releaseWriter = resolve
				})
			})
			.catch((e: unknown) => {
				log.warn("videos.library", "index writer lock failed", e)
			})
	}

	// A sign-out started: snapshot writes stop (one under way is abandoned), and neither the configuration nor the
	// probe, artwork, frame and NFO records persist anything.
	public hold(): void {
		holdLibraryConfig()
		holdRecordStores()
		void sdkApi.videoIndexSetWriter(false)
	}

	// Brings the library current: the persisted catalog (or the cached roots' snapshots) renders first; then, when
	// the session hasn't checked yet, one request for the drive's latest event id decides what still needs reading.
	public open(): Promise<void> {
		this.opening ??= this.runOpen().finally(() => {
			this.opening = null
		})

		return this.opening
	}

	private async runOpen(): Promise<void> {
		this.attach()
		setLibraryAccount(await sdkApi.videoIndexAccount())

		const cachedConfig = cachedLibraryConfig()
		const indexNeedsCheck = cachedConfig === undefined ? true : await this.applyConfig(cachedConfig.doc)

		if (!indexNeedsCheck && !libraryConfigNeedsRead()) {
			return
		}

		const watermark = await sdkApi.getLastDriveEventId()
		const config = await ensureLibraryConfig(watermark)

		await this.applyConfig(config.doc)
		await sdkApi.videoIndexCheck(watermark)
	}

	// Hands the configuration's roots, and its corrections when they changed, to the index; resolves whether a check
	// against the drive is needed.
	private async applyConfig(doc: LibraryConfigDoc): Promise<boolean> {
		const overrides = activeLibraryOverrides(doc)
		const signature = JSON.stringify(overrides)

		if (signature !== this.sentOverrides) {
			await sdkApi.videoIndexSetOverrides(overrides)
			this.sentOverrides = signature
		}

		return sdkApi.videoIndexConfigure(indexRootsOf(doc))
	}

	// Applies a changed root list (an edit of the configuration) to the index. Resolves once the index holds the
	// new roots; `scanned` settles when the scans that started for them do.
	public async configure(doc: LibraryConfigDoc): Promise<{ scanned: Promise<void> }> {
		this.attach()

		return {
			scanned: (await this.applyConfig(doc)) ? sdkApi.videoIndexCheck() : Promise.resolve()
		}
	}

	public async rescan(rootUuid: string): Promise<VideoRootStatus | null> {
		this.attach()

		return sdkApi.listVideoRoot(rootUuid, {
			rescan: true
		})
	}

	// Roots whose scan never started (applying the configuration or the first check failed): the configuration is
	// applied again and they are walked now.
	public async retry(rootUuids: readonly string[]): Promise<void> {
		const config = cachedLibraryConfig()

		if (config !== undefined) {
			await (
				await this.configure(config.doc)
			).scanned
		}

		await Promise.all(rootUuids.map(uuid => this.rescan(uuid)))
	}

	// Stops showing a root's scan; the index keeps what it had.
	public async stopScan(rootUuid: string): Promise<void> {
		await sdkApi.stopVideoRootWalk(rootUuid)
	}

	// Drive files to play or probe, for titles the index holds.
	public async playableFiles(stableUuids: string[]): Promise<SdkFile[]> {
		try {
			return await sdkApi.playableVideoFiles(stableUuids)
		} catch (e) {
			log.warn("videos.library", "playable files unavailable", e)

			return []
		}
	}

	// The videos a card's Mark watched / unwatched applies to: every version of its episode or movie (its group),
	// every episode of its series.
	public markTargets(titleId: string, group: string | null): Promise<string[]> {
		return sdkApi.videoCatalogMarkTargets(titleId, group)
	}

	// Builds the worker's search index ahead of the first query (an empty one answers nothing).
	public prepareSearch(): void {
		sdkApi.videoCatalogSearch("").catch((e: unknown) => {
			log.warn("videos.library", "preparing library search failed", e)
		})
	}

	// Post-play after a movie: the next unwatched one from the same library directory.
	public nextMovie(titleId: string): Promise<{ id: string; title: string } | null> {
		return sdkApi.videoCatalogNextMovie(titleId)
	}

	// The file behind a keyless ref, as the art loader takes it right before a read. Refs asked for in the same task
	// go to the worker as one call (rebuilt from the index there, no request); nothing keyed stays here afterwards.
	public resolveArtFile(ref: VideoFileRef): Promise<ArtFile | null> {
		const key = `${ref.stableUuid}:${ref.uuid}`
		let resolved = this.artFiles.get(key)

		if (resolved !== undefined) {
			return resolved
		}

		resolved = new Promise<ArtFile | null>(resolve => {
			this.artBatch.set(key, { ref, resolve })
		}).finally(() => {
			this.artFiles.delete(key)
		})
		this.artFiles.set(key, resolved)

		if (this.artBatch.size === 1) {
			queueMicrotask(() => {
				void this.flushArtBatch()
			})
		}

		return resolved
	}

	private async flushArtBatch(): Promise<void> {
		const batch = [...this.artBatch.values()]

		this.artBatch.clear()

		// Two refs of one lineage (an older version and the head) share the lookup; each is answered.
		const files = await this.playableFiles([...new Set(batch.map(entry => entry.ref.stableUuid))])
		const byUuid = new Map<string, SdkFile>(files.map(file => [file.uuid, file]))

		for (const { ref, resolve } of batch) {
			// Gone, or a newer version since the ref was handed out: null.
			const file = byUuid.get(ref.uuid)

			resolve(
				file === undefined
					? null
					: {
							uuid: file.uuid,
							size: ref.size,
							file
						}
			)
		}
	}

	// A slot's art candidates for a title, with a resolver for the files they name.
	public async titleArt(id: string, slot: ArtSlotCode): Promise<VideoArtCandidates | null> {
		return this.artCandidates(await sdkApi.videoTitleArt(id, slot))
	}

	// One video's art: an episode's own still, else its title's.
	public async itemArt(titleId: string, stableUuid: string, slot: ArtSlotCode): Promise<VideoArtCandidates | null> {
		return this.artCandidates(await sdkApi.videoItemArt(titleId, stableUuid, slot))
	}

	private artCandidates(art: TitleArtCandidates | null): VideoArtCandidates | null {
		return art === null
			? null
			: {
					candidates: art.candidates,
					fileUuid: file => art.files[file]?.uuid ?? null,
					resolveFile: file => {
						const ref = art.files[file]

						return ref === undefined ? Promise.resolve(null) : this.resolveArtFile(ref)
					}
				}
	}

	// Logout: the worker drops its index with the client; nothing of it stays here either.
	public reset(): void {
		this.detach?.()
		this.detach = null
		this.attached = false
		this.opening = null
		this.sentOverrides = "{}"
		this.sentNotTransportStream = ""
		this.sentWatch = null
		this.sentCeiling = undefined
		this.pendingFacts.clear()

		if (this.factsTimer !== null) {
			clearTimeout(this.factsTimer)
			this.factsTimer = null
		}

		this.allFacts = null
		this.generation++
		this.releaseWriter?.()
		this.releaseWriter = null
		this.artFiles.clear()
		this.snapshot = EMPTY
		this.changes.emit()
	}
}

export const videoLibrary = new VideoLibraryClient()
