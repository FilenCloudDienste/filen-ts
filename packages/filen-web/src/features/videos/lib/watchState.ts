import * as Comlink from "comlink"
import {
	VIDEOS_DIR_NAME,
	WATCH_STATE_FILE_NAME,
	compareStamps,
	crossesCompletion,
	emptyWatchState,
	hideFromContinueWatching,
	hlcObserve,
	hlcTick,
	isCompletePosition,
	itemKey,
	markUnwatched,
	markWatched,
	mergeRecordMaps,
	mergeWatchState,
	parseWatchStateText,
	reconcileWatchState,
	seriesKey,
	withAudioLanguage,
	withCompletion,
	withProgress,
	withSubtitleLanguage,
	withSubtitleOffset,
	type Hlc,
	type RegisterRecord,
	type SeriesPrefs,
	type Stamp,
	type WatchItemClass,
	type WatchStateDoc
} from "@filen/shared/videos"
import { settleHeldRevisions } from "@filen/shared"
import type { File as SdkFile, FileVersion, SocketEvent } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { log } from "@/lib/log"
import { createListenerSet } from "@/lib/listenerSet"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { onSignOutPending, readSignOutPending } from "@/lib/signOutPending"
import { onAuthBroadcast } from "@/lib/sdk/session"
import { dotFilenSubdirUuid, findDotFilenSubdir, getDotFilenSubdir, noteDotFilenFile, onDotFilenSubdirForgotten } from "@/lib/dotFilen"
import { kvDelete, kvDeleteIfAt, kvDeletePrefix, kvEntriesJson, kvGetJson, kvKeys, kvSetJson } from "@/lib/storage/adapter"
import { accountQueryGet } from "@/queries/account"
import type { RecordStoreKv } from "@/features/videos/lib/recordStore.logic"
import { versionAsFile } from "@/features/videos/lib/library.logic"
import { listVideosDir } from "@/features/videos/lib/videosDirListing"
import {
	CHANNEL_NAME,
	DELETE_BATCH,
	DEVICE_KV_KEY,
	FLUSH_LOCK,
	GC_INTERVAL_MS,
	HEAD_KV_KEY,
	HIDDEN_DEDUPE_MS,
	HIDDEN_FLUSH_DELTA_SEC,
	JOURNAL_KV_PREFIX,
	JOURNAL_LOCK,
	LOGOUT_FLUSH_MS,
	META_KV_KEY,
	PEER_FLUSH_EXPIRY_MS,
	PENDING_STORAGE_KEY,
	UPLOAD_DEADLINE_MS,
	batches,
	contributingRecords,
	decodePending,
	deviceSchema,
	earliestUploadAt,
	emptyWatchMeta,
	encodePending,
	gcTargets,
	isGoneError,
	journalDoc,
	journalDue,
	journalRowKey,
	journalRowSchema,
	mergeFlushTime,
	moreUrgent,
	jitteredBackoffMs,
	nextBackoffMs,
	playbackFlushReason,
	pruneTargets,
	recentUploads,
	sameBytes,
	versionOf,
	watchHeadSchema,
	watchMetaSchema,
	wipePendingWatch,
	withOwnUpload,
	type FlushReason,
	type PendingEntry,
	type PendingWatch,
	type WatchHead,
	type WatchMeta
} from "@/features/videos/lib/watchState.logic"

// Watch progress, played marks and per-series track languages, synced as `.filen/videos/watch-state.v1.json`.
//
// Every change is a stamped register written first to a kv journal (any tab), then merged into the synced file by
// one flush at a time per browser. A flush reads the file only when its uuid changed, and uploads only when the
// merge adds something: each upload is a new file version (six requests, echoed to every session), so unchanged
// state is never written. Superseded versions this browser wrote are deleted again, never the live one.

export interface WatchItem {
	stableUuid: string
	// The file being played (the progress fingerprint)
	uuid: string
	size: number
	itemClass: WatchItemClass
	// Stack part index
	part?: number
}

export interface WatchStateSnapshot {
	// The synced document merged with what is journaled here and not uploaded yet.
	doc: WatchStateDoc
	loaded: boolean
	// Another device saved since this one last read the file; the next open reads it.
	unsynced: boolean
	// Changes journaled and not uploaded yet (a sign-out now would lose them).
	dirty: boolean
	// Play times shown are capped here (the head file's time plus a few minutes), against fast clocks.
	lastPlayedCeilingMs: number | undefined
}

const LAST_PLAYED_SLACK_MS = 5 * 60_000

// Versions tried when the head doesn't parse.
const CORRUPT_HEAD_VERSIONS = 3

const EMPTY_SNAPSHOT: WatchStateSnapshot = {
	doc: emptyWatchState(),
	loaded: false,
	unsynced: false,
	dirty: false,
	lastPlayedCeilingMs: undefined
}

export interface WatchStateKv extends RecordStoreKv {
	kvDeletePrefix: (prefix: string) => Promise<void>
}

export interface WatchStateSdk {
	account: () => Promise<string>
	// `.filen/videos`, resolved (memoized) or as already known; created when missing.
	videosDir: () => Promise<string>
	// `.filen/videos` when it exists, null otherwise; creates nothing.
	findVideosDir: () => Promise<string | null>
	knownVideosDir: () => string | null
	noteSystemFile: (uuid: string) => void
	getFileByStableUuid: (stableUuid: string) => Promise<SdkFile | undefined>
	listDirectory: (dirUuid: string) => Promise<SdkFile[]>
	// `.filen/videos` as listed at `startedAfter` (performance.now()) or later: a listing the library configuration
	// started since serves too. Without it, the directory is listed.
	listVideosDir?: (dirUuid: string, startedAfter: number) => Promise<SdkFile[]>
	download: (file: SdkFile) => Promise<Uint8Array>
	upload: (params: { parent: string; bytes: Uint8Array; abortToken: string }) => Promise<SdkFile>
	cancel: (abortToken: string) => void
	listVersions: (file: SdkFile) => Promise<FileVersion[]>
	deleteVersion: (version: FileVersion) => Promise<void>
}

export interface WatchStateHost {
	// The account's versioning setting as already loaded; undefined when not known.
	versioningEnabled: () => boolean | undefined
	storage: () => Storage | null
	signOutPending: () => boolean
	// Page hidden or going away; a sign-out started elsewhere. Returns the detach.
	attach: (handlers: { hidden: () => void; signOut: () => void }) => () => void
	channel: () => BroadcastChannel | null
	// 0 <= x < 1; Math.random when absent (tests pin it).
	random?: () => number
}

type DriveSocketEvent = Extract<SocketEvent, { type: "drive" }>

type PeerMessage =
	| { type: "journal"; a: string; entries: [string, RegisterRecord][] }
	| { type: "flushing"; a: string }
	| { type: "flushed"; a: string; uuid: string | null }
	| { type: "synced"; a: string }

interface Playback {
	item: WatchItem
	pos: number
	dur: number
	playing: boolean
	completed: boolean
	journaled: { pos: number; at: number } | null
	synced: { pos: number; at: number }
}

// The newest save from elsewhere not read yet: the tracking epoch when it was seen, and its order among the saves
// seen (a head lookup started after it covers it).
interface RemoteSave {
	file: SdkFile
	epoch: number
	seq: number
}

interface HeadRef {
	uuid: string
	stable: string
	parent: string
	timestamp: number
}

interface Remote {
	ref: HeadRef | null
	doc: WatchStateDoc
	// null: `.filen/videos` doesn't exist yet; an upload creates it.
	parent: string | null
	// The head didn't parse and a previous version stood in: it is replaced whatever the merge says.
	repair: boolean
}

type DocEdit = (doc: WatchStateDoc, stamp: Stamp) => RegisterRecord

interface RecordEdit {
	key: string
	edit: (doc: WatchStateDoc) => RegisterRecord | null
}

function isStateFileName(file: SdkFile): boolean {
	return file.meta.type === "decoded" && file.meta.data.name.toLowerCase() === WATCH_STATE_FILE_NAME
}

function refOf(file: SdkFile): HeadRef | null {
	return file.stableUUID === undefined
		? null
		: {
				uuid: file.uuid,
				stable: file.stableUUID,
				parent: file.parent,
				timestamp: Number(file.timestamp)
			}
}

function randomId(length: number): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, length)
}

function recordOf(doc: WatchStateDoc, key: string): RegisterRecord | undefined {
	return doc.items[key] ?? doc.series[key]
}

function encodeDoc(doc: WatchStateDoc): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(doc))
}

export class WatchStateEngine {
	private readonly tab = randomId(4)
	private writer = ""
	private account: string | null = null
	private loaded = false
	private clock: Hlc = 0
	private opening: Promise<void> | null = null
	private openedOnce = false
	private firstOpen: Promise<void> | null = null
	private closed = false

	private head: WatchHead | null = null
	private headDoc: WatchStateDoc = emptyWatchState()
	// The head row's generation last read (meta.hg); -1 before the first read.
	private headGen = -1
	private meta: WatchMeta | null = null
	// Journal rows as last read or written, by record key (every tab's).
	private rows = new Map<string, RegisterRecord>()
	private snapshot = EMPTY_SNAPSHOT
	// The merged view and what it was built from.
	private view: { rowsKey: string; head: WatchStateDoc; doc: WatchStateDoc } = {
		rowsKey: "",
		head: EMPTY_SNAPSHOT.doc,
		doc: EMPTY_SNAPSHOT.doc
	}
	private readonly changes = createListenerSet("videos.watchState")

	// The head uuid the socket vouches for this session; null = look it up before trusting the cached one.
	private currentUuid: string | null = null
	// Bumped whenever the socket can no longer vouch.
	private epoch = 0
	// Since when (performance.now()) the socket has vouched without a gap: a listing that started since misses no save
	// the socket didn't report.
	private vouchedSince = Number.POSITIVE_INFINITY
	// The head as the session's first open confirmed it, in that epoch: the weekly version listing right after needs
	// no second lookup while the socket still vouches for it.
	private confirmedHead: { file: SdkFile; epoch: number } | null = null
	private remoteSave: RemoteSave | null = null
	private saveSeq = 0
	// A head this version can't use (a newer schema, or unreadable with no readable version); left alone.
	private blockedHead: string | null = null
	private dirForgotten = false
	// The head was permanently deleted: the next flush writes the state anew.
	private headGone = false
	// Uploads made by this browser this session, and the saves echoed while one is out (here or in another tab).
	private readonly ownUuids = new Set<string>()
	private held: SdkFile[] | null = null
	private peerHeld: SdkFile[] | null = null
	private peerHeldAt = 0
	private peerEpoch = 0
	private uploadToken: string | null = null

	private timer: ReturnType<typeof setTimeout> | null = null
	private timerAt: number | null = null
	private timerReason: FlushReason | null = null
	// Flushes running here, and the one trigger that arrived meanwhile (scheduled once they end).
	private flushes = 0
	private followUp: FlushReason | null = null
	// Semantic changes made, and how many of them the last successful flush covered.
	private semanticEdits = 0
	private semanticSynced = 0
	private lastHiddenAt = -Infinity
	private pruneDue = false
	private playback: Playback | null = null
	private channel: BroadcastChannel | null = null
	private detach: (() => void) | null = null
	private executing: Promise<void> | null = null
	private readonly work = new Set<Promise<unknown>>()

	private readonly kv: WatchStateKv
	private readonly sdk: WatchStateSdk
	private readonly host: WatchStateHost

	public constructor({ kv, sdk, host }: { kv: WatchStateKv; sdk: WatchStateSdk; host: WatchStateHost }) {
		this.kv = kv
		this.sdk = sdk
		this.host = host
	}

	public readonly subscribe = (listener: () => void): (() => void) => this.changes.subscribe(listener)

	public readonly getSnapshot = (): WatchStateSnapshot => this.snapshot

	// ── Player API ──

	// Call on every position update of the playing item (timeupdate) and on play/pause. Journals at most every 15 s
	// while the position moves, and on every change of state; uploads per the pause and periodic rules.
	public reportProgress({ item, pos, dur, playing }: { item: WatchItem; pos: number; dur: number; playing: boolean }): void {
		if (!this.writable()) {
			return
		}

		const now = Date.now()
		const previous = this.playback
		const switched = !(previous?.item.stableUuid === item.stableUuid && previous.item.uuid === item.uuid)

		if (switched && previous !== null) {
			void this.endPlayback(previous, false)
		}

		const playback: Playback = switched
			? {
					item,
					pos,
					dur,
					playing: false,
					completed: false,
					journaled: null,
					synced: {
						pos,
						at: now
					}
				}
			: previous

		const from = playback.pos
		const wasPlaying = playback.playing
		const crossed =
			!playback.completed &&
			crossesCompletion({
				from,
				to: pos,
				dur,
				itemClass: item.itemClass
			})

		playback.item = item
		playback.pos = pos
		playback.dur = dur
		playback.playing = playing
		playback.completed ||= crossed
		this.playback = playback

		// An item opened but not played yet isn't journaled.
		if (
			(playing || crossed || playback.journaled !== null) &&
			journalDue({
				now,
				pos,
				last: playback.journaled,
				stateChanged: crossed || wasPlaying !== playing
			})
		) {
			playback.journaled = {
				pos,
				at: now
			}
			void this.track(this.journalProgress(playback, crossed))
		}

		if (crossed) {
			this.semanticEdits++
			this.schedule("semantic")

			return
		}

		const reason = playbackFlushReason({
			now,
			pos,
			playing,
			paused: wasPlaying && !playing,
			synced: playback.synced,
			lastUploadAt: this.meta?.up.at(-1) ?? -Infinity
		})

		if (reason !== null) {
			this.schedule(reason)
		}
	}

	// Playback of `item` ended: closed, another item chosen, or played to the end (`ended`).
	public reportStop({ item, pos, dur, ended = false }: { item: WatchItem; pos: number; dur: number; ended?: boolean }): Promise<void> {
		if (!this.writable()) {
			return Promise.resolve()
		}

		const current = this.playback

		const playback: Playback =
			current !== null && current.item.stableUuid === item.stableUuid
				? current
				: {
						item,
						pos,
						dur,
						playing: false,
						completed: false,
						journaled: null,
						synced: {
							pos,
							at: Date.now()
						}
					}

		const from = playback.pos

		playback.item = item
		playback.pos = pos
		playback.dur = dur

		if (
			!playback.completed &&
			(crossesCompletion({
				from,
				to: pos,
				dur,
				itemClass: item.itemClass
			}) ||
				(ended &&
					isCompletePosition({
						pos,
						dur,
						itemClass: item.itemClass,
						ended
					})))
		) {
			playback.completed = true

			return this.endPlayback(playback, true)
		}

		return this.endPlayback(playback, false)
	}

	// The player let go of an item it never reported a position for (it failed or was closed while loading): the
	// item stops being the one playing, and nothing is journaled for it.
	public dropPlayback({ stableUuid }: { stableUuid: string }): void {
		if (this.playback?.item.stableUuid === stableUuid) {
			this.playback = null
		}
	}

	public markWatched({ stableUuids }: { stableUuids: readonly string[] }): Promise<void> {
		return this.edit(
			stableUuids.map(stableUuid => {
				const key = itemKey(stableUuid)

				return {
					key,
					edit: (doc, stamp) =>
						markWatched({
							rec: doc.items[key],
							stamp
						})
				}
			})
		)
	}

	public markUnwatched({ stableUuids }: { stableUuids: readonly string[] }): Promise<void> {
		return this.edit(
			stableUuids.map(stableUuid => {
				const key = itemKey(stableUuid)

				return {
					key,
					edit: (doc, stamp) =>
						markUnwatched({
							rec: doc.items[key],
							stamp
						})
				}
			})
		)
	}

	// Removes the item from Continue Watching until it is played again.
	public hide({ stableUuid }: { stableUuid: string }): Promise<void> {
		const key = itemKey(stableUuid)

		return this.edit([
			{
				key,
				edit: (doc, stamp) =>
					hideFromContinueWatching({
						rec: doc.items[key],
						stamp
					})
			}
		])
	}

	public setSubtitleOffset({ stableUuid, subMs }: { stableUuid: string; subMs: number }): Promise<void> {
		const key = itemKey(stableUuid)

		return this.edit([
			{
				key,
				edit: (doc, stamp) =>
					withSubtitleOffset({
						rec: doc.items[key],
						stamp,
						subMs
					})
			}
		])
	}

	// A series' audio and subtitle language (null subtitle = off); an omitted one is left as it is.
	public setSeriesLanguages({
		seriesDirUuid,
		audio,
		subtitle
	}: {
		seriesDirUuid: string
		audio?: string
		subtitle?: string | null
	}): Promise<void> {
		const key = seriesKey(seriesDirUuid)

		return this.edit([
			{
				key,
				edit: (doc, stamp) => {
					let prefs: SeriesPrefs | undefined = doc.series[key]

					if (audio !== undefined) {
						prefs = withAudioLanguage({
							prefs,
							stamp,
							language: audio
						})
					}

					if (subtitle !== undefined) {
						prefs = withSubtitleLanguage({
							prefs,
							stamp,
							language: subtitle
						})
					}

					return prefs ?? {}
				}
			}
		])
	}

	// The Videos screen or the player opened: reads the newest save made elsewhere since (one download), and on the
	// session's first open cleans up old versions.
	// A caller arriving while the session's first open is still reading the file (the player, right after the
	// Videos layout) waits for that read, so what it decides from (a resume point) includes other devices' saves.
	public open(): Promise<void> {
		if (this.firstOpen !== null) {
			return this.firstOpen
		}

		const opening = this.runOpen()

		if (!this.openedOnce) {
			this.firstOpen = opening.finally(() => {
				this.firstOpen = null
			})

			return this.firstOpen
		}

		return opening
	}

	private async runOpen(): Promise<void> {
		await this.ready()

		const first = !this.openedOnce

		this.openedOnce = true

		if (!this.writable() || (!first && this.remoteSave === null)) {
			return
		}

		await this.track(
			navigator.locks.request(FLUSH_LOCK, async () => {
				if (!this.writable()) {
					return
				}

				this.abandonPeerFlush()
				await this.reload()

				// A page that hasn't confirmed the head yet can't know about a save made elsewhere while it was
				// closed (the socket only tells a live page): one lookup says whether the head moved.
				if (first && this.currentUuid === null && this.remoteSave === null) {
					await this.checkHead()
				}

				await this.readLatestSave()
			})
		)

		// Version cleanup runs after: the caller (a player deciding where to start) never waits for it.
		if (first) {
			void this.track(
				navigator.locks.request(FLUSH_LOCK, async () => {
					if (this.writable()) {
						await this.maintain({
							prune: true,
							gc: true
						})
					}
				})
			)
		}
	}

	// Looks the head up once: unchanged, it is confirmed for this page; moved (another device saved since), the new
	// file becomes the save from elsewhere that readLatestSave reads. With no head cached yet (a new browser), the
	// state file is found by listing `.filen/videos` when that directory exists.
	private async checkHead(): Promise<void> {
		const epoch = this.epoch
		const seq = this.saveSeq
		const head = this.head
		let file: SdkFile | null

		if (head?.s !== undefined && head.u !== undefined && !this.headGone) {
			file = await this.liveHead(head.s)

			if (file !== null && file.uuid === head.u) {
				if (this.epoch === epoch && this.remoteSave === null) {
					this.currentUuid = file.uuid
					this.confirmedHead = { file, epoch }
				}

				return
			}
		} else {
			const videosDir = await this.sdk.findVideosDir()
			const listed =
				videosDir === null
					? null
					: await (this.sdk.listVideosDir?.(videosDir, this.vouchedSince) ?? this.sdk.listDirectory(videosDir))

			file = listed?.find(isStateFileName) ?? null
		}

		// Gone or unlisted: the next flush's own lookup sorts it out.
		if (file === null || this.epoch !== epoch || this.saveSeq !== seq) {
			return
		}

		this.sdk.noteSystemFile(file.uuid)
		this.remoteSave = {
			file,
			epoch,
			seq: ++this.saveSeq
		}
	}

	// Resolves once every write and flush started so far has settled.
	public async idle(): Promise<void> {
		while (this.work.size > 0) {
			await Promise.allSettled([...this.work])
		}
	}

	// ── Sign-out ──

	// The sign-out confirm opened, or the sign-out starts: what is journaled is uploaded now, whatever the floors,
	// for at most 30 s. A call while one runs joins it.
	public executeNow(): Promise<void> {
		if (!this.writable()) {
			return Promise.resolve()
		}

		this.executing ??= this.runExecuteNow().finally(() => {
			this.executing = null
		})

		return this.executing
	}

	// A sign-out started in another tab: nothing more is written here.
	public hold(): void {
		this.closed = true
		this.clearTimer()
	}

	// This tab's sign-out, before the local wipe: no further write, the upload out is aborted, and the pending
	// progress kept in localStorage goes.
	public cancel(): void {
		this.hold()

		if (this.uploadToken !== null) {
			this.sdk.cancel(this.uploadToken)
		}

		this.detach?.()
		this.detach = null
		this.channel?.close()
		this.channel = null
		this.playback = null
		this.rows.clear()
		this.snapshot = EMPTY_SNAPSHOT
		wipePendingWatch(this.host.storage)
		this.changes.emit()
	}

	// ── Socket ──

	public handleDriveEvent(event: DriveSocketEvent): void {
		// Before the state is loaded nothing is trusted anyway: the first flush looks the head up.
		if (!this.loaded) {
			return
		}

		const inner = event.inner

		switch (inner.type) {
			case "fileNew":
			case "fileRestore":
			case "fileMove":
			case "fileArchiveRestored": {
				const file = inner.file
				const dir = this.videosDirKnown()
				const ours = this.head?.s !== undefined && file.stableUUID === this.head.s

				if (dir === null || file.parent !== dir || !isStateFileName(file)) {
					// The state file left the directory.
					if (ours) {
						this.loseHead()
					}

					return
				}

				this.expirePeerFlush()

				if (inner.type === "fileArchiveRestored") {
					// A restore makes an old version the head again, possibly one of this browser's own.
					this.noteForeign(file)
				} else if (this.held !== null) {
					this.held.push(file)
				} else if (this.peerHeld !== null) {
					this.peerHeld.push(file)
				} else if (!this.ownUuids.has(file.uuid)) {
					this.noteForeign(file)
				}

				return
			}

			case "fileTrash":
				// With newUUID a version was superseded on a versioning-disabled account: the paired fileNew carries
				// the successor through the own-upload or foreign-save path.
				if (inner.newUUID === undefined && (inner.uuid === this.head?.u || inner.uuid === this.currentUuid)) {
					this.loseHead()
				}

				return

			case "fileDeletedPermanent":
				if (inner.uuid === this.head?.u && this.writable()) {
					// The live file is gone for good (and its lineage left on an unlisted version): written anew now.
					this.headGone = true
					this.loseHead()
					void this.track(this.flush("semantic", true))
				} else if (inner.uuid === this.currentUuid) {
					this.loseHead()
				}

				return

			default:
				return
		}
	}

	// A gap in the event stream: the head may have changed unseen.
	public loseHead(): void {
		this.currentUuid = null
		this.epoch++
		this.vouchedSince = performance.now()
	}

	// `.filen/videos` was trashed, moved or renamed: looked up again before the next upload.
	public forgetDirectory(): void {
		this.dirForgotten = true
		this.loseHead()
	}

	// ── Internals ──

	private writable(): boolean {
		return !this.closed && !this.host.signOutPending()
	}

	// Background work: logged on failure, never rejecting, and awaited by idle().
	private track(promise: Promise<unknown>): Promise<void> {
		const settled = promise.then(
			() => undefined,
			(e: unknown) => {
				log.warn("videos.watchState", "watch-state work failed", e)
			}
		)

		this.work.add(settled)
		void settled.finally(() => {
			this.work.delete(settled)
		})

		return settled
	}

	private ready(): Promise<void> {
		this.opening ??= this.load().catch((e: unknown) => {
			this.opening = null

			throw e
		})

		return this.opening
	}

	private async load(): Promise<void> {
		const account = await this.sdk.account()
		const device = await this.kv.kvGetJson(DEVICE_KV_KEY, deviceSchema)
		let id = device?.id

		if (id === undefined) {
			id = randomId(10)

			if (this.writable()) {
				await this.kv.kvSetJson(DEVICE_KV_KEY, {
					id
				})
			}
		}

		this.writer = `${id}.${this.tab}`
		this.account = account

		const meta = await this.kv.kvGetJson(META_KV_KEY, watchMetaSchema)

		// Rows of another account (a sign-out whose wipe didn't land) never reach this one's file. The meta row names
		// the account before any row is written.
		if (meta?.a !== account && this.writable()) {
			await Promise.all([this.kv.kvDeletePrefix(JOURNAL_KV_PREFIX), this.kv.kvDelete(HEAD_KV_KEY)])
			await this.kv.kvSetJson(META_KV_KEY, emptyWatchMeta(account))
		}

		await this.reload()
		this.attach()
		await this.mergePending()
		this.loaded = true
		this.vouchedSince = performance.now()
		this.rebuild()

		if (this.rows.size > 0) {
			this.semanticEdits++
			this.schedule("semantic")
		}
	}

	private attach(): void {
		if (this.closed || this.detach !== null) {
			return
		}

		const channel = this.host.channel()

		if (channel !== null) {
			channel.onmessage = (event: MessageEvent<PeerMessage>) => {
				this.onPeerMessage(event.data)
			}
		}

		this.channel = channel

		const detachHost = this.host.attach({
			hidden: () => {
				this.onHidden()
			},
			signOut: () => {
				this.hold()
			}
		})

		this.detach = () => {
			detachHost()
		}
	}

	private post(message: PeerMessage): void {
		try {
			this.channel?.postMessage(message)
		} catch (e) {
			log.warn("videos.watchState", "peer message failed", e)
		}
	}

	private requireAccount(): string {
		if (this.account === null) {
			throw new Error("watch state is not open")
		}

		return this.account
	}

	// Journal and meta as kv holds them now (another tab may have flushed); the head row only when its generation
	// moved.
	private async reload(): Promise<void> {
		const account = this.requireAccount()
		const [rows, meta] = await Promise.all([
			this.kv.kvEntriesJson(JOURNAL_KV_PREFIX, journalRowSchema),
			this.kv.kvGetJson(META_KV_KEY, watchMetaSchema)
		])

		this.meta = meta?.a === account ? meta : emptyWatchMeta(account)

		if (this.meta.hg !== this.headGen) {
			const head = await this.kv.kvGetJson(HEAD_KV_KEY, watchHeadSchema)
			const nextHead = head?.a === account ? head : null

			if (nextHead?.doc !== this.head?.doc) {
				const parsed = nextHead === null ? null : parseWatchStateText(nextHead.doc)

				this.headDoc = parsed?.ok === true ? parsed.doc : emptyWatchState()
				this.observe(parsed?.ok === true ? parsed.maxStamp : 0)
			}

			this.head = nextHead
			this.headGen = this.meta.hg
		}

		this.rows = new Map(rows.map(([key, row]) => [key.slice(JOURNAL_KV_PREFIX.length), row.r]))
		this.observe(Math.max(this.meta.c, journalDoc(this.rows).maxStamp))
		this.rebuild()
	}

	private async saveMeta(patch: Partial<WatchMeta>): Promise<void> {
		const next: WatchMeta = {
			...(this.meta ?? emptyWatchMeta(this.requireAccount())),
			...patch
		}

		this.meta = next
		await this.kv.kvSetJson(META_KV_KEY, next)
	}

	private observe(seen: Hlc): void {
		this.clock = hlcObserve({
			clock: this.clock,
			seen,
			now: Date.now()
		})
	}

	private stamp(): Stamp {
		this.clock = hlcTick({
			clock: this.clock,
			now: Date.now()
		})

		return {
			t: this.clock,
			d: this.writer
		}
	}

	private rebuild(): void {
		const rowsKey = this.rows.size === 0 ? "" : JSON.stringify([...this.rows])
		const doc =
			rowsKey === this.view.rowsKey && this.headDoc === this.view.head
				? this.view.doc
				: this.rows.size === 0
					? this.headDoc
					: mergeWatchState({
							local: journalDoc(this.rows).doc,
							remote: this.headDoc
						}).doc

		this.view = {
			rowsKey,
			head: this.headDoc,
			doc
		}

		const next: WatchStateSnapshot = {
			doc,
			loaded: this.loaded,
			unsynced: this.remoteSave !== null,
			dirty: this.rows.size > 0,
			lastPlayedCeilingMs: this.head?.ts === undefined ? undefined : this.head.ts + LAST_PLAYED_SLACK_MS
		}
		const previous = this.snapshot

		// Unchanged: the same snapshot, so subscribers don't render again.
		if (
			previous.doc === next.doc &&
			previous.loaded === next.loaded &&
			previous.unsynced === next.unsynced &&
			previous.dirty === next.dirty &&
			previous.lastPlayedCeilingMs === next.lastPlayedCeilingMs
		) {
			return
		}

		this.snapshot = next
		this.changes.emit()
	}

	private videosDirKnown(): string | null {
		return this.sdk.knownVideosDir() ?? (this.dirForgotten ? null : (this.head?.dir ?? null))
	}

	// One record merged from the synced document and its journal row: what an edit builds on.
	private recordDoc(key: string, row: RegisterRecord | undefined): WatchStateDoc {
		const remote = emptyWatchState()
		const item = this.headDoc.items[key]
		const series = this.headDoc.series[key]

		if (item !== undefined) {
			remote.items[key] = item
		}

		if (series !== undefined) {
			remote.series[key] = series
		}

		return mergeWatchState({
			local: journalDoc(row === undefined ? [] : [[key, row]]).doc,
			remote
		}).doc
	}

	// Journal rows are read-modify-written under one lock across tabs, so two tabs never lose each other's register.
	// `publish` false (progress only) updates no view: nothing shown depends on a position until it is synced, so
	// neither this tab nor another renders for it.
	private async writeRecords(edits: readonly RecordEdit[], publish = true): Promise<void> {
		if (!this.writable() || edits.length === 0) {
			return
		}

		const written: [string, RegisterRecord][] = []

		await navigator.locks.request(JOURNAL_LOCK, async () => {
			for (const { key, edit } of edits) {
				if (!this.writable()) {
					return
				}

				const row = (await this.kv.kvGetJson(journalRowKey(key), journalRowSchema))?.r
				const next = edit(this.recordDoc(key, row))

				if (next === null || !this.writable()) {
					continue
				}

				await this.kv.kvSetJson(journalRowKey(key), {
					r: next
				})
				written.push([key, next])
			}
		})

		if (written.length === 0 || this.closed) {
			return
		}

		const wasClean = this.rows.size === 0

		for (const [key, rec] of written) {
			this.rows.set(key, rec)
		}

		if (!publish && !wasClean) {
			return
		}

		this.rebuild()

		if (publish) {
			this.post({
				type: "journal",
				a: this.requireAccount(),
				entries: written
			})
		}
	}

	private async journal(edits: readonly RecordEdit[], publish = true): Promise<void> {
		await this.ready()
		await this.writeRecords(edits, publish)
	}

	private edit(edits: readonly { key: string; edit: DocEdit }[]): Promise<void> {
		if (!this.writable()) {
			return Promise.resolve()
		}

		const written = this.journal(
			edits.map(({ key, edit }) => ({
				key,
				edit: doc => edit(doc, this.stamp())
			}))
		)

		this.semanticEdits++
		this.schedule("semantic")

		return this.track(written)
	}

	// `final`: a completion or the end of playback, which the views show; a mere position update isn't.
	private journalProgress(playback: Playback, completion: boolean, final = completion): Promise<void> {
		const { item, pos, dur } = playback
		const key = itemKey(item.stableUuid)

		return this.journal(
			[
				{
					key,
					edit: doc => {
						const stamp = this.stamp()
						const rec = withProgress({
							rec: doc.items[key],
							stamp,
							pos,
							dur,
							lp: Date.now(),
							uuid: item.uuid,
							size: item.size,
							part: item.part
						})

						return completion
							? withCompletion({
									rec,
									stamp
								})
							: rec
					}
				}
			],
			final
		)
	}

	private endPlayback(playback: Playback, completion: boolean): Promise<void> {
		if (this.playback === playback) {
			this.playback = null
		}

		this.pruneDue = true

		// Opened and closed without playing: nothing to record.
		if (playback.journaled === null && !completion) {
			return Promise.resolve()
		}

		this.semanticEdits++
		this.schedule("semantic")

		return this.track(this.journalProgress(playback, completion, true))
	}

	private async runExecuteNow(): Promise<void> {
		const playback = this.playback?.journaled === null ? null : this.playback
		let cancelDeadline = (): void => undefined

		const run = (async () => {
			if (playback !== null) {
				await this.journalProgress(playback, false)
			}

			await this.flush("semantic", true)
		})()

		try {
			await Promise.race([
				run.catch(() => undefined),
				new Promise<void>(resolve => {
					const timer = setTimeout(resolve, LOGOUT_FLUSH_MS)

					cancelDeadline = () => {
						clearTimeout(timer)
					}
				})
			])
		} finally {
			cancelDeadline()
		}
	}

	// ── Page lifecycle ──

	// The progress goes to localStorage synchronously and to the journal; an upload follows only once the position
	// moved 30 s since the last sync or a semantic change waits, so a tab switch costs no request.
	private onHidden(): void {
		const now = Date.now()

		if (!this.writable() || now - this.lastHiddenAt < HIDDEN_DEDUPE_MS) {
			return
		}

		this.lastHiddenAt = now

		const playback = this.playback?.journaled === null ? null : this.playback
		const semantic = this.semanticEdits > this.semanticSynced

		if (playback === null) {
			if (semantic) {
				void this.track(this.flush("semantic"))
			}

			return
		}

		const stamp = this.stamp()
		const { item } = playback
		const entry: PendingEntry = [
			item.stableUuid,
			item.uuid,
			item.size,
			playback.pos,
			playback.dur,
			now,
			stamp.t,
			stamp.d,
			item.part ?? -1
		]
		const storage = this.host.storage()

		try {
			storage?.setItem(
				PENDING_STORAGE_KEY,
				encodePending({
					previous: readPending(storage),
					account: this.requireAccount(),
					entries: [entry]
				})
			)
		} catch (e) {
			log.warn("videos.watchState", "pending progress not saved", e)
		}

		playback.journaled = {
			pos: playback.pos,
			at: now
		}

		const moved = Math.abs(playback.pos - playback.synced.pos) >= HIDDEN_FLUSH_DELTA_SEC
		const journaled = this.journalProgress(playback, false)

		void this.track(moved || semantic ? journaled.then(() => this.flush(semantic ? "semantic" : "hidden")) : journaled)
	}

	// Progress the previous page saved as it went away, unless already journaled or synced.
	private async mergePending(): Promise<void> {
		const storage = this.host.storage()
		const pending = readPending(storage)

		if (pending === null) {
			return
		}

		if (pending.a === this.account) {
			await this.writeRecords(
				pending.e.map(([stableUuid, uuid, size, pos, dur, lp, t, d, part]) => {
					const key = itemKey(stableUuid)
					const stamp = {
						t,
						d
					}

					this.observe(t)

					return {
						key,
						edit: doc => {
							const known = doc.items[key]?.p

							if (known !== undefined && compareStamps(known, stamp) >= 0) {
								return null
							}

							try {
								return withProgress({
									rec: doc.items[key],
									stamp,
									pos,
									dur,
									lp,
									uuid,
									size,
									part: part >= 0 ? part : undefined
								})
							} catch {
								// Not a valid register (a tampered entry): dropped.
								return null
							}
						}
					}
				})
			)
		}

		if (this.writable()) {
			wipePendingWatch(this.host.storage)
		}
	}

	// ── Peers ──

	private onPeerMessage(message: PeerMessage): void {
		if (this.closed || message.a !== this.account) {
			return
		}

		switch (message.type) {
			case "journal":
				for (const [key, rec] of message.entries) {
					this.rows.set(key, rec)
				}

				this.rebuild()

				return

			case "flushing":
				this.peerHeld = []
				this.peerHeldAt = Date.now()
				this.peerEpoch = this.epoch

				return

			case "flushed": {
				const echoes = this.peerHeld ?? []

				this.peerHeld = null

				if (message.uuid !== null) {
					this.ownUuids.add(message.uuid)

					if (this.remoteSave?.file.uuid === message.uuid) {
						this.remoteSave = null
					}
				}

				// The other tab's upload is the head unless a save came after it or the stream had a gap meanwhile.
				if (
					!this.settle(echoes, message.uuid) &&
					message.uuid !== null &&
					this.epoch === this.peerEpoch &&
					this.remoteSave === null
				) {
					this.currentUuid = message.uuid
				}

				this.rebuild()

				return
			}

			case "synced":
				void this.track(this.reload())

				return
		}
	}

	// Another tab's flush that never reported back (the tab died mid-upload): what it held is judged as foreign.
	private abandonPeerFlush(): void {
		const echoes = this.peerHeld

		if (echoes === null) {
			return
		}

		this.peerHeld = null
		this.settle(echoes, null)
		this.loseHead()
		this.rebuild()
	}

	private expirePeerFlush(): void {
		if (this.peerHeld !== null && Date.now() - this.peerHeldAt > PEER_FLUSH_EXPIRY_MS) {
			this.abandonPeerFlush()
		}
	}

	// The saves echoed while an upload was out. One after it means the head moved on; it is read on the next open.
	// Saves under it need nothing here: each writer finds this upload over its own and merges back what it lacks.
	// True when a newer one came.
	private settle(echoes: readonly SdkFile[], savedUuid: string | null): boolean {
		const { newer } = settleHeldRevisions(echoes, savedUuid, file => file.uuid)
		const latest = newer.filter(file => !this.ownUuids.has(file.uuid)).at(-1)

		if (newer.length > 0) {
			this.loseHead()
		}

		if (latest !== undefined) {
			this.remoteSave = {
				file: latest,
				epoch: this.epoch,
				seq: ++this.saveSeq
			}
		}

		return newer.length > 0
	}

	private noteForeign(file: SdkFile): void {
		this.loseHead()
		this.remoteSave = {
			file,
			epoch: this.epoch,
			seq: ++this.saveSeq
		}
		this.rebuild()
	}

	// A head lookup that started after the save was seen covers it.
	private dropRemoteSavesThrough(seq: number): void {
		if (this.remoteSave !== null && this.remoteSave.seq <= seq) {
			this.remoteSave = null
		}
	}

	// ── Flush ──

	private clearTimer(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer)
		}

		this.timer = null
		this.timerAt = null
		this.timerReason = null
	}

	private schedule(reason: FlushReason, at?: number): void {
		if (!this.writable()) {
			return
		}

		// A flush is out: the trigger is taken up once it ends, never as a pile of queued flushes.
		if (this.flushes > 0 && at === undefined) {
			this.followUp = this.followUp === null ? reason : moreUrgent(this.followUp, reason)

			return
		}

		const now = Date.now()
		const candidate =
			at ??
			(this.meta === null
				? now
				: earliestUploadAt({
						reason,
						now,
						meta: this.meta
					}))
		const due = mergeFlushTime({
			existing: this.timerAt,
			candidate,
			debounce: reason === "semantic" && at === undefined,
			now
		})
		const merged = this.timerReason === null ? reason : moreUrgent(this.timerReason, reason)

		if (this.timer !== null && this.timerAt === due) {
			this.timerReason = merged

			return
		}

		this.clearTimer()
		this.timerAt = due
		this.timerReason = merged
		this.timer = setTimeout(
			() => {
				const fire = this.timerReason ?? reason

				this.timer = null
				this.timerAt = null
				this.timerReason = null
				void this.track(this.flush(fire))
			},
			Math.max(0, due - now)
		)
	}

	private async flush(reason: FlushReason, force = false): Promise<void> {
		await this.ready()

		if (!this.writable()) {
			return
		}

		this.flushes++

		try {
			await navigator.locks.request(FLUSH_LOCK, () => this.runFlush(reason, force))
		} finally {
			this.flushes--

			const next = this.followUp

			if (this.flushes === 0 && next !== null) {
				this.followUp = null
				this.schedule(next)
			}
		}
	}

	private async runFlush(reason: FlushReason, force: boolean): Promise<void> {
		if (!this.writable()) {
			return
		}

		this.abandonPeerFlush()
		await this.reload()

		const meta = this.meta

		if (meta === null) {
			return
		}

		if (this.rows.size > 0 || this.headGone) {
			const now = Date.now()
			const at = force
				? now
				: earliestUploadAt({
						reason,
						now,
						meta
					})

			if (at > now) {
				this.schedule(reason, at)

				return
			}

			if (!(await this.sync(new Map(this.rows), meta, reason))) {
				return
			}
		}

		if (this.pruneDue) {
			this.pruneDue = false
			await this.maintain({
				prune: true,
				gc: false
			})
		}
	}

	// One flush: merge the journal into the head, upload if that adds anything, drop the rows it covered. False
	// when it failed (the rows stay; retried after the backoff).
	private async sync(rows: ReadonlyMap<string, RegisterRecord>, meta: WatchMeta, reason: FlushReason): Promise<boolean> {
		const epoch = this.epoch
		const semantic = this.semanticEdits
		const now = Date.now()
		const playback = this.playback

		// Stamped as it starts: a report while the upload is out doesn't ask for another one.
		if (playback !== null) {
			playback.synced = {
				pos: playback.pos,
				at: now
			}
		}

		try {
			const local = mergeWatchState({
				local: journalDoc(rows).doc,
				remote: this.headDoc
			}).doc
			const remote = await this.resolveRemote(epoch)

			if (remote === null || !this.writable()) {
				return false
			}

			const reconciled = reconcileWatchState({
				local,
				remote: remote.doc
			})
			const upload = reconciled.upload || remote.repair || (this.headGone && remote.ref === null)
			// A cleanup run here is recorded with the next upload, never the reason for one.
			const doc =
				upload && meta.pg > (reconciled.doc.gc ?? 0)
					? {
							...reconciled.doc,
							gc: meta.pg
						}
					: reconciled.doc

			let ref = remote.ref
			const patch: Partial<WatchMeta> = {
				c: this.clock,
				bo: 0,
				bu: 0
			}

			if (upload) {
				const saved = await this.upload(doc, remote.parent ?? (await this.sdk.videosDir()), remote.ref)

				ref = refOf(saved)
				patch.up = [...recentUploads(meta.up, Date.now()), Date.now()]
				patch.pg = 0

				if (ref !== null) {
					patch.own = withOwnUpload(meta.own, [ref.uuid, ref.stable])
				}
			}

			if (!this.writable()) {
				return false
			}

			this.headGone = false

			if (ref !== null && (ref.uuid !== this.head?.u || doc !== this.headDoc)) {
				await this.storeHead(ref, doc)
				patch.hg = this.headGen
			}

			await this.consume(rows)
			await this.saveMeta(patch)

			if (ref !== null && this.epoch === epoch && this.remoteSave === null) {
				this.currentUuid = ref.uuid
			}

			this.semanticSynced = Math.max(this.semanticSynced, semantic)
			this.rebuild()
			this.post({
				type: "synced",
				a: this.requireAccount()
			})

			return true
		} catch (e) {
			log.warn("videos.watchState", "watch-state flush failed", e)

			if (!this.writable()) {
				return false
			}

			const bo = nextBackoffMs(meta.bo)
			// Two writers colliding on the drive's lock would otherwise retry in lockstep.
			const wait = jitteredBackoffMs(bo, this.host.random?.() ?? Math.random())

			await this.saveMeta({
				bo,
				bu: Date.now() + wait
			}).catch(() => undefined)
			this.schedule(reason, Date.now() + wait)

			return false
		}
	}

	// Writes the head row; the caller persists meta.hg (the generation other tabs compare before reading it).
	private async storeHead(ref: HeadRef, doc: WatchStateDoc): Promise<void> {
		const head: WatchHead = {
			a: this.requireAccount(),
			u: ref.uuid,
			s: ref.stable,
			dir: ref.parent,
			ts: ref.timestamp,
			doc: JSON.stringify(doc)
		}

		await this.kv.kvSetJson(HEAD_KV_KEY, head)
		this.head = head
		this.headDoc = doc
		this.headGen = (this.meta?.hg ?? 0) + 1
		this.dirForgotten = false
	}

	// Deletes the rows a flush merged, unless a tab rewrote one since.
	private async consume(rows: ReadonlyMap<string, RegisterRecord>): Promise<void> {
		await navigator.locks.request(JOURNAL_LOCK, async () => {
			for (const [key, rec] of rows) {
				const row = (await this.kv.kvGetJson(journalRowKey(key), journalRowSchema))?.r

				if (row !== undefined && JSON.stringify(row) === JSON.stringify(rec)) {
					await this.kv.kvDelete(journalRowKey(key))
					this.rows.delete(key)
				}
			}
		})
	}

	// The head's document, read only when its uuid changed since the cached copy. Null when the head can't be used
	// (a newer schema, or unreadable with no readable version): it is never overwritten as if it were empty.
	private async resolveRemote(epoch: number): Promise<Remote | null> {
		const head = this.head

		if (this.blockedHead !== null && this.blockedHead === this.currentUuid) {
			return null
		}

		if (
			!this.headGone &&
			head?.u !== undefined &&
			head.s !== undefined &&
			head.dir !== undefined &&
			head.u === this.currentUuid &&
			!this.dirForgotten
		) {
			return {
				ref: {
					uuid: head.u,
					stable: head.s,
					parent: head.dir,
					timestamp: head.ts ?? 0
				},
				doc: this.headDoc,
				parent: head.dir,
				repair: false
			}
		}

		// Saves seen before this lookup starts are covered by what it finds.
		const seq = this.saveSeq
		const dir = this.videosDirKnown()
		let file: SdkFile | null = null

		// A permanently deleted head leaves its lineage on an unlisted version: only the listing is trusted then.
		if (head?.s !== undefined && !this.headGone) {
			const found = await this.sdk.getFileByStableUuid(head.s)

			if (found !== undefined && found.parent !== "trash" && dir !== null && found.parent === dir && isStateFileName(found)) {
				file = found
			}
		}

		if (file === null) {
			const videosDir = await this.sdk.findVideosDir()

			file = videosDir === null ? null : ((await this.sdk.listDirectory(videosDir)).find(isStateFileName) ?? null)

			if (file === null) {
				this.dropRemoteSavesThrough(seq)

				return {
					ref: null,
					doc: emptyWatchState(),
					parent: videosDir,
					repair: false
				}
			}
		}

		this.sdk.noteSystemFile(file.uuid)

		const ref = refOf(file)

		if (ref === null) {
			return null
		}

		if (file.uuid === head?.u && !this.headGone) {
			this.dropRemoteSavesThrough(seq)

			return {
				ref,
				doc: this.headDoc,
				parent: ref.parent,
				repair: false
			}
		}

		const read = await this.readHeadDoc(file)

		this.dropRemoteSavesThrough(seq)

		if (read === null) {
			this.blockedHead = file.uuid

			if (this.epoch === epoch) {
				this.currentUuid = file.uuid
			}

			return null
		}

		this.blockedHead = null

		return {
			ref,
			doc: read.doc,
			parent: ref.parent,
			repair: read.repair
		}
	}

	private async readDoc(file: SdkFile): Promise<ReturnType<typeof parseWatchStateText>> {
		const parsed = parseWatchStateText(new TextDecoder().decode(await this.sdk.download(file)))

		if (parsed.ok) {
			this.observe(parsed.maxStamp)
		}

		return parsed
	}

	// A head that doesn't parse (a torn write) is never taken for an empty document: the newest version that parses
	// stands in, and the head is replaced.
	private async readHeadDoc(file: SdkFile): Promise<{ doc: WatchStateDoc; repair: boolean } | null> {
		const parsed = await this.readDoc(file)

		if (parsed.ok) {
			return {
				doc: parsed.doc,
				repair: false
			}
		}

		if (parsed.reason === "unsupportedVersion") {
			log.warn("videos.watchState", "watch state written by a newer version; left alone", file.uuid)

			return null
		}

		log.warn("videos.watchState", "watch state doesn't parse; reading its previous versions", file.uuid)

		const versions = await this.sdk.listVersions(file)

		for (const version of versions.filter(item => item.uuid !== file.uuid).slice(0, CORRUPT_HEAD_VERSIONS)) {
			const older = await this.readDoc(versionAsFile(file, version))

			if (older.ok) {
				return {
					doc: older.doc,
					repair: true
				}
			}

			if (older.reason === "unsupportedVersion") {
				return null
			}
		}

		return null
	}

	private async upload(doc: WatchStateDoc, parent: string, before: HeadRef | null): Promise<SdkFile> {
		const token = crypto.randomUUID()
		const account = this.requireAccount()

		this.held = []
		this.uploadToken = token
		this.post({
			type: "flushing",
			a: account
		})

		let saved: SdkFile

		try {
			saved = await this.sdk.upload({
				parent,
				bytes: encodeDoc(doc),
				abortToken: token
			})
		} catch (e) {
			const committed = this.writable() ? await this.findCommitted(doc, parent, before).catch(() => null) : null

			if (committed === null) {
				const echoes = this.held

				this.held = null
				this.uploadToken = null
				this.settle(echoes, null)
				this.post({
					type: "flushed",
					a: account,
					uuid: null
				})

				throw e
			}

			saved = committed
		}

		const echoes = this.held

		this.held = null
		this.uploadToken = null
		this.ownUuids.add(saved.uuid)
		this.sdk.noteSystemFile(saved.uuid)
		this.settle(echoes, saved.uuid)
		this.post({
			type: "flushed",
			a: account,
			uuid: saved.uuid
		})

		return saved
	}

	// An upload that failed late (the deadline hit after the server committed it) still landed: the head is looked
	// up, and a new one holding exactly these bytes is this upload.
	private async findCommitted(doc: WatchStateDoc, parent: string, before: HeadRef | null): Promise<SdkFile | null> {
		const head =
			before === null
				? (await this.sdk.listDirectory(parent)).find(isStateFileName)
				: await this.sdk.getFileByStableUuid(before.stable)

		if (head === undefined || head.uuid === before?.uuid || this.ownUuids.has(head.uuid)) {
			return null
		}

		return sameBytes(await this.sdk.download(head), encodeDoc(doc)) ? head : null
	}

	// The newest save from elsewhere seen on the socket, read once: it becomes the cached head, and whatever this
	// browser knew that it lacks goes back to the journal (a save that went over another).
	private async readLatestSave(): Promise<void> {
		const save = this.remoteSave

		if (save === null) {
			return
		}

		if (save.file.uuid === this.head?.u || this.ownUuids.has(save.file.uuid)) {
			this.remoteSave = null
			this.rebuild()

			return
		}

		let parsed: ReturnType<typeof parseWatchStateText>

		try {
			parsed = await this.readDoc(save.file)
		} catch (e) {
			// Deleted since (another device's cleanup): a later save replaced it, which the next flush looks up.
			if (!isGoneError(e)) {
				throw e
			}

			if (this.remoteSave === save) {
				this.remoteSave = null
			}

			this.rebuild()

			return
		}

		if (this.remoteSave === save) {
			this.remoteSave = null
		}

		const ref = refOf(save.file)

		// An unreadable save is left to the next flush's head lookup.
		if (!parsed.ok || ref === null || !this.writable()) {
			this.rebuild()

			return
		}

		const missing = contributingRecords({
			from: this.headDoc,
			into: parsed.doc
		})

		await this.storeHead(ref, parsed.doc)
		await this.saveMeta({
			hg: this.headGen
		})

		if (this.epoch === save.epoch && this.remoteSave === null) {
			this.currentUuid = ref.uuid
		}

		if (missing.length > 0) {
			await this.writeRecords(
				missing.map(([key, rec]) => ({
					key,
					edit: doc => {
						const current = recordOf(doc, key)

						return current === undefined
							? rec
							: (mergeRecordMaps<RegisterRecord>({
									local: {
										[key]: current
									},
									remote: {
										[key]: rec
									}
								}).value[key] ?? rec)
					}
				}))
			)
			this.semanticEdits++
			this.schedule("semantic")
		}

		this.rebuild()
	}

	// ── Version cleanup ──

	// The head as the server has it now, if it is still the live state file of lineage `stable`.
	private async liveHead(stable: string): Promise<SdkFile | null> {
		const file = await this.sdk.getFileByStableUuid(stable)
		const dir = this.videosDirKnown()

		return file?.stableUUID === stable && file.parent !== "trash" && (dir === null || file.parent === dir) ? file : null
	}

	// Deletes versions of lineage `stable` concurrently, in batches. The head is looked up again before each batch
	// (`first` serves the first) and never deleted; the lineage gone, nothing more is. Resolves the uuids gone (a
	// missing one counts as gone).
	private async deleteVersions(stable: string, first: SdkFile, uuids: readonly string[]): Promise<Set<string>> {
		const gone = new Set<string>()
		let live: SdkFile | null = first

		for (const [index, batch] of batches(uuids, DELETE_BATCH).entries()) {
			if (index > 0) {
				live = await this.liveHead(stable)
			}

			if (live === null || !this.writable()) {
				break
			}

			const head = live
			const versions = batch
				.filter(uuid => uuid !== head.uuid)
				.map(uuid => versionOf(head, uuid))
				.filter(version => version !== null)
			const results = await Promise.allSettled(versions.map(version => this.sdk.deleteVersion(version)))

			results.forEach((result, i) => {
				const version = versions[i]

				if (result.status === "fulfilled" && version !== undefined) {
					gone.add(version.uuid)
				}
			})
		}

		return gone
	}

	// Superseded versions of the state file this browser uploaded (but the newest of them), and weekly, versions older
	// than a week beyond the newest two. The head is looked up right before each batch of deletes and never deleted: a
	// version delete of the head deletes the live file. The head the first open confirmed serves only the weekly
	// listing, whose deletes look it up again.
	private async maintain({ prune, gc }: { prune: boolean; gc: boolean }): Promise<void> {
		const meta = this.meta
		const head = this.head
		const now = Date.now()

		if (meta === null || head?.s === undefined || head.u === undefined || this.host.versioningEnabled() !== true || !this.writable()) {
			return
		}

		const stable = head.s
		const pruneDue =
			prune &&
			pruneTargets({
				own: meta.own,
				head: {
					uuid: head.u,
					stableUuid: stable
				}
			}).length > 0
		const gcDue = gc && now - Math.max(meta.gc, this.headDoc.gc ?? 0) >= GC_INTERVAL_MS

		if (!pruneDue && !gcDue) {
			return
		}

		const epoch = this.epoch
		const confirmed = this.confirmedHead

		this.confirmedHead = null

		try {
			const live =
				!pruneDue &&
				confirmed !== null &&
				confirmed.epoch === epoch &&
				confirmed.file.uuid === head.u &&
				confirmed.file.stableUUID === stable &&
				this.currentUuid === head.u &&
				this.remoteSave === null
					? confirmed.file
					: await this.liveHead(stable)

			if (live === null) {
				return
			}

			if (live.uuid === head.u && this.epoch === epoch && this.remoteSave === null) {
				this.currentUuid = live.uuid
			}

			const lastOwn = meta.own.at(-1)?.[0]
			const gone = new Set<string>()

			if (pruneDue) {
				for (const uuid of await this.deleteVersions(
					stable,
					live,
					pruneTargets({
						own: meta.own,
						head: {
							uuid: live.uuid,
							stableUuid: stable
						}
					})
				)) {
					gone.add(uuid)
				}
			}

			let gcAt = meta.gc

			if (gcDue) {
				const targets = gcTargets({
					versions: await this.sdk.listVersions(live),
					headUuid: live.uuid,
					protect: new Set(lastOwn === undefined ? [] : [lastOwn]),
					now
				})

				if (targets.length > 0) {
					// The head may have moved since the listing (a restore makes an old version the head again).
					const again = await this.liveHead(stable)

					if (again === null) {
						return
					}

					for (const uuid of await this.deleteVersions(
						stable,
						again,
						targets.map(version => version.uuid)
					)) {
						gone.add(uuid)
					}
				}

				gcAt = now
			}

			if (!this.writable()) {
				return
			}

			const current = this.meta ?? meta

			// Uploads of another lineage are forgotten: never this browser's to delete again.
			await this.saveMeta({
				own: current.own.filter(([uuid, ownStable]) => ownStable === stable && !gone.has(uuid)),
				gc: gcAt,
				pg: gcAt > meta.gc ? gcAt : current.pg
			})
		} catch (e) {
			log.warn("videos.watchState", "watch-state version cleanup failed", e)
		}
	}
}

function readPending(storage: Storage | null): PendingWatch | null {
	try {
		return decodePending(storage?.getItem(PENDING_STORAGE_KEY) ?? null)
	} catch {
		return null
	}
}

function pageStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage
	} catch {
		return null
	}
}

const kv: WatchStateKv = {
	kvGetJson,
	kvSetJson,
	kvKeys,
	kvEntriesJson,
	kvDelete,
	kvDeletePrefix,
	kvDeleteIfAt: entries => kvDeleteIfAt(entries)
}

export const watchState = new WatchStateEngine({
	kv,
	sdk: {
		account: () => sdkApi.videoIndexAccount(),
		videosDir: () => getDotFilenSubdir(VIDEOS_DIR_NAME),
		findVideosDir: () => findDotFilenSubdir(VIDEOS_DIR_NAME),
		knownVideosDir: () => dotFilenSubdirUuid(VIDEOS_DIR_NAME),
		noteSystemFile: noteDotFilenFile,
		getFileByStableUuid: stableUuid => runOp(sdkApi.getFileByStableUuid(stableUuid)),
		listVideosDir: (dirUuid, startedAfter) => listVideosDir(dirUuid, startedAfter),
		listDirectory: async dirUuid =>
			(
				await runOp(
					sdkApi.listDirectory({
						kind: "uuid",
						uuid: dirUuid
					})
				)
			).files,
		download: file => runOp(sdkApi.downloadFileBytes(file, crypto.randomUUID())),
		upload: ({ parent, bytes, abortToken }) =>
			runOp(
				sdkApi.uploadFileBytes(parent, Comlink.transfer(bytes, [bytes.buffer]), WATCH_STATE_FILE_NAME, "application/json", {
					deadlineMs: UPLOAD_DEADLINE_MS,
					abortToken
				})
			),
		cancel: abortToken => {
			void sdkApi.cancelPreviewDownload(abortToken)
		},
		listVersions: file => runOp(sdkApi.listFileVersionsOp(file)),
		deleteVersion: version => runOp(sdkApi.deleteFileVersionOp(version))
	},
	host: {
		versioningEnabled: () => accountQueryGet()?.versioningEnabled,
		storage: pageStorage,
		signOutPending: readSignOutPending,
		attach: ({ hidden, signOut }) => {
			const onVisibility = (): void => {
				if (document.visibilityState === "hidden") {
					hidden()
				}
			}
			const unwatchSignOut = onSignOutPending(signOut)
			const unwatchAuth = onAuthBroadcast(message => {
				if (message.kind === "logout") {
					signOut()
				}
			})

			document.addEventListener("visibilitychange", onVisibility)
			window.addEventListener("pagehide", hidden)

			return () => {
				unwatchSignOut()
				unwatchAuth()
				document.removeEventListener("visibilitychange", onVisibility)
				window.removeEventListener("pagehide", hidden)
			}
		},
		channel: () => (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME))
	}
})

// Called once by the authed shell's socket host. A gap in the event stream, or the directory going, means the head
// is looked up before it is trusted again.
export function registerWatchStateSocketHandlers(): () => void {
	const unregisterDrive = registerSocketHandler("drive", event => {
		watchState.handleDriveEvent(event)
	})
	const unregisterMalformed = registerSocketHandler("driveMalformed", () => {
		watchState.loseHead()
	})
	const unregisterReconnecting = registerSocketHandler("reconnecting", () => {
		watchState.loseHead()
	})
	const unforget = onDotFilenSubdirForgotten(VIDEOS_DIR_NAME, () => {
		watchState.forgetDirectory()
	})

	return () => {
		unregisterDrive()
		unregisterMalformed()
		unregisterReconnecting()
		unforget()
	}
}
