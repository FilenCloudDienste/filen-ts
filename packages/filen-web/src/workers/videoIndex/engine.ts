import {
	CLASSIFIER_VERSION,
	applyLibraryOverrides,
	classifyVideoLibrarySteps,
	splitMergeKeysOf,
	type LibraryOverride,
	type LibraryRootType,
	type LibraryScanDir,
	type VideoLibrary
} from "@filen/shared/videos"
import type { DirsAndFiles, DriveEvent, File, SocketEvent } from "@filen/sdk-rs"
import { log } from "@/lib/log"
import { isUuidStr } from "@/lib/uuidStr"
import type { ArtSlotCode } from "@/features/videos/lib/artStore.logic"
import { rootSize } from "@/features/videos/lib/library.logic"
import {
	applyDriveEvent,
	applyLookedUpFile,
	applyScopedWalk,
	applyWalk,
	emptyRootState,
	fromRecordsSteps,
	projectWalk,
	type IndexFile,
	type PatchResult,
	type RootState
} from "@/workers/videoIndex/rootIndex.logic"
import {
	INDEX_KINDS_SIGNATURE,
	decodeSnapshotSteps,
	encodeSnapshotSteps,
	nextSlot,
	snapshotIsCurrent,
	type DecodedSnapshot
} from "@/workers/videoIndex/snapshot.logic"
import {
	LibraryFiles,
	buildCorrectionTarget,
	buildTitleDetail,
	buildTitlesSteps,
	buildHomeItemsSteps,
	itemArtCandidates,
	titleArtCandidates,
	type TitleArtCandidates,
	type VideoHomeItem,
	type VideoIndexUpdate,
	type VideoCorrectionTarget,
	type VideoRootStatus,
	type VideoTitleDetail,
	type VideoTitleView
} from "@/workers/videoIndex/view.logic"
import {
	VideoCatalog,
	arrayTitles,
	catalogContent,
	libraryArt,
	type CatalogChange,
	type CatalogContent,
	type CatalogDerived,
	type CatalogItems,
	deriveCatalogSteps,
	groupedItemsSteps,
	type CatalogSummary,
	type FactsResult,
	type FactsUpdate,
	type GridPage,
	type GridQuery,
	gridKey,
	type HomeQuery,
	type HomeResult,
	type SearchResult,
	type WatchUpdate
} from "@/workers/videoIndex/catalog.logic"
import {
	CATALOG_FORMAT_VERSION,
	catalogKey,
	catalogSlotOrder,
	decodeCatalog,
	encodeCatalogSteps
} from "@/workers/videoIndex/catalogFile.logic"

// The Videos library index, inside the SDK worker: per-root snapshots loaded from OPFS, kept current from the
// socket's drive events, re-walked only when the event stream can't vouch for them, and classified into the
// keyless catalog the screens query a page or row at a time. The catalog is persisted too, so a cold open paints
// from it while the snapshots load and classify behind.

// Patches to the classification wait for a quiet spell, but never longer than the cap.
export const PATCH_DEBOUNCE_MS = 1_500
export const PATCH_MAX_WAIT_MS = 5_000
// Directories that came into a root are re-listed together after this; past the count, the root is walked.
export const SCOPED_WALK_COALESCE_MS = 2_000
export const SCOPED_WALK_MAX_PENDING = 8
// A failed renamed-file lookup is tried once more after this (once the socket is live) before its roots are walked.
export const LOOKUP_RETRY_MS = 10_000
// At most one automatic walk per root in this window; a manual rescan isn't held to it.
export const WALK_FLOOR_MS = 30 * 60_000
// Snapshot writes: a change is written after this, and no sooner than the interval after the previous write.
export const WRITE_DEBOUNCE_MS = 10_000
export const WRITE_MIN_INTERVAL_MS = 60_000
// Classification runs in slices of about this much, so other worker calls aren't held up.
export const SLICE_MS = 6
// Files gathered for the classifier between yields.
const INPUT_STEP = 8192
// Events held for a root while it can't apply them; past this, it is walked instead.
export const EVENT_BUFFER_CAP = 5_000

export interface IndexRootConfig {
	uuid: string
	type: LibraryRootType
	enabled: boolean
}

// A root's watermark kept apart from its snapshot, so a watermark-only change costs a few bytes rather than a whole
// slot. It applies only to the snapshot of that generation and checksum.
export interface SnapshotWatermark {
	generation: bigint
	crc: number
	watermark: bigint | null
}

export interface SnapshotStore {
	// One slot, null when missing.
	readSlot: (rootUuid: string, slot: 0 | 1) => Promise<Uint8Array | null>
	// Each slot's header generation, null for a missing or unreadable one.
	readGenerations: (rootUuid: string) => Promise<[bigint | null, bigint | null]>
	// Abandons the write, leaving the slot as it was, when `cancelled` says so before it completes.
	write: (rootUuid: string, slot: 0 | 1, bytes: Uint8Array<ArrayBuffer>, cancelled: () => boolean) => Promise<void>
	// null when missing or unreadable.
	readWatermark: (rootUuid: string) => Promise<SnapshotWatermark | null>
	writeWatermark: (rootUuid: string, mark: SnapshotWatermark, cancelled: () => boolean) => Promise<void>
	// The slots and the watermark.
	remove: (rootUuid: string) => Promise<void>
}

// The persisted catalog's two slots.
export interface CatalogStore {
	readSlot: (slot: 0 | 1) => Promise<Uint8Array | null>
	readGenerations: () => Promise<[bigint | null, bigint | null]>
	write: (slot: 0 | 1, bytes: Uint8Array<ArrayBuffer>, cancelled: () => boolean) => Promise<void>
}

// `ancestors`: the root's ancestor directories as far as known (trashing one takes the root away too).
export type WalkOutcome = { type: "ok"; name: string; raw: DirsAndFiles; ancestors: string[] } | { type: "gone" }

export interface VideoIndexDeps {
	// A root's recursive listing and its current name. The listing may be shared with another walker of the same
	// directory, but only one that started after `startedAfter` (a walkMark taken before the watermark was read).
	walkRoot: (rootUuid: string, startedAfter: number) => Promise<WalkOutcome>
	walkMark: () => number
	// A directory's recursive listing, for one that came into a root.
	walkDir: (dirUuid: string) => Promise<DirsAndFiles | null>
	lastDriveEventId: () => Promise<bigint>
	// The signed-in account's drive root: a root that is the drive root leaves Filen's own directory out.
	driveRoot: () => string | null
	getFile: (uuid: string) => Promise<File | undefined>
	store: SnapshotStore
	catalogStore: CatalogStore
	now: () => number
	// Ends the current task, so a long classification yields between slices.
	yieldSlice: () => Promise<void>
}

type RootMode =
	// Loaded, not yet checked against the drive: events are held.
	| "pending"
	// Current: every drive event since the watermark was applied, in order.
	| "live"
	// Known or possibly behind: events are applied as they come, without a watermark, until a walk.
	| "stale"

// manual: asked for by the user; event: the event stream changed the root in a way only a walk catches up with;
// auto: the index may be behind. Only auto is held to the floor.
type WalkReason = "manual" | "event" | "auto"

const WALK_REASON_RANK: Record<WalkReason, number> = {
	auto: 0,
	event: 1,
	manual: 2
}

// Consecutive failed snapshot writes after which writing stops for the session (storage unusable here).
const MAX_WRITE_FAILURES = 3

interface BufferedEvent {
	id: bigint
	// null for an event that couldn't be decoded.
	inner: DriveEvent | null
}

interface RootRuntime {
	config: IndexRootConfig
	state: RootState | null
	loading: Promise<void> | null
	status: VideoRootStatus["state"]
	mode: RootMode
	buffer: BufferedEvent[] | null
	bufferOverflow: boolean
	walking: Promise<void> | null
	// The user stopped the walk under way: its result is dropped when it lands.
	stopped: boolean
	// The user stopped the root's scan: nothing walks it again until a rescan is asked for.
	userStopped: boolean
	// The index doesn't reflect a complete walk: the latest one failed, came back partial or was stopped.
	incomplete: boolean
	walkAgain: WalkReason | null
	lastWalkAt: number
	deferredWalk: ReturnType<typeof setTimeout> | null
	scoped: Set<string>
	scopedTimer: ReturnType<typeof setTimeout> | null
	moved: boolean
	// The root's ancestors as far as known.
	ancestors: Set<string>
	// The snapshot was written under other classification or filtering rules: walk, whatever the floor.
	outdated: boolean
	// Video files the latest classification found in this root.
	videoCount: number
	// Bumped when a walk's result is applied, and copied when a classification that includes it is done: a scan
	// reads as under way until its count is known.
	walkSeq: number
	countedSeq: number
	version: number
	writtenVersion: number
	writeTimer: ReturnType<typeof setTimeout> | null
	writing: Promise<void> | null
	lastWriteAt: number
	// Only the watermark changed since the last write: written with the next one, or on its own when the page goes
	// away.
	watermarkDirty: boolean
	// The checksum of the stored snapshot the state matches (loaded or last written); null when none does.
	storedCrc: number | null
	// The slot known intact (loaded or last written) and its generation: the next write goes to the other one.
	storedSlot: { slot: 0 | 1; generation: bigint } | null
	// The write epoch in which the newest stored generation was last seen to be this state's own: a watermark kept
	// apart applies only to that generation, and another tab may have written a newer one while it held the writer
	// role.
	checkedEpoch: number
	// Lookups and directory re-listings out for events already past the watermark: until they land, a write keeps no
	// watermark, so a session ending meanwhile walks rather than trusting an index missing their result.
	followUps: number
	// Follow-up work was handed to a walk: held as `followUps` are until a walk's result lands (or the root goes stale).
	walkOwed: boolean
	// A write left the watermark out for them: written again once they land.
	heldWatermark: boolean
	// Taken out of the configuration: a write still out is abandoned before it re-creates the files removed.
	removed: boolean
}

// A renamed file being looked up. Every root that may hold it keeps its watermark back until the lookup is done.
interface Lookup {
	concerned: Set<RootRuntime>
	retried: boolean
	retryTimer: ReturnType<typeof setTimeout> | null
	// The retry waits for the socket: a dropped network fails the lookup and the socket alike.
	awaitingSocket: boolean
}

// One classification and what it was made from: reused while neither the roots' contents nor the split corrections
// change (`seq`, `split`).
interface ClassifiedInput {
	seq: number
	split: string
	library: VideoLibrary
	files: IndexFile[]
	loaded: RootRuntime[]
	seqs: number[]
	ends: number[]
	// The configured roots (uuid and type) when it ran, and whether every one of them is in it (one known gone holds
	// nothing): what its catalog is persisted under, and whether it may be.
	roots: [string, LibraryRootType][]
	complete: boolean
}

interface CurrentLibrary {
	files: LibraryFiles
}

// The checksum field of a snapshot slot's header.
function snapshotCrc(bytes: Uint8Array): number {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true)
}

function drainSync<T>(steps: Generator<void, T>): T {
	for (;;) {
		const step = steps.next()

		if (step.done === true) {
			return step.value
		}
	}
}

// When the worker last came back from a yield: every drain shares one slice, so work several of them start in the same
// task (a classification landing and the queries it releases) still yields after SLICE_MS together.
let sliceStart = 0

async function drainSteps<T>(steps: Generator<void, T>, yieldSlice: () => Promise<void>): Promise<T> {
	for (;;) {
		const step = steps.next()

		if (step.done === true) {
			return step.value
		}

		if (performance.now() - sliceStart >= SLICE_MS) {
			await yieldSlice()

			sliceStart = performance.now()
		}
	}
}

// A query's warm steps, shared by every call that needs them. `cancelled` turns true once no call waits any more
// (when it can be), so a grid order nobody shows is not built to the end.
interface CatalogWarm {
	callers: number
	cancelled: boolean
	done: Promise<void>
}

// A call the page gave up on (its query is no longer shown): it rejects with this, and its warm-up stops when no other
// call waits on it.
export class CatalogCallAbandoned extends Error {
	public constructor() {
		super("Catalog call abandoned")
		this.name = "CatalogCallAbandoned"
	}
}

// A race arm that never settles: a call nobody can abandon.
const NEVER = new Promise<never>(() => undefined)

// A slice of its own for what follows (a query's answer after its warm steps).
async function freshSlice(yieldSlice: () => Promise<void>): Promise<void> {
	if (performance.now() - sliceStart >= SLICE_MS / 2) {
		await yieldSlice()

		sliceStart = performance.now()
	}
}

export class VideoIndexEngine {
	private readonly deps: VideoIndexDeps
	private readonly roots = new Map<string, RootRuntime>()
	private readonly listeners = new Set<(update: VideoIndexUpdate) => void>()
	private current: CurrentLibrary | null = null
	// Calls waiting for the first classification (or the end of a failed one).
	private classifiedWaiters: (() => void)[] = []
	// What the screens query. Filled from the persisted catalog when it matches the configuration, else (and then
	// anyway, behind) from each classification.
	private readonly catalog = new VideoCatalog()
	private catalogSource: "none" | "file" | "classified" = "none"
	private catalogLoad: Promise<void> | null = null
	private catalogWaiters: (() => void)[] = []
	// Bumped with each change of the catalog's content; the screens refetch what they show.
	private catalogVersion = 0
	private catalogWrittenVersion = 0
	// The key the catalog in memory was classified under (roots, corrections, classifier).
	private catalogKeyText = ""
	private catalogWriteTimer: ReturnType<typeof setTimeout> | null = null
	private catalogWriting: Promise<void> | null = null
	private lastCatalogWriteAt = 0
	private catalogWriteFailures = 0
	// The catalog slot known intact (loaded or last written): the next write goes to the other one.
	private catalogStoredSlot: { slot: 0 | 1; generation: bigint } | null = null
	// The catalog held classifies every configured root (one that hasn't loaded yet makes a partial one).
	private catalogComplete = false
	// Bumped by reset: async work started before it drops its result.
	private token = 0
	private writer = false
	// Bumped whenever writing stops, so a write under way is abandoned.
	private writeEpoch = 0
	private writeFailures = 0
	// The last drive event id delivered, and whether the socket is up.
	private lastEventId: bigint | null = null
	private socketLive = false
	private sawReconnecting = false
	private rebuilding: Promise<void> | null = null
	private rebuildAgain = false
	// The last classification failed: until another one runs, calls answer from what is held instead of waiting.
	private classificationFailed = false
	private patchTimer: ReturnType<typeof setTimeout> | null = null
	private firstPatchAt = 0
	// Drive events applied while a lookup or scoped walk is out, re-applied over its result.
	private eventSeq = 0
	private asyncPatches = 0
	private patchLog: { seq: number; root: string; inner: DriveEvent }[] = []
	private readonly lookups = new Map<string, Lookup>()
	// The library configuration's manual corrections, by key, and their serialized form (to skip an unchanged set).
	private overrides: Readonly<Record<string, LibraryOverride>> = {}
	private overridesSignature = "{}"
	// Bumped whenever what the classifier reads changes (roots, their files, the split corrections); a rebuild for
	// any other correction reuses the last classification.
	private inputSeq = 0
	private classified: ClassifiedInput | null = null
	private notTransportStream: ReadonlySet<string> = new Set()
	private notTransportStreamSignature = ""

	public constructor(deps: VideoIndexDeps) {
		this.deps = deps
	}

	// Sets the `.ts`/`.mts` files a read of their content found to be no transport stream (TypeScript): the
	// library leaves them out. A changed set classifies again (no network).
	public setNotTransportStreams(uuids: readonly string[]): void {
		const signature = [...uuids].sort().join(",")

		if (signature === this.notTransportStreamSignature) {
			return
		}

		this.notTransportStream = new Set(uuids)
		this.notTransportStreamSignature = signature

		if (this.current !== null || this.rebuilding !== null) {
			this.scheduleRebuild("now")
		} else {
			this.inputSeq++
		}
	}

	// Sets the manual corrections; a changed set applies them again (no network), classifying again only when the
	// split corrections changed.
	public setOverrides(overrides: Readonly<Record<string, LibraryOverride>>): void {
		const signature = JSON.stringify(overrides)

		if (signature === this.overridesSignature) {
			return
		}

		const splitChanged = splitSignature(overrides) !== splitSignature(this.overrides)

		this.overrides = overrides
		this.overridesSignature = signature

		// A classification under way read the previous set: it runs again once done.
		if (this.current !== null || this.rebuilding !== null) {
			this.scheduleRebuild("now", splitChanged)
		}
	}

	// ── Configuration ──

	// Sets the roots. New ones load their snapshot (no network); a disabled root is unloaded and keeps its
	// snapshot; one no longer listed loses it. Resolves whether a check against the drive is needed.
	public async configure(roots: readonly IndexRootConfig[]): Promise<boolean> {
		const listed = new Set(roots.map(root => root.uuid))
		let changed = false

		for (const [uuid, rt] of this.roots) {
			const config = roots.find(root => root.uuid === uuid)

			if (config?.enabled !== true) {
				this.unload(rt, !listed.has(uuid))
				changed = true
			}
		}

		const loads: Promise<void>[] = []
		const created: RootRuntime[] = []

		for (const config of roots) {
			if (!config.enabled) {
				continue
			}

			const existing = this.roots.get(config.uuid)

			if (existing !== undefined) {
				changed ||= existing.config.type !== config.type
				existing.config = config

				continue
			}

			const rt = this.createRuntime(config)

			this.roots.set(config.uuid, rt)
			created.push(rt)
			changed = true
		}

		// The first configuration paints from the persisted catalog when it was classified under the same roots and
		// corrections; the snapshots load after it.
		this.catalogLoad ??= this.loadCatalog()
		await this.catalogLoad

		for (const rt of created) {
			if (this.roots.get(rt.config.uuid) === rt && rt.state === null && rt.loading === null) {
				rt.loading = this.load(rt)
			}
		}

		// Loads a concurrent configure started count too, so what this one reports is checked against them.
		for (const config of roots) {
			const loading = this.roots.get(config.uuid)?.loading ?? null

			if (loading !== null) {
				loads.push(loading)
			}
		}

		await Promise.all(loads)

		// The first configuration classifies even an empty library, so a subscriber learns there is nothing.
		if (changed || this.current === null) {
			this.pushRoots()
			this.scheduleRebuild("now")
		}

		return this.needsCheck()
	}

	private createRuntime(config: IndexRootConfig): RootRuntime {
		return {
			config,
			state: null,
			loading: null,
			status: "loading",
			mode: "pending",
			buffer: [],
			bufferOverflow: false,
			walking: null,
			stopped: false,
			userStopped: false,
			incomplete: false,
			walkAgain: null,
			lastWalkAt: 0,
			deferredWalk: null,
			scoped: new Set(),
			scopedTimer: null,
			moved: false,
			ancestors: new Set(),
			outdated: false,
			videoCount: 0,
			walkSeq: 0,
			countedSeq: 0,
			version: 0,
			writtenVersion: 0,
			writeTimer: null,
			writing: null,
			lastWriteAt: 0,
			watermarkDirty: false,
			storedCrc: null,
			storedSlot: null,
			checkedEpoch: -1,
			followUps: 0,
			walkOwed: false,
			heldWatermark: false,
			removed: false
		}
	}

	// The headers first, then only the newest slot (the other when that one is torn), then the watermark kept apart.
	private async load(rt: RootRuntime): Promise<void> {
		const token = this.token
		const uuid = rt.config.uuid

		try {
			let decoded: DecodedSnapshot | null = null
			let crc = 0
			let loadedSlot: 0 | 1 = 0

			for (const slot of catalogSlotOrder(await this.deps.store.readGenerations(uuid))) {
				const bytes = await this.deps.store.readSlot(uuid, slot)

				decoded = bytes === null ? null : await drainSteps(decodeSnapshotSteps(bytes, uuid), this.deps.yieldSlice)

				if (decoded !== null && bytes !== null) {
					crc = snapshotCrc(bytes)
					loadedSlot = slot

					break
				}
			}

			if (decoded === null) {
				return
			}

			if (token === this.token && this.roots.get(uuid) === rt) {
				rt.storedSlot = { slot: loadedSlot, generation: decoded.header.generation }
			}

			const mark = await this.deps.store.readWatermark(uuid).catch(() => null)

			if (mark !== null && mark.generation === decoded.header.generation && mark.crc === crc) {
				decoded.header.watermark = mark.watermark
			}

			const state = await drainSteps(fromRecordsSteps(decoded), this.deps.yieldSlice)

			// A walk that landed meanwhile is newer than any snapshot.
			if (token !== this.token || this.roots.get(uuid) !== rt || rt.state !== null) {
				return
			}

			rt.state = state
			rt.storedCrc = crc
			rt.status = "ready"
			rt.outdated = !snapshotIsCurrent(decoded)
			// Only partial walks were ever stored.
			rt.incomplete = state.completeAt === 0
		} catch (e) {
			log.warn("videos.index", "snapshot unreadable; the root is walked instead", rt.config.uuid, e)
		} finally {
			rt.loading = null
		}
	}

	private unload(rt: RootRuntime, removeSnapshot: boolean): void {
		const uuid = rt.config.uuid

		this.clearTimers(rt)
		this.roots.delete(uuid)
		rt.removed = removeSnapshot

		// A write still out ends (abandoned) before the files go, so it can't bring them back.
		const flushed = removeSnapshot
			? (rt.writing ?? Promise.resolve()).catch(() => undefined)
			: this.writer && rt.version > rt.writtenVersion
				? this.writeNow(rt)
				: Promise.resolve()

		if (removeSnapshot) {
			void flushed
				.then(() => this.deps.store.remove(uuid))
				.catch((e: unknown) => {
					log.warn("videos.index", "removing a root's snapshot failed", uuid, e)
				})
		}
	}

	private clearTimers(rt: RootRuntime): void {
		for (const timer of [rt.deferredWalk, rt.scopedTimer, rt.writeTimer]) {
			if (timer !== null) {
				clearTimeout(timer)
			}
		}

		rt.deferredWalk = null
		rt.scopedTimer = null
		rt.writeTimer = null
	}

	// Not walking or loading, and unchecked against the drive's event stream or never walked; a root whose scan the
	// user stopped waits for a rescan, and one found gone before it was ever walked for its restore (or a rescan).
	private unchecked(rt: RootRuntime): boolean {
		return (
			rt.walking === null &&
			rt.loading === null &&
			!rt.userStopped &&
			(rt.state === null ? rt.status !== "missing" : rt.mode === "pending")
		)
	}

	// Some loaded root hasn't been checked against the drive's event stream, or hasn't been walked at all.
	public needsCheck(): boolean {
		for (const rt of this.roots.values()) {
			if (this.unchecked(rt)) {
				return true
			}
		}

		return false
	}

	// Compares each unchecked root's watermark with the drive's latest event id (`watermark`, one request the
	// caller made): equal means nothing changed anywhere in the drive, so no walk. Unwalked roots are walked.
	public async check(watermark?: bigint): Promise<void> {
		const pending = [...this.roots.values()].filter(rt => this.unchecked(rt))

		if (pending.length === 0) {
			return
		}

		// Taken before the watermark is read (the caller read one before calling): a listing begun earlier may not
		// reflect what that watermark covers.
		const mark = this.deps.walkMark()
		let latest = watermark ?? (this.socketLive ? this.lastEventId : null)

		if (latest === null) {
			try {
				latest = await this.deps.lastDriveEventId()
			} catch (e) {
				// Never-walked roots are walked anyway (a walk reads its own and reports its failure); the others stay
				// unchecked until the next check.
				log.warn("videos.index", "latest drive event id unavailable", e)
			}
		}

		const walks: Promise<void>[] = []

		for (const rt of pending) {
			if (rt.state === null) {
				walks.push(this.walk(rt, "manual", latest === null ? undefined : { watermark: latest, mark }))

				continue
			}

			if (latest === null || rt.mode !== "pending" || rt.walking !== null) {
				continue
			}

			if (rt.outdated) {
				walks.push(this.walk(rt, "event", { watermark: latest, mark }))

				continue
			}

			if (rt.state.watermark !== null && this.settle(rt, rt.state.watermark, latest)) {
				continue
			}

			walks.push(this.walk(rt, "auto", { watermark: latest, mark }))
		}

		this.pushRoots()

		await Promise.all(walks)
	}

	// A user-asked rescan: walks now, whatever the floor.
	public rescan(rootUuid: string): Promise<void> {
		const rt = this.roots.get(rootUuid)

		if (rt === undefined) {
			return Promise.resolve()
		}

		rt.userStopped = false

		return this.walk(rt, "manual")
	}

	// The user stopped a root's scan. A walk can't be aborted, so it finishes unseen and its result is dropped:
	// the index keeps what it had, flagged incomplete at once, and nothing walks it again until a rescan.
	public stopWalk(rootUuid: string): void {
		const rt = this.roots.get(rootUuid)

		if (rt === undefined) {
			return
		}

		if (rt.walking === null || rt.stopped) {
			return
		}

		rt.stopped = true
		rt.userStopped = true
		rt.incomplete = true
		rt.walkAgain = null

		if (rt.state === null) {
			rt.status = "error"
		}

		this.pushRoots()
	}

	// Applies the events held since `watermark`, which the state is current to, when they run without a gap through
	// `through` (the drive's latest event id): then nothing is missing. False, changing nothing, otherwise.
	private settle(rt: RootRuntime, watermark: bigint, through: bigint): boolean {
		const state = rt.state

		if (state === null) {
			return false
		}

		const buffer = rt.buffer ?? []
		let expected = watermark + 1n

		if (rt.bufferOverflow) {
			return false
		}

		for (const event of buffer) {
			if (event.id < expected) {
				continue
			}

			if (event.id !== expected || event.inner === null) {
				return false
			}

			expected++
		}

		if (expected - 1n < through) {
			return false
		}

		rt.buffer = null
		rt.mode = "live"

		for (const event of buffer) {
			if (event.id > watermark && event.inner !== null) {
				this.apply(rt, event.inner, null)
			}
		}

		this.setWatermark(rt, expected - 1n)
		this.resumeScoped(rt)

		return true
	}

	// Gives up on holding events: applies what is held as best it can and drops the watermark until a walk.
	private toStale(rt: RootRuntime): void {
		const buffer = rt.buffer

		rt.buffer = null
		rt.bufferOverflow = false
		rt.mode = "stale"
		// Without a watermark there is nothing left to hold; only a walk makes the root current again.
		rt.walkOwed = false

		if (rt.state === null) {
			return
		}

		for (const event of buffer ?? []) {
			if (event.inner !== null) {
				this.apply(rt, event.inner, null)
			}
		}

		this.setWatermark(rt, null)
		this.resumeScoped(rt)
	}

	// A watermark-only change (every drive event anywhere moves it) isn't worth a snapshot write of its own: it goes
	// with the next content write, or when the page goes away.
	private setWatermark(rt: RootRuntime, watermark: bigint | null): void {
		if (rt.state === null || rt.state.watermark === watermark) {
			return
		}

		rt.state.watermark = watermark
		rt.watermarkDirty = true
	}

	// ── Walks ──

	private floorBase(rt: RootRuntime): number {
		return Math.max(rt.lastWalkAt, rt.state?.completeAt ?? 0)
	}

	// Single flight per root: a walk asked for while one runs follows it (the strongest reason wins).
	private walk(rt: RootRuntime, reason: WalkReason, known?: { watermark: bigint; mark: number }): Promise<void> {
		// Asked for again after a stop: the walk under way counts again rather than starting another.
		if (rt.walking !== null && rt.stopped && reason === "manual") {
			rt.stopped = false
			this.pushRoots()

			return rt.walking
		}

		if (rt.walking !== null) {
			rt.walkAgain = rt.walkAgain === null || WALK_REASON_RANK[reason] > WALK_REASON_RANK[rt.walkAgain] ? reason : rt.walkAgain

			return rt.walking
		}

		const now = this.deps.now()

		if (reason === "auto" && rt.state !== null && now - this.floorBase(rt) < WALK_FLOOR_MS) {
			this.deferWalk(rt)
			this.toStale(rt)
			this.pushRoots()

			return Promise.resolve()
		}

		if (rt.deferredWalk !== null) {
			clearTimeout(rt.deferredWalk)
			rt.deferredWalk = null
		}

		// A live root is current to its watermark, so walking from there needs no lookup.
		const base = rt.mode === "live" ? (rt.state?.watermark ?? null) : null
		const mark = known?.mark ?? this.deps.walkMark()

		rt.lastWalkAt = now
		rt.buffer ??= []

		const walking = this.runWalk(rt, base ?? known?.watermark ?? null, mark).finally(() => {
			rt.walking = null
			this.pushRoots()

			const again = rt.walkAgain

			rt.walkAgain = null

			if (again !== null && this.roots.get(rt.config.uuid) === rt) {
				void this.walk(rt, again)
			}
		})

		rt.walking = walking
		this.pushRoots()

		return walking
	}

	// A stopped walk landed: a root that was current stays current when the events held meanwhile run without a
	// gap through the latest one delivered; otherwise it is stale until the next walk.
	private keepAfterStop(rt: RootRuntime): void {
		const watermark = rt.state?.watermark ?? null

		// Follow-up work left to the stopped walk was never done: the watermark can't vouch for it.
		if (
			!rt.walkOwed &&
			rt.mode === "live" &&
			watermark !== null &&
			this.socketLive &&
			this.lastEventId !== null &&
			this.settle(rt, watermark, this.lastEventId)
		) {
			return
		}

		this.toStale(rt)
	}

	private deferWalk(rt: RootRuntime): void {
		if (rt.deferredWalk !== null) {
			return
		}

		const delay = Math.max(0, this.floorBase(rt) + WALK_FLOOR_MS - this.deps.now())

		rt.deferredWalk = setTimeout(() => {
			rt.deferredWalk = null

			if (this.roots.get(rt.config.uuid) === rt) {
				void this.walk(rt, "auto")
			}
		}, delay)
	}

	private async runWalk(rt: RootRuntime, knownWatermark: bigint | null, mark: number): Promise<void> {
		const token = this.token
		const uuid = rt.config.uuid
		// Re-listings queued before the walk began: its listing covers them.
		const covered = [...rt.scoped]

		try {
			const watermark = knownWatermark ?? (this.socketLive ? this.lastEventId : null) ?? (await this.deps.lastDriveEventId())
			// Events held by now were delivered before the listing is taken, and each delivery stops a listing begun
			// earlier from being joined, so the listing reflects those up to the watermark. One delivered later may
			// have changed what a joined listing had already read, even with an id up to the watermark.
			const held = rt.buffer
			const heldBefore = held?.length ?? 0
			const startedAt = this.deps.now()
			const outcome = await this.deps.walkRoot(uuid, mark)

			if (token !== this.token || this.roots.get(uuid) !== rt) {
				return
			}

			if (outcome.type === "gone") {
				rt.stopped = false
				rt.status = "missing"
				this.toStale(rt)

				return
			}

			if (rt.stopped) {
				rt.stopped = false
				this.keepAfterStop(rt)

				return
			}

			const projection = projectWalk(uuid, outcome.raw, uuid === this.deps.driveRoot())
			const state = rt.state ?? emptyRootState(uuid, outcome.name)

			state.name = outcome.name
			rt.ancestors = new Set(outcome.ancestors)
			applyWalk({
				state,
				walk: projection,
				startedAt,
				now: this.deps.now()
			})
			rt.state = state
			rt.status = "ready"
			rt.walkSeq++

			for (const dirUuid of covered) {
				rt.scoped.delete(dirUuid)
			}

			rt.walkOwed = false

			if (rt.scoped.size === 0 && rt.scopedTimer !== null) {
				clearTimeout(rt.scopedTimer)
				rt.scopedTimer = null
			}

			this.releaseWatermark(rt)

			const buffer = rt.buffer ?? []
			const overflow = rt.bufferOverflow
			const walked = new Set(projection.dirs.map(dir => dir.uuid))
			let expected = watermark + 1n
			let contiguous = projection.complete && !overflow

			rt.buffer = null
			rt.bufferOverflow = false

			// Everything held is applied over the walk in order; an event the walk already reflects sets what is
			// already there. Those held before the listing was taken with ids up to the watermark are skipped, as
			// `settle` does: the listing reflects them, and a held event from before a drop would otherwise undo a later
			// one the drop swallowed.
			for (const [index, event] of buffer.entries()) {
				if (buffer === held && index < heldBefore && event.id <= watermark) {
					continue
				}

				if (event.id >= expected) {
					contiguous &&= event.id === expected && event.inner !== null
					expected = event.id + 1n
				}

				if (event.inner !== null) {
					this.apply(rt, event.inner, walked)
				}
			}

			rt.mode = contiguous ? "live" : "stale"
			this.markPersist(rt)
			this.setWatermark(rt, contiguous ? expected - 1n : null)
			this.scheduleRebuild("now")

			rt.incomplete = !projection.complete

			if (projection.complete) {
				rt.outdated = false
			}

			// Events were missed while it ran: once more (the floor permitting). A partial walk (orphans in the listing)
			// is tried again once the floor passes, so its removals and tombstone purges aren't put off for good.
			if (!contiguous && projection.complete) {
				rt.walkAgain ??= "auto"
			} else if (!projection.complete) {
				this.deferWalk(rt)
			}
		} catch (e) {
			if (token !== this.token) {
				return
			}

			log.warn("videos.index", "root walk failed; the index keeps what it had", uuid, e)

			rt.stopped = false
			rt.incomplete = true
			rt.status = rt.state === null ? "error" : "ready"
			this.toStale(rt)
			this.deferWalk(rt)
		}
	}

	// ── Socket ──

	public onSocketEvent(event: SocketEvent): void {
		switch (event.type) {
			case "drive":
				this.onDriveEvent(event.driveMessageId, event.inner)

				break

			case "driveMalformed":
				this.onDriveEvent(event.driveMessageId, null)

				break

			case "reconnecting":
				this.onReconnecting()

				break

			case "authSuccess":
				this.onAuthSuccess()

				break

			default:
				break
		}
	}

	private onReconnecting(): void {
		this.socketLive = false
		this.sawReconnecting = true
		// What was delivered before the drop says nothing about what the drive holds after it.
		this.lastEventId = null

		// What arrives after the drop may follow a gap: held until checked again.
		for (const rt of this.roots.values()) {
			if (rt.mode === "live") {
				rt.mode = "pending"
				rt.buffer ??= []
			}
		}
	}

	private onAuthSuccess(): void {
		this.socketLive = true
		this.retryLookups()

		if (!this.sawReconnecting) {
			return
		}

		this.sawReconnecting = false

		if ([...this.roots.values()].some(rt => rt.state !== null && rt.mode === "pending")) {
			void this.check().catch((e: unknown) => {
				log.warn("videos.index", "check after reconnect failed", e)
			})
		}
	}

	private onDriveEvent(id: bigint, inner: DriveEvent | null): void {
		this.lastEventId = id
		this.eventSeq++

		for (const rt of this.roots.values()) {
			// Gone before it was ever walked: nothing to hold events for, walked again once it is restored.
			if (rt.state === null && rt.walking === null && rt.status === "missing") {
				if ((inner?.type === "folderRestore" || inner?.type === "folderMove") && inner.dir.uuid === rt.config.uuid) {
					rt.status = "loading"
					void this.walk(rt, "event")
				}

				continue
			}

			if (rt.walking !== null || rt.mode === "pending" || rt.state === null) {
				this.hold(rt, id, inner)

				continue
			}

			if (rt.mode === "live") {
				const watermark = rt.state.watermark ?? -1n

				if (id <= watermark) {
					continue
				}

				if (id !== watermark + 1n || inner === null) {
					this.toStale(rt)
					void this.walk(rt, "auto")
				} else {
					this.setWatermark(rt, id)
				}
			} else if (inner === null) {
				void this.walk(rt, "auto")
			}

			if (inner !== null) {
				this.apply(rt, inner, null)
			}
		}
	}

	private hold(rt: RootRuntime, id: bigint, inner: DriveEvent | null): void {
		rt.buffer ??= []

		if (rt.buffer.length >= EVENT_BUFFER_CAP) {
			rt.bufferOverflow = true

			return
		}

		rt.buffer.push({
			id,
			inner
		})
	}

	// One event against one root, with its follow-ups. `walked` names directories a just-applied walk listed, so a
	// replayed move into one of them needs no re-listing.
	private apply(rt: RootRuntime, inner: DriveEvent, walked: ReadonlySet<string> | null): void {
		const state = rt.state

		if (state === null) {
			return
		}

		this.followAncestors(rt, inner)

		const result = applyDriveEvent({
			state,
			inner,
			now: this.deps.now(),
			driveRoot: rt.config.uuid === this.deps.driveRoot()
		})

		if (this.asyncPatches > 0) {
			this.patchLog.push({
				seq: this.eventSeq,
				root: rt.config.uuid,
				inner
			})
		}

		this.afterPatch(rt, result, walked)
	}

	private afterPatch(rt: RootRuntime, result: PatchResult, walked: ReadonlySet<string> | null): void {
		if (result.dirty) {
			this.markPersist(rt)
		}

		if (result.changed) {
			this.scheduleRebuild("patch")
		}

		const followUp = result.followUp

		switch (followUp.type) {
			case "none":
				return

			case "scopedWalk":
				if (walked?.has(followUp.dirUuid) !== true) {
					this.queueScoped(rt, followUp.dirUuid)
				}

				return

			case "fullWalk":
				this.walkInstead(rt)

				return

			// Known to another root: placed there by the rename itself, nothing to look up.
			case "getFile":
				if (![...this.roots.values()].some(other => other.state?.byUuid.has(followUp.uuid) === true)) {
					this.lookUp(followUp.uuid, rt)
				}

				return

			case "rootGone":
				rt.status = "missing"
				this.pushRoots()

				return

			case "rootRestored":
				rt.status = "ready"
				this.walkInstead(rt)

				return

			case "rootMoved":
				rt.moved = true
				this.pushRoots()

				return
		}
	}

	// A directory above the root trashed or deleted takes the root with it (its index is kept, flagged); one
	// restored brings it back; one moved may have nested it under another root.
	private followAncestors(rt: RootRuntime, inner: DriveEvent): void {
		switch (inner.type) {
			case "folderTrash":
			case "folderDeletedPermanent":
				if (rt.ancestors.has(inner.uuid)) {
					rt.status = "missing"
					this.pushRoots()
				}

				return

			case "folderRestore":
				if (rt.ancestors.has(inner.dir.uuid) && rt.status === "missing") {
					rt.status = "ready"
					this.walkInstead(rt)
				}

				return

			case "folderMove":
				if (rt.ancestors.has(inner.dir.uuid)) {
					rt.moved = true
					this.pushRoots()
				}

				return

			default:
				return
		}
	}

	// Starts an out-of-band patch: events applied until it lands are re-applied over its result.
	private beginAsyncPatch(): number {
		this.asyncPatches++

		return this.eventSeq
	}

	// `walked`: directories the patch re-listed, whose own move or restore needs no second listing.
	private endAsyncPatch(startSeq: number, root: RootRuntime | null, walked: ReadonlySet<string> | null): void {
		for (const entry of this.patchLog) {
			const rt = this.roots.get(entry.root)

			if (entry.seq > startSeq && rt !== undefined && (root === null || rt === root)) {
				this.afterPatch(
					rt,
					rt.state === null
						? {
								changed: false,
								dirty: false,
								followUp: {
									type: "none"
								}
							}
						: applyDriveEvent({
								state: rt.state,
								inner: entry.inner,
								now: this.deps.now(),
								driveRoot: rt.config.uuid === this.deps.driveRoot()
							}),
					walked
				)
			}
		}

		this.asyncPatches--

		if (this.asyncPatches === 0) {
			this.patchLog = []
		}
	}

	// A file renamed into a video name, located once and placed in whichever root holds it. `asker` is the root whose
	// event asked: one that loaded or settled while the lookup was out joins it.
	private lookUp(uuid: string, asker: RootRuntime): void {
		const out = this.lookups.get(uuid)

		if (out !== undefined) {
			if (asker.state !== null && !out.concerned.has(asker)) {
				out.concerned.add(asker)
				asker.followUps++
			}

			return
		}

		// The file may lie in any root: each holds its watermark back until the lookup is done.
		const lookup: Lookup = {
			concerned: new Set([...this.roots.values()].filter(rt => rt.state !== null)),
			retried: false,
			retryTimer: null,
			awaitingSocket: false
		}

		for (const rt of lookup.concerned) {
			rt.followUps++
		}

		this.lookups.set(uuid, lookup)
		this.runLookup(uuid, lookup)
	}

	private runLookup(uuid: string, lookup: Lookup): void {
		const token = this.token
		const startSeq = this.beginAsyncPatch()
		let done = true

		void this.deps
			.getFile(uuid)
			.then(
				file => {
					if (token !== this.token || file === undefined) {
						return
					}

					// A root being walked gets the file from the walk, or asks again when the event replays over it. One
					// still unchecked takes it now and its held events after.
					for (const rt of this.roots.values()) {
						if (rt.state !== null && rt.walking === null) {
							this.afterPatch(
								rt,
								applyLookedUpFile({
									state: rt.state,
									file,
									now: this.deps.now()
								}),
								null
							)
						}
					}
				},
				(e: unknown) => {
					if (token !== this.token) {
						return
					}

					// Most likely the network: tried once more before a walk of every root it may lie in.
					if (!lookup.retried) {
						log.warn("videos.index", "renamed file lookup failed; tried once more", uuid, e)

						lookup.retried = true
						done = false
						lookup.retryTimer = setTimeout(() => {
							lookup.retryTimer = null

							if (this.socketLive) {
								this.runLookup(uuid, lookup)
							} else {
								lookup.awaitingSocket = true
							}
						}, LOOKUP_RETRY_MS)

						return
					}

					// The watermark is past the rename already: only a walk can place the file now.
					log.warn("videos.index", "renamed file lookup failed again; its roots are walked", uuid, e)

					for (const rt of lookup.concerned) {
						if (this.roots.get(rt.config.uuid) === rt && rt.state !== null && rt.walking === null) {
							this.toStale(rt)
							void this.walk(rt, "auto")
						}
					}
				}
			)
			.finally(() => {
				if (token !== this.token) {
					return
				}

				if (done) {
					this.lookups.delete(uuid)

					for (const rt of lookup.concerned) {
						this.endFollowUp(rt)
					}
				}

				this.endAsyncPatch(startSeq, null, null)
			})
	}

	// Lookups that failed while the socket was down are tried again now.
	private retryLookups(): void {
		for (const [uuid, lookup] of this.lookups) {
			if (lookup.awaitingSocket) {
				lookup.awaitingSocket = false
				this.runLookup(uuid, lookup)
			}
		}
	}

	private queueScoped(rt: RootRuntime, dirUuid: string): void {
		rt.scoped.add(dirUuid)

		if (rt.scoped.size > SCOPED_WALK_MAX_PENDING) {
			rt.scoped.clear()

			if (rt.scopedTimer !== null) {
				clearTimeout(rt.scopedTimer)
				rt.scopedTimer = null
			}

			this.walkInstead(rt)

			return
		}

		rt.scopedTimer ??= setTimeout(() => {
			rt.scopedTimer = null
			void this.runScoped(rt)
		}, SCOPED_WALK_COALESCE_MS)
	}

	private async runScoped(rt: RootRuntime): Promise<void> {
		const token = this.token

		// Held while the root is unchecked: a check that finds no gap leaves it live with nothing walked, so they
		// run once it is live or stale again.
		if (rt.mode === "pending" && rt.walking === null) {
			return
		}

		const dirs = [...rt.scoped]

		rt.scoped.clear()

		// A walk under way covers them: it lists the tree as it is after their events.
		if (rt.walking !== null) {
			rt.walkOwed = true

			return
		}

		if (rt.state === null) {
			this.releaseWatermark(rt)

			return
		}

		const startSeq = this.beginAsyncPatch()

		rt.followUps++

		try {
			for (const dirUuid of dirs) {
				const raw = await this.deps.walkDir(dirUuid)
				const state = rt.state

				if (token !== this.token || this.roots.get(rt.config.uuid) !== rt) {
					return
				}

				// Gone again, or moved out meanwhile.
				if (raw === null || !state.dirs.has(dirUuid)) {
					continue
				}

				const applied = applyScopedWalk({ state, walk: projectWalk(dirUuid, raw) })

				if (applied === "cycle") {
					throw new Error("re-listed directory lies below itself")
				}

				if (applied) {
					this.markPersist(rt)
					this.scheduleRebuild("patch")
				}
			}
		} catch (e) {
			log.warn("videos.index", "scoped directory walk failed; the root is walked instead", rt.config.uuid, e)

			this.toStale(rt)
			void this.walk(rt, "event")
		} finally {
			if (token === this.token) {
				this.endFollowUp(rt)
				this.endAsyncPatch(startSeq, rt, new Set(dirs))
			}
		}
	}

	// Re-listings held while the root was unchecked run now.
	private resumeScoped(rt: RootRuntime): void {
		if (rt.scoped.size === 0 || rt.scopedTimer !== null || this.roots.get(rt.config.uuid) !== rt) {
			return
		}

		rt.scopedTimer = setTimeout(() => {
			rt.scopedTimer = null
			void this.runScoped(rt)
		}, SCOPED_WALK_COALESCE_MS)
	}

	// Follow-up work too large for re-listings (or a tree that must be listed whole): the watermark stays held until
	// the walk's result lands.
	private walkInstead(rt: RootRuntime): void {
		if (rt.state !== null) {
			rt.walkOwed = true
		}

		void this.walk(rt, "event")
	}

	private endFollowUp(rt: RootRuntime): void {
		rt.followUps = Math.max(0, rt.followUps - 1)
		this.releaseWatermark(rt)
	}

	// No follow-up is out any more: a watermark a write left out is written with the next one.
	private releaseWatermark(rt: RootRuntime): void {
		if (rt.heldWatermark && rt.followUps === 0 && rt.scoped.size === 0 && !rt.walkOwed) {
			rt.heldWatermark = false
			rt.watermarkDirty = true
		}
	}

	// ── Classification ──

	private scheduleRebuild(kind: "now" | "patch", inputChanged = true): void {
		const now = this.deps.now()

		if (inputChanged) {
			this.inputSeq++
		}

		if (this.patchTimer !== null) {
			clearTimeout(this.patchTimer)
			this.patchTimer = null
		}

		if (kind === "now") {
			this.firstPatchAt = 0
			void this.rebuild()

			return
		}

		if (this.firstPatchAt === 0) {
			this.firstPatchAt = now
		}

		const delay = Math.max(0, Math.min(PATCH_DEBOUNCE_MS, this.firstPatchAt + PATCH_MAX_WAIT_MS - now))

		this.patchTimer = setTimeout(() => {
			this.patchTimer = null
			this.firstPatchAt = 0
			void this.rebuild()
		}, delay)
	}

	// Single flight: a change landing mid-run runs it once more after.
	private rebuild(): Promise<void> {
		if (this.rebuilding !== null) {
			this.rebuildAgain = true

			return this.rebuilding
		}

		const token = this.token

		this.rebuilding = this.runRebuild()
			.catch((e: unknown) => {
				log.error("videos.index", "classification failed", e)

				// No count is coming: the scans end with what is known.
				for (const rt of this.roots.values()) {
					rt.countedSeq = rt.walkSeq
				}

				this.pushRoots()
				// Nothing is coming for calls waiting on it, nor for later ones: they answer from what is held. A reset
				// meanwhile started over: calls before the next configuration wait for its classification.
				this.classificationFailed = token === this.token
				this.settleWaiters()
			})
			.finally(() => {
				this.rebuilding = null

				if (this.rebuildAgain) {
					this.rebuildAgain = false
					void this.rebuild()
				}
			})

		return this.rebuilding
	}

	private async runRebuild(): Promise<void> {
		this.classificationFailed = false

		const token = this.token
		const overrides = this.overrides
		const overridesSignature = this.overridesSignature
		const split = splitSignature(overrides)
		const cached = this.classified
		const input =
			cached !== null && cached.seq === this.inputSeq && cached.split === split
				? cached
				: await this.classify(this.inputSeq, overrides, split)

		if (input === null || token !== this.token) {
			return
		}

		this.classified = input

		const { library, files, loaded } = input
		const corrected = applyLibraryOverrides({
			library,
			overrides,
			stableUuidOf: file => files[file]?.stableUuid
		})
		const libraryFiles = new LibraryFiles({
			library: corrected.library,
			files,
			rootUuids: loaded.map(rt => rt.config.uuid),
			hidden: corrected.hidden,
			titleKeys: corrected.titleKeys,
			episodeKeys: corrected.episodeKeys,
			originals: corrected.originals,
			autoMerged: corrected.autoMerged
		})

		await this.publish(libraryFiles, input, input === cached, overridesSignature)
	}

	// The classifier's view of every loaded root, in slices; null when a reset came in meanwhile.
	private async classify(
		seq: number,
		overrides: Readonly<Record<string, LibraryOverride>>,
		split: string
	): Promise<ClassifiedInput | null> {
		const token = this.token
		const configured = [...this.roots.values()]
		const loaded = configured.filter(rt => rt.state !== null)
		const roots = configured.map((rt): [string, LibraryRootType] => [rt.config.uuid, rt.config.type])
		const complete = configured.every(rt => rt.state !== null || rt.status === "missing")
		const seqs = loaded.map(rt => rt.walkSeq)
		const dirs: LibraryScanDir[] = []
		const files: IndexFile[] = []

		// Each root's files sit together in `files`, ending at its offset.
		const ends: number[] = []

		// Taken at once (references only), so no patch lands halfway; the live files are picked out in slices.
		const taken = loaded.map(rt => ({ dirs: [...(rt.state?.dirs.values() ?? [])], files: [...(rt.state?.files.values() ?? [])] }))

		await drainSteps(
			(function* () {
				let step = 0

				for (const root of taken) {
					for (const dir of root.dirs) {
						dirs.push(dir)
					}

					for (const file of root.files) {
						if (file.tombstoneAt === 0) {
							files.push(file)
						}

						if (++step % INPUT_STEP === 0) {
							yield
						}
					}

					ends.push(files.length)
				}
			})(),
			this.deps.yieldSlice
		)

		if (token !== this.token) {
			return null
		}

		const library = await drainSteps(
			classifyVideoLibrarySteps({
				roots: loaded.map(rt => ({
					uuid: rt.config.uuid,
					name: rt.state?.name ?? "",
					type: rt.config.type
				})),
				dirs,
				files,
				splitMergeKeys: splitMergeKeysOf(overrides),
				notTransportStream: this.notTransportStream
			}),
			this.deps.yieldSlice
		)

		return token === this.token ? { seq, split, library, files, loaded, seqs, ends, roots, complete } : null
	}

	private countVideos({ library, loaded, seqs, ends }: ClassifiedInput): void {
		const counts = new Array<number>(loaded.length).fill(0)

		for (const video of library.videos) {
			const root = ends.findIndex(end => video.file < end)

			counts[root] = (counts[root] ?? 0) + 1
		}

		loaded.forEach((rt, index) => {
			rt.videoCount = counts[index] ?? 0
			rt.countedSeq = seqs[index] ?? rt.countedSeq
		})
	}

	// The catalog from a classification, built in slices; swapped in (and announced) only when it changed. A new
	// classification's video counts land with it, so a scan reads as under way until its titles show.
	// `input`: what it classified (its roots key the persisted copy); `counted`: its video counts landed already.
	private async publish(libraryFiles: LibraryFiles, input: ClassifiedInput, counted: boolean, overridesSignature: string): Promise<void> {
		const token = this.token
		const built = await drainSteps(this.catalogSteps(libraryFiles), this.deps.yieldSlice)

		if (token !== this.token) {
			return
		}

		if (!counted) {
			this.countVideos(input)
		}

		const { titles, items, itemsView, derived } = built
		const first = this.catalogSource === "none"
		const change = first
			? { changed: true, titles: [] }
			: (built.change ?? this.catalog.diff(titles, items, libraryArt(libraryFiles, arrayTitles(titles))))

		this.current = { files: libraryFiles }

		// An unchanged classification (the usual one behind a persisted catalog) keeps what is held, orders included.
		if (change.changed) {
			const held = arrayTitles(titles)

			this.catalog.setContent({
				titles: held,
				items: itemsView,
				derived: derived ?? drainSync(deriveCatalogSteps(titles, items)),
				art: libraryArt(libraryFiles, held)
			})
			this.catalogVersion++
		} else if (this.catalogSource === "file") {
			// The persisted copy was right: the classification's own records replace its columns (which go), and its
			// orders and selections stay.
			const held = arrayTitles(titles)

			this.catalog.setContent({
				titles: held,
				items: itemsView,
				derived: this.catalog.persisted().derived,
				art: libraryArt(libraryFiles, held)
			})
		} else {
			// Card art reads this classification from now on (the previous one goes).
			this.catalog.replaceArt(libraryArt(libraryFiles, this.catalog.persisted().titles))
		}

		this.catalogSource = "classified"
		// Only a classification of every configured root (one known gone holds nothing) is worth persisting: a cold
		// open keys on all of them.
		this.catalogComplete = input.complete

		if (first || change.changed) {
			this.emitCatalog(first ? null : change.titles)
		}

		const key = catalogKeyFor(input.roots, overridesSignature)

		if (key !== this.catalogKeyText) {
			this.catalogKeyText = key
			this.catalogWrittenVersion = -1
		}

		this.scheduleCatalogWrite()
		this.settleWaiters()
		this.pushRoots()
	}

	private *catalogSteps(libraryFiles: LibraryFiles): Generator<
		void,
		{
			titles: VideoTitleView[]
			items: VideoHomeItem[]
			itemsView: CatalogItems
			change: CatalogChange | null
			derived: CatalogDerived | null
		}
	> {
		const titles = yield* buildTitlesSteps(libraryFiles)
		const grouped = yield* groupedItemsSteps(titles, yield* buildHomeItemsSteps(libraryFiles, parent => this.dirName(parent)))
		const { items } = grouped
		// Against what is held when this runs: the first classification has nothing to compare with.
		const change =
			this.catalogSource === "none"
				? null
				: yield* this.catalog.diffSteps(titles, items, libraryArt(libraryFiles, arrayTitles(titles)))
		const derived = change === null || change.changed ? yield* deriveCatalogSteps(titles, items) : null

		yield

		return { titles, items, itemsView: grouped.view, change, derived }
	}

	private settleWaiters(): void {
		const waiters = [...this.catalogWaiters, ...this.classifiedWaiters]

		this.catalogWaiters = []
		this.classifiedWaiters = []

		for (const resolve of waiters) {
			resolve()
		}
	}

	// ── Catalog ──

	private async loadCatalog(): Promise<void> {
		const token = this.token
		const key = catalogKeyFor(
			[...this.roots.values()].map((rt): [string, LibraryRootType] => [rt.config.uuid, rt.config.type]),
			this.overridesSignature
		)

		try {
			// The headers first, then only the newest slot (the other when that one is torn or of another key).
			let content: CatalogContent | null = null
			const generations = await this.deps.catalogStore.readGenerations()

			for (const slot of catalogSlotOrder(generations)) {
				if (token !== this.token || this.catalogSource !== "none") {
					return
				}

				const bytes = await this.deps.catalogStore.readSlot(slot)

				// The decode (a few ms at 50k) and the screens' first queries after it each start a slice of their own.
				await freshSlice(this.deps.yieldSlice)

				content = bytes === null ? null : decodeCatalog(bytes, catalogKey(key))

				const generation = generations[slot]

				if (content !== null && generation !== null) {
					this.catalogStoredSlot = { slot, generation }

					break
				}
			}

			await freshSlice(this.deps.yieldSlice)

			if (content === null || token !== this.token || this.catalogSource !== "none") {
				return
			}

			this.catalog.setContent(content)
			this.catalogSource = "file"
			this.catalogKeyText = key
			this.catalogVersion++
			this.catalogWrittenVersion = this.catalogVersion
			this.emitCatalog(null)

			const waiters = this.catalogWaiters

			this.catalogWaiters = []

			for (const resolve of waiters) {
				resolve()
			}
		} catch (e) {
			log.warn("videos.index", "persisted catalog unreadable; the library classifies first", e)
		}
	}

	private emitCatalog(titles: string[] | null): void {
		this.emit({
			type: "catalog",
			version: this.catalogVersion,
			titles,
			summary: this.catalog.summary()
		})
	}

	// No classification is coming: the last one failed and no rerun is queued (a rerun clears the flag as it starts).
	private classificationGaveUp(): boolean {
		return this.classificationFailed && !this.rebuildAgain
	}

	// Resolves once the catalog holds something to show: the persisted one or the first classification.
	private catalogReady(): Promise<void> {
		return this.catalogSource === "none" && !this.classificationGaveUp()
			? new Promise(resolve => {
					this.catalogWaiters.push(resolve)
				})
			: Promise.resolve()
	}

	// Resolves once a classification is held, or the last one failed.
	private whenClassified(): Promise<void> {
		return this.current === null && !this.classificationGaveUp()
			? new Promise(resolve => {
					this.classifiedWaiters.push(resolve)
				})
			: Promise.resolve()
	}

	// Each query first fills what it reads in slices (catalog warm steps), so the worker stays free for other calls; the
	// answer is read only once what it reads is held (a change landing between the two warms again, never builds inline).
	public async catalogHome(query: HomeQuery): Promise<HomeResult> {
		await this.catalogReady()
		await drainSteps(this.catalog.homeWarmSteps(query), this.deps.yieldSlice)
		await freshSlice(this.deps.yieldSlice)

		return this.catalog.home(query)
	}

	// `ticket`: names the call for catalogAbandon.
	public async catalogGrid(query: GridQuery, start: number, count: number, ticket?: number): Promise<GridPage> {
		const gone = this.ticket(ticket)

		try {
			return await this.onGrid(query, gone.abandoned, () => this.catalog.grid(query, start, count))
		} finally {
			gone.release()
		}
	}

	// The ids of a grid order's titles in [start, end): a range or select-all of the grid.
	public catalogGridIds(query: GridQuery, start: number, end: number): Promise<string[]> {
		return this.onGrid(query, new Promise<never>(() => undefined), () => this.catalog.gridIds(query, start, end))
	}

	// Reads a grid order once it is held and current (warmed in slices first).
	private async onGrid<T>(query: GridQuery, abandoned: Promise<never>, read: () => T): Promise<T> {
		await Promise.race([this.catalogReady(), abandoned])

		for (;;) {
			if (this.catalog.hasGrid(query)) {
				await freshSlice(this.deps.yieldSlice)

				if (this.catalog.hasGrid(query)) {
					return read()
				}
			}

			await this.warm(`grid:${gridKey(query)}`, cancelled => this.catalog.gridWarmSteps(query, cancelled), true, abandoned)
		}
	}

	// The page gave up on a call (catalogGrid's `ticket`): it rejects, and stops its warm-up unless another waits on it.
	public catalogAbandon(ticket: number): void {
		this.abandons.get(ticket)?.()
	}

	private readonly abandons = new Map<number, () => void>()
	private readonly warms = new Map<string, CatalogWarm>()

	private ticket(ticket: number | undefined): { abandoned: Promise<never>; release: () => void } {
		if (ticket === undefined) {
			return { abandoned: new Promise<never>(() => undefined), release: () => undefined }
		}

		const abandoned = new Promise<never>((_, reject) => {
			this.abandons.set(ticket, () => {
				reject(new CatalogCallAbandoned())
			})
		})

		// Abandoned outside a race (between two awaits) is no failure of anything.
		abandoned.catch(() => undefined)

		return {
			abandoned,
			release: () => {
				this.abandons.delete(ticket)
			}
		}
	}

	// Runs (or joins) the warm-up under `key`; with `cancellable`, the last call leaving stops it.
	private async warm(
		key: string,
		steps: (cancelled: () => boolean) => Generator<void, void>,
		cancellable: boolean,
		abandoned: Promise<never>
	): Promise<void> {
		let warm = this.warms.get(key)

		if (warm === undefined || warm.cancelled) {
			const entry: CatalogWarm = { callers: 0, cancelled: false, done: Promise.resolve() }

			entry.done = drainSteps(
				steps(() => entry.cancelled),
				this.deps.yieldSlice
			).finally(() => {
				if (this.warms.get(key) === entry) {
					this.warms.delete(key)
				}
			})
			this.warms.set(key, entry)
			warm = entry
		}

		warm.callers++

		try {
			await Promise.race([warm.done, abandoned])
		} finally {
			warm.callers--

			if (cancellable && warm.callers === 0) {
				warm.cancelled = true
			}
		}
	}

	public async catalogSearch(query: string): Promise<SearchResult> {
		await this.catalogReady()

		for (;;) {
			if (this.catalog.hasSearchIndex()) {
				await freshSlice(this.deps.yieldSlice)

				if (this.catalog.hasSearchIndex()) {
					return this.catalog.search(query)
				}
			}

			await this.warm("search", () => this.catalog.searchWarmSteps(), false, NEVER)
		}
	}

	public async catalogTitle(id: string): Promise<VideoTitleView | null> {
		await this.catalogReady()

		return this.catalog.title(id)
	}

	public async catalogHidden(): Promise<VideoTitleView[]> {
		await this.catalogReady()

		return this.catalog.hidden()
	}

	public async catalogSeries(): Promise<{ id: string; title: string }[]> {
		await this.catalogReady()

		return this.catalog.series()
	}

	public async catalogMarkTargets(titleId: string, group: string | null): Promise<string[]> {
		await this.catalogReady()

		return this.catalog.markTargets(titleId, group)
	}

	public async catalogNextMovie(titleId: string): Promise<{ id: string; title: string } | null> {
		await this.catalogReady()

		for (;;) {
			if (this.catalog.hasNextMovies()) {
				await freshSlice(this.deps.yieldSlice)

				if (this.catalog.hasNextMovies()) {
					return this.catalog.nextMovie(titleId)
				}
			}

			await this.warm("nextMovie", () => this.catalog.nextMovieWarmSteps(), false, NEVER)
		}
	}

	public catalogSummary(): CatalogSummary {
		return this.catalog.summary()
	}

	// The page's watch state and probe facts, which the catalog's rows, filters and sorts read.
	public setWatch(update: WatchUpdate): void {
		this.catalog.setWatch(update)
	}

	// Says whether the facts reached titles with watch-state records (whose rows and watch-reading orders change too).
	public setFacts(update: FactsUpdate): Promise<FactsResult> {
		return drainSteps(this.catalog.setFactsSteps(update), this.deps.yieldSlice)
	}

	private scheduleCatalogWrite(): void {
		if (
			!this.writer ||
			!this.catalogComplete ||
			this.catalogWriteFailures >= MAX_WRITE_FAILURES ||
			this.catalogSource !== "classified" ||
			this.catalogVersion === this.catalogWrittenVersion ||
			this.catalogWriteTimer !== null
		) {
			return
		}

		const delay = Math.max(WRITE_DEBOUNCE_MS, this.lastCatalogWriteAt + WRITE_MIN_INTERVAL_MS - this.deps.now())

		this.catalogWriteTimer = setTimeout(() => {
			this.catalogWriteTimer = null
			void this.writeCatalogNow()
		}, delay)
	}

	private writeCatalogNow(): Promise<void> {
		if (this.catalogWriting !== null) {
			return this.catalogWriting.then(() => this.writeCatalogNow())
		}

		const token = this.token
		const writing = this.runCatalogWrite().finally(() => {
			this.catalogWriting = null

			if (token === this.token) {
				this.scheduleCatalogWrite()
			}
		})

		this.catalogWriting = writing

		return writing
	}

	private async runCatalogWrite(): Promise<void> {
		if (
			!this.writer ||
			!this.catalogComplete ||
			this.catalogSource !== "classified" ||
			this.catalogVersion === this.catalogWrittenVersion
		) {
			return
		}

		const version = this.catalogVersion
		const key = this.catalogKeyText
		const token = this.token
		const epoch = this.writeEpoch
		const cancelled = (): boolean => token !== this.token || epoch !== this.writeEpoch

		try {
			const { slot, generation } = nextSlot(await this.deps.catalogStore.readGenerations(), this.catalogStoredSlot)

			if (cancelled()) {
				return
			}

			const bytes = await drainSteps(
				encodeCatalogSteps({ content: this.catalog.persisted(), key: catalogKey(key), generation }),
				this.deps.yieldSlice
			)

			if (cancelled()) {
				return
			}

			await this.deps.catalogStore.write(slot, bytes, cancelled)

			if (!cancelled()) {
				this.catalogStoredSlot = { slot, generation }
			}

			if (!cancelled() && key === this.catalogKeyText) {
				this.catalogWrittenVersion = version
				this.lastCatalogWriteAt = this.deps.now()
				this.catalogWriteFailures = 0
			}
		} catch (e) {
			this.lastCatalogWriteAt = this.deps.now()
			this.catalogWriteFailures++
			// Past the limit, the catalog stays in memory this session (the snapshots keep their own count).
			log.warn("videos.index", "catalog write failed", e)
		}
	}

	// ── Subscriptions and reads ──

	// The listener gets everything known now, then every change.
	public subscribe(listener: (update: VideoIndexUpdate) => void): () => void {
		this.listeners.add(listener)

		if (this.catalogSource !== "none") {
			listener({
				type: "catalog",
				version: this.catalogVersion,
				titles: null,
				summary: this.catalog.summary()
			})
		}

		listener({
			type: "roots",
			roots: this.rootStatuses()
		})

		return () => {
			this.listeners.delete(listener)
		}
	}

	private emit(update: VideoIndexUpdate): void {
		for (const listener of this.listeners) {
			listener(update)
		}
	}

	private pushRoots(): void {
		this.emit({
			type: "roots",
			roots: this.rootStatuses()
		})
	}

	public rootStatuses(): VideoRootStatus[] {
		return [...this.roots.values()].map(rt => {
			const state = rt.state

			return {
				uuid: rt.config.uuid,
				name: state?.name ?? "",
				type: rt.config.type,
				state: rt.status,
				// Until the walk's result is classified too, so the count read when it ends is the new one.
				walking: (rt.walking !== null && !rt.stopped) || rt.countedSeq !== rt.walkSeq,
				current: rt.mode === "live",
				completeAt: state?.completeAt ?? 0,
				walkedEntries: state?.walkedEntries ?? 0,
				size: rootSize(state?.walkedEntries ?? 0),
				videos: rt.videoCount,
				moved: rt.moved,
				incomplete: rt.incomplete
			}
		})
	}

	// A card's art candidates come from the catalog until the library is classified (a cold open's cards look theirs
	// up at once); anything else waits for the classification.
	public async titleArt(id: string, slot: ArtSlotCode): Promise<TitleArtCandidates | null> {
		const kept = this.current === null && slot !== "b" ? this.catalog.cardArt(id, slot, null) : null

		if (kept !== null) {
			return kept
		}

		await this.whenClassified()

		const current = this.current
		const title = this.catalog.title(id)

		return current === null || title === null ? null : titleArtCandidates(current.files, title, slot)
	}

	// One video's art: an episode's own still, else its title's.
	public async itemArt(titleId: string, stableUuid: string, slot: ArtSlotCode): Promise<TitleArtCandidates | null> {
		const kept = this.current === null && slot !== "b" ? this.catalog.cardArt(titleId, slot, stableUuid) : null

		if (kept !== null) {
			return kept
		}

		await this.whenClassified()

		const current = this.current
		const title = this.catalog.title(titleId)

		return current === null || title === null ? null : itemArtCandidates(current.files, title, stableUuid, slot)
	}

	private dirName(uuid: string): string {
		for (const rt of this.roots.values()) {
			const state = rt.state

			if (state === null) {
				continue
			}

			if (rt.config.uuid === uuid) {
				return state.name
			}

			const dir = state.dirs.get(uuid)

			if (dir !== undefined) {
				return dir.name
			}
		}

		return ""
	}

	public async titleDetail(id: string): Promise<VideoTitleDetail | null> {
		await this.whenClassified()

		const current = this.current
		const title = this.catalog.title(id)

		return current === null || title === null ? null : buildTitleDetail(current.files, title)
	}

	// Set as's view of titles, in the order asked; ids no longer in the library are left out.
	public async correctionTargets(ids: readonly string[]): Promise<VideoCorrectionTarget[]> {
		await this.whenClassified()

		const current = this.current
		const out: VideoCorrectionTarget[] = []

		if (current === null) {
			return out
		}

		for (const id of ids) {
			const title = this.catalog.title(id)
			const target = title === null ? null : buildCorrectionTarget(current.files, title)

			if (target !== null) {
				out.push(target)
			}
		}

		return out
	}

	// Playable drive files rebuilt from the index, for the ones it holds live. These carry key material and are
	// built only on request, a few at a time; a root still loading its snapshot is waited for.
	public async playableFiles(stableUuids: readonly string[]): Promise<File[]> {
		await Promise.all([...this.roots.values()].flatMap(rt => rt.loading ?? []))

		const out: File[] = []

		for (const stableUuid of stableUuids) {
			for (const rt of this.roots.values()) {
				const file = rt.state?.files.get(stableUuid)

				if (file?.tombstoneAt === 0) {
					const built = toSdkFile(file)

					if (built !== null) {
						out.push(built)
					}

					break
				}
			}
		}

		return out
	}

	// ── Persistence ──

	// Whether this tab writes snapshots: on while it has the library open, off once a sign-out starts (here or in
	// another tab), which also abandons a write under way.
	public setWriter(writer: boolean): void {
		this.writer = writer && this.writeFailures < MAX_WRITE_FAILURES

		if (!this.writer) {
			this.writeEpoch++

			for (const rt of this.roots.values()) {
				if (rt.writeTimer !== null) {
					clearTimeout(rt.writeTimer)
					rt.writeTimer = null
				}
			}

			if (this.catalogWriteTimer !== null) {
				clearTimeout(this.catalogWriteTimer)
				this.catalogWriteTimer = null
			}

			return
		}

		for (const rt of this.roots.values()) {
			this.scheduleWrite(rt)
		}

		this.scheduleCatalogWrite()
	}

	private markPersist(rt: RootRuntime): void {
		rt.version++
		this.scheduleWrite(rt)
	}

	private scheduleWrite(rt: RootRuntime): void {
		if (!this.writer || rt.state === null || rt.version === rt.writtenVersion || rt.writeTimer !== null) {
			return
		}

		const delay = Math.max(WRITE_DEBOUNCE_MS, rt.lastWriteAt + WRITE_MIN_INTERVAL_MS - this.deps.now())

		rt.writeTimer = setTimeout(() => {
			rt.writeTimer = null
			void this.writeNow(rt)
		}, delay)
	}

	private writeNow(rt: RootRuntime): Promise<void> {
		if (rt.writing !== null) {
			return rt.writing.then(() => this.writeNow(rt))
		}

		const token = this.token
		const writing = this.runWrite(rt).finally(() => {
			rt.writing = null

			if (token === this.token && this.roots.get(rt.config.uuid) === rt) {
				this.scheduleWrite(rt)
			}
		})

		rt.writing = writing

		return writing
	}

	private async runWrite(rt: RootRuntime): Promise<void> {
		const state = rt.state
		const uuid = rt.config.uuid

		if (state === null || !this.writer || rt.removed || (rt.version === rt.writtenVersion && !rt.watermarkDirty)) {
			return
		}

		const version = rt.version
		const token = this.token
		const epoch = this.writeEpoch
		const cancelled = (): boolean => token !== this.token || epoch !== this.writeEpoch || rt.removed
		// Follow-ups out for events the watermark already covers: what is written must not vouch for them.
		const held = rt.followUps > 0 || rt.scoped.size > 0 || rt.walkOwed
		const watermark = held ? null : state.watermark

		rt.watermarkDirty = false
		rt.heldWatermark ||= held

		try {
			let generations: [bigint | null, bigint | null] | null = null

			// Only the watermark moved since the stored snapshot: it alone is written, unless another tab wrote a newer
			// generation while it held the writer role (the record would name a superseded one and be ignored).
			if (version === rt.writtenVersion && rt.storedCrc !== null) {
				if (rt.checkedEpoch !== epoch) {
					generations = await this.deps.store.readGenerations(uuid)

					if (cancelled()) {
						return
					}

					if (newestGeneration(generations) === state.generation) {
						rt.checkedEpoch = epoch
					}
				}

				if (rt.checkedEpoch === epoch) {
					try {
						await this.deps.store.writeWatermark(
							uuid,
							{ generation: state.generation, crc: rt.storedCrc, watermark },
							cancelled
						)
					} catch (e) {
						rt.watermarkDirty = true
						log.warn("videos.index", "watermark write failed", uuid, e)
					}

					return
				}
			}

			const { slot, generation } = nextSlot(generations ?? (await this.deps.store.readGenerations(uuid)), rt.storedSlot)

			if (cancelled()) {
				return
			}

			state.generation = generation

			const bytes = await drainSteps(encodeSnapshotSteps(held ? { ...state, watermark } : state), this.deps.yieldSlice)

			if (cancelled()) {
				return
			}

			await this.deps.store.write(uuid, slot, bytes, cancelled)

			if (!cancelled()) {
				rt.storedCrc = snapshotCrc(bytes)
				rt.storedSlot = { slot, generation }
				rt.checkedEpoch = epoch
				rt.writtenVersion = version
				rt.lastWriteAt = this.deps.now()
				this.writeFailures = 0
			}
		} catch (e) {
			rt.watermarkDirty = true
			rt.lastWriteAt = this.deps.now()
			this.writeFailures++

			// Storage that keeps failing here (no OPFS write support, quota) isn't tried for the rest of the session.
			if (this.writeFailures >= MAX_WRITE_FAILURES) {
				log.warn("videos.index", "snapshot writes keep failing; the index stays in memory this session", uuid, e)
				this.setWriter(false)
			} else {
				log.warn("videos.index", "snapshot write failed", uuid, e)
			}
		}
	}

	// Page hidden or closing: every pending snapshot write now; a watermark-only change writes the watermark alone.
	public async flush(): Promise<void> {
		if (!this.writer) {
			return
		}

		const writes: Promise<void>[] = []

		for (const rt of this.roots.values()) {
			if (rt.writeTimer !== null) {
				clearTimeout(rt.writeTimer)
				rt.writeTimer = null
			}

			if (rt.state !== null && (rt.version !== rt.writtenVersion || rt.watermarkDirty)) {
				writes.push(this.writeNow(rt))
			}
		}

		if (this.catalogWriteTimer !== null) {
			clearTimeout(this.catalogWriteTimer)
			this.catalogWriteTimer = null
		}

		if (this.catalogSource === "classified" && this.catalogComplete && this.catalogVersion !== this.catalogWrittenVersion) {
			writes.push(this.writeCatalogNow())
		}

		await Promise.all(writes)
	}

	// Logout: everything of the signed-out account goes; work under way drops its result.
	public reset(): void {
		this.token++

		for (const rt of this.roots.values()) {
			this.clearTimers(rt)
		}

		if (this.patchTimer !== null) {
			clearTimeout(this.patchTimer)
			this.patchTimer = null
		}

		this.roots.clear()
		this.listeners.clear()
		this.catalog.setContent(catalogContent([], []))
		this.catalog.setWatch({ reset: true, upserts: {}, removed: [], lastPlayedCeilingMs: undefined })
		this.catalog.setFacts({ reset: true, uuids: [], durations: [], heights: [] })
		this.catalogSource = "none"
		this.catalogLoad = null
		this.catalogVersion = 0
		this.catalogWrittenVersion = 0
		this.catalogKeyText = ""
		this.lastCatalogWriteAt = 0
		this.catalogWriteFailures = 0
		this.catalogStoredSlot = null
		this.catalogComplete = false

		if (this.catalogWriteTimer !== null) {
			clearTimeout(this.catalogWriteTimer)
			this.catalogWriteTimer = null
		}

		for (const lookup of this.lookups.values()) {
			if (lookup.retryTimer !== null) {
				clearTimeout(lookup.retryTimer)
			}
		}

		this.lookups.clear()
		this.patchLog = []
		this.asyncPatches = 0
		this.current = null
		this.writer = false
		this.writeEpoch++
		this.lastEventId = null
		this.socketLive = false
		this.sawReconnecting = false
		this.rebuildAgain = false
		this.classificationFailed = false
		this.firstPatchAt = 0
		this.overrides = {}
		this.overridesSignature = "{}"
		this.classified = null
		// Calls waiting on the signed-out account's library answer from the empty one.
		this.settleWaiters()
	}
}

function newestGeneration([a, b]: readonly [bigint | null, bigint | null]): bigint | null {
	return a === null ? b : b === null || a >= b ? a : b
}

// What a catalog classified from these configured roots (uuid, type) under these corrections is persisted under.
function catalogKeyFor(roots: readonly [string, LibraryRootType][], overridesSignature: string): string {
	return JSON.stringify([CATALOG_FORMAT_VERSION, CLASSIFIER_VERSION, INDEX_KINDS_SIGNATURE, roots, overridesSignature])
}

// The split corrections alone: the only ones the classifier itself reads.
function splitSignature(overrides: Readonly<Record<string, LibraryOverride>>): string {
	return [...splitMergeKeysOf(overrides)].sort().join("\n")
}

function toSdkFile(file: IndexFile): File | null {
	if (!isUuidStr(file.uuid) || !isUuidStr(file.stableUuid) || !isUuidStr(file.parent)) {
		return null
	}

	return {
		uuid: file.uuid,
		stableUUID: file.stableUuid,
		parent: file.parent,
		size: BigInt(file.size),
		favorited: file.favorited,
		region: file.region,
		bucket: file.bucket,
		timestamp: BigInt(file.timestamp),
		chunks: BigInt(file.chunks),
		canMakeThumbnail: file.canMakeThumbnail,
		meta: {
			type: "decoded",
			data: {
				name: file.name,
				mime: file.mime,
				...(Number.isNaN(file.created) ? {} : { created: BigInt(file.created) }),
				modified: BigInt(file.modified),
				size: BigInt(file.metaSize),
				key: file.key,
				version: file.keyVersion
			}
		}
	}
}
