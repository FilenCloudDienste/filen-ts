import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WATCH_STATE_FILE_NAME, emptyWatchState, itemKey, markWatched, parseWatchStateText, type WatchStateDoc } from "@filen/shared/videos"
import type { File as SdkFile, FileVersion, SocketEvent } from "@filen/sdk-rs"

// The real accessor reads `window` at import, which the node environment has none of; the session store imports it.
vi.mock("@/lib/desktop", () => ({ desktopBridge: () => undefined }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: vi.fn(),
	kvSetJson: vi.fn(),
	kvKeys: vi.fn(),
	kvEntriesJson: vi.fn(),
	kvDelete: vi.fn(),
	kvDeletePrefix: vi.fn()
}))
vi.mock("@/queries/account", () => ({ accountQueryGet: () => undefined }))

import { WatchStateEngine, type WatchItem, type WatchStateKv, type WatchStateSdk } from "@/features/videos/lib/watchState"
import {
	HEAD_KV_KEY,
	JOURNAL_KV_PREFIX,
	META_KV_KEY,
	PEER_FLUSH_EXPIRY_MS,
	PENDING_STORAGE_KEY,
	journalRowKey,
	type WatchMeta
} from "@/features/videos/lib/watchState.logic"
import { memoryKv } from "@/tests/support/memoryKv"
import { driveEvent, driveFile, hexUuid } from "@/tests/support/videoDrive"

const ACCOUNT = hexUuid()
const VIDEOS_DIR = hexUuid()
const T0 = 1_800_000_000_000

type DriveSocketEvent = Extract<SocketEvent, { type: "drive" }>

// A real macrotask: lock grants and BroadcastChannel deliveries land in it.
function tick(): Promise<void> {
	return new Promise(resolve => {
		setImmediate(resolve)
	})
}

function encode(doc: WatchStateDoc): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(doc))
}

function decode(bytes: Uint8Array): WatchStateDoc {
	const parsed = parseWatchStateText(new TextDecoder().decode(bytes))

	if (!parsed.ok) {
		throw new Error("not a watch-state document")
	}

	return parsed.doc
}

// The state file's lineage on the server, newest last, with every SDK call counted.
class Server {
	public readonly lineage: { file: SdkFile; bytes: Uint8Array }[] = []
	public readonly counts = { getFile: 0, list: 0, download: 0, upload: 0, versions: 0, deletes: 0 }
	public readonly deleted: string[] = []
	public readonly cancelled: string[] = []
	public readonly listeners: ((event: DriveSocketEvent) => void)[] = []
	public headDeleted = false
	public failUploads = 0
	public hangUploads = false
	// The deadline hits after the server committed the upload.
	public failAfterCommit = 0
	public uploadDelayMs = 0
	// Versioning off: each upload retires the previous head, announced as a fileTrash with newUUID before its fileNew.
	public supersede = false
	// Versions deleted since they were seen: downloads find nothing.
	public readonly goneUuids = new Set<string>()
	// Lineages the state file left (trashed): their files stay resolvable, never listed.
	public readonly oldLineages: { file: SdkFile; bytes: Uint8Array }[][] = []
	// The head was deleted as a version: the lineage resolves to its newest archived version, unlisted.
	public dangling = false
	public liveDeletes = 0
	public maxLiveDeletes = 0
	// Replaces the head lookup's answer (a restore between two lookups).
	public headLookup: (() => SdkFile | undefined) | null = null
	// A listing of the directory the library configuration made, and when it started.
	public sharedListing: { startedAt: number; files: SdkFile[] } | null = null
	private eventId = 1_000n
	private hung: ((error: Error) => void) | null = null

	public head(): SdkFile | undefined {
		return this.lineage.at(-1)?.file
	}

	public put(bytes: Uint8Array): SdkFile {
		const stableUuid = this.dangling ? undefined : this.head()?.stableUUID
		const file = driveFile(VIDEOS_DIR, WATCH_STATE_FILE_NAME, {
			size: bytes.length,
			timestamp: Date.now(),
			...(stableUuid === undefined ? {} : { stableUuid })
		})

		if (this.dangling) {
			this.oldLineages.push(this.lineage.splice(0))
			this.dangling = false
		}

		this.lineage.push({ file, bytes })

		return file
	}

	// The user trashes the state file: a new one is started in its place by the next save.
	public trashHead(): void {
		const head = this.head()

		if (head?.stableUUID === undefined) {
			return
		}

		this.oldLineages.push(this.lineage.splice(0).map(entry => ({ ...entry, file: { ...entry.file, parent: "trash" } })))
		this.event({ type: "fileTrash", uuid: head.uuid, stableUUID: head.stableUUID, newUUID: undefined })
	}

	// Another client deletes the live head as a version.
	public deleteHeadPermanently(): void {
		const head = this.lineage.pop()

		if (head === undefined) {
			return
		}

		this.dangling = true
		this.event({ type: "fileDeletedPermanent", uuid: head.file.uuid, stableUUID: head.file.stableUUID })
	}

	public oldUuids(): string[] {
		return this.oldLineages.flat().map(entry => entry.file.uuid)
	}

	public event(inner: DriveSocketEvent["inner"]): void {
		const event = driveEvent(++this.eventId, inner)

		for (const listener of this.listeners) {
			listener(event)
		}
	}

	public headDoc(): WatchStateDoc {
		const bytes = this.lineage.at(-1)?.bytes

		return bytes === undefined ? emptyWatchState() : decode(bytes)
	}

	public emit(file: SdkFile): void {
		this.event({ type: "fileNew", file })
	}

	public requests(): number {
		return Object.values(this.counts).reduce((sum, count) => sum + count, 0)
	}

	public reset(): void {
		for (const key of Object.keys(this.counts) as (keyof Server["counts"])[]) {
			this.counts[key] = 0
		}
	}

	public sdk(account: string): WatchStateSdk {
		return {
			account: () => Promise.resolve(account),
			videosDir: () => Promise.resolve(VIDEOS_DIR),
			findVideosDir: () => Promise.resolve(VIDEOS_DIR),
			knownVideosDir: () => VIDEOS_DIR,
			noteSystemFile: () => undefined,
			getFileByStableUuid: stable => {
				this.counts.getFile++

				const head = this.headLookup?.() ?? this.head()

				if (head?.stableUUID === stable && !this.headDeleted) {
					return Promise.resolve(head)
				}

				return Promise.resolve(this.oldLineages.map(lineage => lineage.at(-1)?.file).find(file => file?.stableUUID === stable))
			},
			listDirectory: () => {
				this.counts.list++

				const head = this.head()

				return Promise.resolve(head === undefined || this.dangling ? [] : [head])
			},
			listVideosDir: (_dir, startedAfter) => {
				if (this.sharedListing !== null && this.sharedListing.startedAt >= startedAfter) {
					return Promise.resolve(this.sharedListing.files)
				}

				this.counts.list++

				const head = this.head()

				return Promise.resolve(head === undefined || this.dangling ? [] : [head])
			},
			download: file => {
				this.counts.download++

				if (this.goneUuids.has(file.uuid)) {
					return Promise.reject(Object.assign(new Error("chunk not found"), { kind: "FileChunkNotFound" }))
				}

				return Promise.resolve(this.lineage.find(version => version.file.uuid === file.uuid)?.bytes ?? new Uint8Array())
			},
			upload: async ({ bytes, abortToken }) => {
				this.counts.upload++

				if (this.hangUploads) {
					await new Promise<never>((_, reject) => {
						this.hung = reject
					})
				}

				if (this.uploadDelayMs > 0) {
					await new Promise(resolve => {
						setTimeout(resolve, this.uploadDelayMs)
					})
				}

				await tick()

				if (this.failUploads > 0) {
					this.failUploads--

					throw new Error(`offline ${abortToken}`)
				}

				const previous = this.head()
				const file = this.put(bytes)

				if (this.supersede && previous !== undefined) {
					this.event({ type: "fileTrash", uuid: previous.uuid, stableUUID: hexUuid(), newUUID: file.uuid })
				}

				// The server commits, echoes, and the SDK still has requests to make before it resolves.
				this.emit(file)
				await tick()

				if (this.failAfterCommit > 0) {
					this.failAfterCommit--

					throw new Error("deadline")
				}

				return file
			},
			cancel: token => {
				this.cancelled.push(token)
				this.hung?.(new Error("aborted"))
			},
			listVersions: () => {
				this.counts.versions++

				return Promise.resolve(
					[...this.lineage].reverse().map(({ file }): FileVersion => {
						if (file.stableUUID === undefined) {
							throw new Error("no lineage")
						}

						return {
							bucket: file.bucket,
							region: file.region,
							chunks: file.chunks,
							size: file.size,
							metadata: file.meta,
							timestamp: file.timestamp,
							uuid: file.uuid,
							stableUUID: file.stableUUID
						}
					})
				)
			},
			deleteVersion: async version => {
				this.counts.deletes++
				this.liveDeletes++
				this.maxLiveDeletes = Math.max(this.maxLiveDeletes, this.liveDeletes)
				await tick()
				this.liveDeletes--

				if (version.uuid === this.head()?.uuid) {
					this.headDeleted = true
				}

				for (const lineage of [this.lineage, ...this.oldLineages]) {
					const index = lineage.findIndex(entry => entry.file.uuid === version.uuid)

					if (index !== -1) {
						lineage.splice(index, 1)
						this.deleted.push(version.uuid)
					}
				}
			}
		}
	}
}

function memoryStorage(): Storage {
	const values = new Map<string, string>()

	return {
		get length() {
			return values.size
		},
		key: index => [...values.keys()][index] ?? null,
		getItem: key => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value)
		},
		removeItem: key => {
			values.delete(key)
		},
		clear: () => {
			values.clear()
		}
	}
}

function sharedKv(): { kv: WatchStateKv; rows: Map<string, unknown> } {
	const { kv, rows } = memoryKv()

	return {
		rows,
		kv: {
			...kv,
			kvDeletePrefix: prefix => {
				for (const key of [...rows.keys()]) {
					if (key.startsWith(prefix)) {
						rows.delete(key)
					}
				}

				return Promise.resolve()
			}
		}
	}
}

let server: Server
let store: ReturnType<typeof sharedKv>
let storage: Storage
let versioning: boolean | undefined
let channels: BroadcastChannel[]
let tabs: Tab[]
let channelName: string
let jitter: number

interface Tab {
	engine: WatchStateEngine
	hide: () => void
	signOutElsewhere: () => void
}

function openTab({ account = ACCOUNT, kv = store.kv }: { account?: string; kv?: WatchStateKv } = {}): Tab {
	let handlers: { hidden: () => void; signOut: () => void } | null = null
	const engine = new WatchStateEngine({
		kv,
		sdk: server.sdk(account),
		host: {
			versioningEnabled: () => versioning,
			storage: () => storage,
			random: () => jitter,
			signOutPending: () => false,
			attach: next => {
				handlers = next

				return () => {
					handlers = null
				}
			},
			channel: () => {
				const channel = new BroadcastChannel(channelName)

				channels.push(channel)

				return channel
			}
		}
	})

	server.listeners.push(event => {
		engine.handleDriveEvent(event)
	})

	const tab = {
		engine,
		hide: () => {
			handlers?.hidden()
		},
		signOutElsewhere: () => {
			handlers?.signOut()
		}
	}

	tabs.push(tab)

	return tab
}

// Lets lock grants and channel deliveries land without waiting on work that may be hung on purpose.
async function ticks(count = 10): Promise<void> {
	for (let i = 0; i < count; i++) {
		await vi.advanceTimersByTimeAsync(0)
		await tick()
	}
}

async function settle(...engines: WatchStateEngine[]): Promise<void> {
	for (let round = 0; round < 3; round++) {
		await tick()

		for (const engine of engines) {
			await engine.idle()
		}
	}
}

// Advances fake time and lets every timer's flush finish.
async function advance(ms: number, ...engines: WatchStateEngine[]): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms)
	await settle(...engines)
}

function movie(overrides: Partial<WatchItem> = {}): WatchItem {
	return {
		stableUuid: hexUuid(),
		uuid: hexUuid(),
		size: 1_000_000,
		itemClass: "movie",
		...overrides
	}
}

function journalRows(): string[] {
	return [...store.rows.keys()].filter(key => key.startsWith(JOURNAL_KV_PREFIX))
}

// A doc as another device wrote it, stamped by writer `d`.
function foreignWatched(stableUuid: string, t: number, d = "other.dev"): WatchStateDoc {
	const doc = emptyWatchState()

	doc.items[itemKey(stableUuid)] = markWatched({ rec: undefined, stamp: { t, d } })

	return doc
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	vi.setSystemTime(T0)
	server = new Server()
	store = sharedKv()
	storage = memoryStorage()
	versioning = true
	channels = []
	tabs = []
	channelName = `watch-state-test-${hexUuid()}`
	jitter = 0
})

afterEach(async () => {
	for (const tab of tabs) {
		tab.engine.hold()
	}

	await settle(...tabs.map(tab => tab.engine))

	for (const channel of channels) {
		channel.close()
	}

	vi.useRealTimers()
})

describe("watch-state flush requests", () => {
	it("first flush: one head check, then one upload; the next flush of the session only uploads", async () => {
		const { engine } = openTab()
		const item = movie()

		await engine.markWatched({ stableUuids: [item.stableUuid] })
		await advance(2_000, engine)

		expect(server.counts).toEqual({ getFile: 0, list: 1, download: 0, upload: 1, versions: 0, deletes: 0 })
		expect(server.headDoc().items[itemKey(item.stableUuid)]?.w?.pl).toBe(true)
		expect(journalRows()).toEqual([])

		server.reset()
		await engine.markUnwatched({ stableUuids: [item.stableUuid] })
		await advance(10_000, engine)

		// The socket vouched for the head (this upload's own echo came before it resolved): no lookup, no re-read.
		expect(server.counts).toEqual({ getFile: 0, list: 0, download: 0, upload: 1, versions: 0, deletes: 0 })
		expect(server.headDoc().items[itemKey(item.stableUuid)]?.w?.pl).toBe(false)
	})

	it("marks a whole season watched as one edit: one debounced flush, one upload", async () => {
		const { engine } = openTab()
		const episodes = Array.from({ length: 12 }, () => movie({ itemClass: "episode" }))

		await engine.markWatched({ stableUuids: episodes.map(episode => episode.stableUuid) })
		await advance(1_000, engine)

		expect(server.counts.upload).toBe(0)

		await advance(2_000, engine)

		expect(server.counts).toEqual({ getFile: 0, list: 1, download: 0, upload: 1, versions: 0, deletes: 0 })
		expect(episodes.every(episode => server.headDoc().items[itemKey(episode.stableUuid)]?.w?.pl === true)).toBe(true)
	})

	it("never uploads unchanged state", async () => {
		const tab = openTab()
		const { engine } = tab
		const item = movie()

		await engine.markWatched({ stableUuids: [item.stableUuid] })
		await advance(2_000, engine)
		server.reset()

		// A row holding only what the file already has (a journal write that a flush already covered).
		const rec = server.headDoc().items[itemKey(item.stableUuid)]

		store.rows.set(journalRowKey(itemKey(item.stableUuid)), { r: rec })
		await engine.executeNow()
		await advance(10_000, engine)

		expect(server.requests()).toBe(0)
		expect(journalRows()).toEqual([])

		// A new page: the cached head is looked up once (1 request) and found unchanged; still nothing uploaded.
		store.rows.set(journalRowKey(itemKey(item.stableUuid)), { r: rec })

		// The weekly version cleanup ran recently.
		store.rows.set(META_KV_KEY, { ...(store.rows.get(META_KV_KEY) as object), gc: T0 })

		const next = openTab()

		await next.engine.open()
		await advance(10_000, next.engine)

		expect(server.counts).toEqual({ getFile: 1, list: 0, download: 0, upload: 0, versions: 0, deletes: 0 })
		expect(journalRows()).toEqual([])
	})

	it("reads a save from another device once (one download) when Videos opens, without uploading", async () => {
		const { engine } = openTab()
		const mine = movie()
		const theirs = movie()

		// The session's first open (its weekly version cleanup included) is behind us.
		await engine.open()
		await engine.markWatched({ stableUuids: [mine.stableUuid] })
		await advance(2_000, engine)
		server.reset()

		// Another device merged our save and added its own.
		const doc = server.headDoc()

		doc.items[itemKey(theirs.stableUuid)] =
			foreignWatched(theirs.stableUuid, (T0 + 5_000) * 1000).items[itemKey(theirs.stableUuid)] ?? {}
		server.emit(server.put(encode(doc)))

		expect(engine.getSnapshot().unsynced).toBe(true)
		expect(server.requests()).toBe(0)

		await engine.open()
		await settle(engine)

		expect(server.counts).toEqual({ getFile: 0, list: 0, download: 1, upload: 0, versions: 0, deletes: 0 })
		expect(engine.getSnapshot().doc.items[itemKey(theirs.stableUuid)]?.w?.pl).toBe(true)
		expect(engine.getSnapshot().unsynced).toBe(false)

		// The file read is the head: the next save neither looks it up nor reads it again.
		server.reset()
		await engine.hide({ stableUuid: mine.stableUuid })
		await advance(10_000, engine)

		expect(server.counts).toEqual({ getFile: 0, list: 0, download: 0, upload: 1, versions: 0, deletes: 0 })
	})

	it("doesn't take its own echo, delivered before the upload resolved, for a save from elsewhere", async () => {
		const { engine } = openTab()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)
		server.reset()

		await engine.open()
		await settle(engine)

		expect(engine.getSnapshot().unsynced).toBe(false)
		expect(server.counts.download).toBe(0)
	})

	it("puts back what a save from elsewhere went over, then uploads it", async () => {
		const { engine } = openTab()
		const mine = movie()
		const theirs = movie()

		await engine.open()
		await engine.markWatched({ stableUuids: [mine.stableUuid] })
		await advance(2_000, engine)

		// Another device wrote without reading ours: our register is missing from its save.
		server.emit(server.put(encode(foreignWatched(theirs.stableUuid, (T0 + 5_000) * 1000))))
		server.reset()
		await engine.open()
		await advance(15_000, engine)

		expect(server.counts).toEqual({ getFile: 0, list: 0, download: 1, upload: 1, versions: 0, deletes: 0 })
		expect(Object.keys(server.headDoc().items).sort()).toEqual([itemKey(mine.stableUuid), itemKey(theirs.stableUuid)].sort())
	})

	it("reads the newest parseable version of a head that doesn't parse, and replaces the head", async () => {
		const older = movie()

		server.put(encode(foreignWatched(older.stableUuid, T0 * 1000)))
		server.put(new TextEncoder().encode('{"v":1,"items":'))

		const { engine } = openTab()
		const mine = movie()

		await engine.markWatched({ stableUuids: [mine.stableUuid] })
		await advance(2_000, engine)

		expect(server.counts).toEqual({ getFile: 0, list: 1, download: 2, upload: 1, versions: 1, deletes: 0 })
		// Never written over as if it were empty: the older version's register survives.
		expect(Object.keys(server.headDoc().items).sort()).toEqual([itemKey(mine.stableUuid), itemKey(older.stableUuid)].sort())
	})

	it("takes a version superseded by its own upload (versioning off) for no change of the head", async () => {
		versioning = false
		server.supersede = true

		const { engine } = openTab()
		const item = movie()

		await engine.markWatched({ stableUuids: [item.stableUuid] })
		await advance(2_000, engine)
		await engine.markUnwatched({ stableUuids: [item.stableUuid] })
		await advance(10_000, engine)
		server.reset()
		await engine.markWatched({ stableUuids: [item.stableUuid] })
		await advance(10_000, engine)

		expect(server.counts).toEqual({ getFile: 0, list: 0, download: 0, upload: 1, versions: 0, deletes: 0 })
	})

	it("leaves a head written by a newer version alone", async () => {
		server.put(new TextEncoder().encode(JSON.stringify({ v: 2, items: {}, series: {} })))

		const { engine } = openTab()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)

		expect(server.counts.upload).toBe(0)
		expect(journalRows()).toHaveLength(1)

		// Further triggers cost nothing while the socket vouches for that head.
		server.reset()
		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(10_000, engine)

		expect(server.requests()).toBe(0)
	})
})

describe("watch-state triggers", () => {
	it("journals every 15 s while the position moves and uploads every 5 min of playback", async () => {
		const { engine } = openTab()
		const item = movie()
		const journalWrites = vi.spyOn(store.kv, "kvSetJson")

		for (let second = 0; second <= 330; second++) {
			engine.reportProgress({ item, pos: second, dur: 7_200, playing: true })
			await vi.advanceTimersByTimeAsync(1_000)
		}

		await settle(engine)

		const rowWrites = journalWrites.mock.calls.filter(([key]) => key.startsWith(JOURNAL_KV_PREFIX))

		// The first report (a state change), then one per 15 s.
		expect(rowWrites.length).toBe(1 + Math.floor(330 / 15))
		expect(server.counts.upload).toBe(1)
		expect(server.headDoc().items[itemKey(item.stableUuid)]?.p?.pos).toBeGreaterThanOrEqual(285)
	})

	it("uploads on pause only after 30 s of movement and a minute since the last upload", async () => {
		const { engine } = openTab()
		const item = movie()

		engine.reportProgress({ item, pos: 100, dur: 7_200, playing: true })
		await advance(20_000, engine)
		engine.reportProgress({ item, pos: 120, dur: 7_200, playing: false })
		await advance(1_000, engine)

		expect(server.counts.upload).toBe(0)

		engine.reportProgress({ item, pos: 120, dur: 7_200, playing: true })
		await advance(15_000, engine)
		engine.reportProgress({ item, pos: 135, dur: 7_200, playing: false })
		await advance(1_000, engine)

		expect(server.counts.upload).toBe(1)

		// Moved again, but within a minute of that upload: no upload on this pause.
		engine.reportProgress({ item, pos: 135, dur: 7_200, playing: true })
		await advance(35_000, engine)
		engine.reportProgress({ item, pos: 170, dur: 7_200, playing: false })
		await advance(1_000, engine)

		expect(server.counts.upload).toBe(1)
	})

	it("debounces semantic events and keeps 10 s between their uploads", async () => {
		const { engine } = openTab()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(1_000, engine)
		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(1_999, engine)

		expect(server.counts.upload).toBe(0)

		await advance(1, engine)

		expect(server.counts.upload).toBe(1)

		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(9_000, engine)

		expect(server.counts.upload).toBe(1)

		await advance(1_000, engine)

		expect(server.counts.upload).toBe(2)
	})

	it("records a completion when playback crosses 90 %", async () => {
		const { engine } = openTab()
		const item = movie()

		engine.reportProgress({ item, pos: 3_000, dur: 6_000, playing: true })
		engine.reportProgress({ item, pos: 5_500, dur: 6_000, playing: true })
		await advance(2_000, engine)

		const rec = server.headDoc().items[itemKey(item.stableUuid)]

		expect(rec?.w).toMatchObject({ pl: true, pc: 1 })
		expect(server.counts.upload).toBe(1)
	})

	it("backs off after a failed upload and keeps the state dirty", async () => {
		const { engine } = openTab()

		server.failUploads = 2
		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)

		expect(server.counts.upload).toBe(1)
		expect(journalRows()).toHaveLength(1)

		await advance(29_000, engine)
		expect(server.counts.upload).toBe(1)
		await advance(1_000, engine)
		expect(server.counts.upload).toBe(2)

		await advance(59_000, engine)
		expect(server.counts.upload).toBe(2)
		await advance(1_000, engine)
		expect(server.counts.upload).toBe(3)
		expect(journalRows()).toEqual([])
	})
})

describe("watch-state version cleanup", () => {
	async function uploads(engine: WatchStateEngine, count: number): Promise<void> {
		for (let i = 0; i < count; i++) {
			await engine.markWatched({ stableUuids: [movie().stableUuid] })
			await advance(10_000, engine)
		}
	}

	it("deletes superseded own uploads at stop but the newest of them, concurrently (n + 2 requests), never the head", async () => {
		const { engine } = openTab()

		await uploads(engine, 5)

		const ownUuids = server.lineage.map(entry => entry.file.uuid)

		server.reset()

		const item = movie()

		engine.reportProgress({ item, pos: 10, dur: 7_200, playing: true })
		await engine.reportStop({ item, pos: 40, dur: 7_200 })
		await advance(10_000, engine)

		// The stop's upload, a fresh head lookup, then the deletes.
		expect(server.counts).toMatchObject({ upload: 1, getFile: 1, deletes: 4 })
		expect(server.deleted.sort()).toEqual(ownUuids.slice(0, 4).sort())
		expect(server.maxLiveDeletes).toBe(4)
		expect(server.headDeleted).toBe(false)
		expect(server.lineage.map(entry => entry.file.uuid)).toEqual([ownUuids[4], server.head()?.uuid])
	})

	it("skips cleanup when versioning is off", async () => {
		versioning = false

		const { engine } = openTab()

		await uploads(engine, 4)
		server.reset()

		const item = movie()

		engine.reportProgress({ item, pos: 10, dur: 7_200, playing: true })
		await engine.reportStop({ item, pos: 40, dur: 7_200 })
		await advance(10_000, engine)

		expect(server.counts).toMatchObject({ getFile: 0, deletes: 0, versions: 0 })
	})

	it("weekly cleanup never deletes the head, even when it moved between the listing and the deletes", async () => {
		// Old versions from other devices, a week and more ago.
		for (let i = 0; i < 6; i++) {
			vi.setSystemTime(T0 - (20 - i) * 86_400_000)
			server.put(encode(foreignWatched(hexUuid(), (T0 - (20 - i) * 86_400_000) * 1000)))
		}

		vi.setSystemTime(T0)

		const { engine } = openTab()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)

		const restored = server.lineage[0]?.file

		if (restored === undefined) {
			throw new Error("no version")
		}

		// A restore elsewhere makes the oldest version the head again right after the listing. The new page's own head
		// check comes first, and the cleanup starts from the head it confirmed.
		let lookups = 0

		server.headLookup = () => (++lookups >= 2 ? restored : undefined)
		server.reset()

		const next = openTab()

		await next.engine.open()
		await settle(next.engine)

		expect(server.counts).toMatchObject({ getFile: 2, versions: 1 })
		expect(server.deleted).not.toContain(restored.uuid)
		expect(server.headDeleted).toBe(false)
		// Six archived versions: the newest two kept, the restored head spared, three deleted in one batch.
		expect(server.counts.deletes).toBe(3)
	})
})

describe("watch-state across tabs", () => {
	it("flushes from one tab at a time: two tabs' changes make one upload, and no tab re-reads it", async () => {
		const a = openTab()
		const b = openTab()

		await a.engine.markWatched({ stableUuids: [movie().stableUuid] })
		await b.engine.markWatched({ stableUuids: [movie().stableUuid] })
		await settle(a.engine, b.engine)
		await advance(2_000, a.engine, b.engine)

		expect(server.counts.upload).toBe(1)
		expect(Object.keys(server.headDoc().items)).toHaveLength(2)

		server.reset()
		await a.engine.open()
		await b.engine.open()
		await settle(a.engine, b.engine)

		expect(server.counts.download).toBe(0)
		expect(b.engine.getSnapshot().unsynced).toBe(false)
		expect(Object.keys(b.engine.getSnapshot().doc.items)).toHaveLength(2)
	})

	it("keeps the snapshot identity while nothing changed (a peer's sync re-read)", async () => {
		const a = openTab()
		const b = openTab()
		const item = movie()

		await a.engine.markWatched({ stableUuids: [item.stableUuid] })
		await advance(2_000, a.engine, b.engine)
		await b.engine.open()
		await settle(a.engine, b.engine)

		const snapshot = b.engine.getSnapshot()
		let renders = 0
		const unsubscribe = b.engine.subscribe(() => {
			renders++
		})

		await b.engine.open()
		await a.engine.executeNow()
		await settle(a.engine, b.engine)
		unsubscribe()

		expect(b.engine.getSnapshot()).toBe(snapshot)
		expect(renders).toBe(0)
		expect(snapshot.doc.items[itemKey(item.stableUuid)]?.w?.pl).toBe(true)
	})

	it("stops writing once a sign-out starts in another tab", async () => {
		const { engine, signOutElsewhere } = openTab()

		await engine.open()
		signOutElsewhere()
		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(10_000, engine)

		expect(journalRows()).toEqual([])
		expect(server.counts.upload).toBe(0)
	})
})

describe("watch-state sign-out", () => {
	it("cancel aborts the upload in flight, writes nothing more and drops the pending progress", async () => {
		const { engine, hide } = openTab()
		const item = movie()

		engine.reportProgress({ item, pos: 100, dur: 7_200, playing: true })
		engine.reportProgress({ item, pos: 140, dur: 7_200, playing: true })
		await settle(engine)
		server.hangUploads = true
		hide()
		await ticks()

		expect(storage.getItem(PENDING_STORAGE_KEY)).not.toBeNull()
		expect(server.counts.upload).toBe(1)

		const rowsBefore = journalRows().length

		engine.cancel()
		await settle(engine)

		expect(server.cancelled).toHaveLength(1)
		expect(storage.getItem(PENDING_STORAGE_KEY)).toBeNull()

		engine.reportProgress({ item, pos: 500, dur: 7_200, playing: true })
		await engine.markWatched({ stableUuids: [item.stableUuid] })
		await advance(60_000, engine)

		expect(journalRows()).toHaveLength(rowsBefore)
		expect(storage.getItem(PENDING_STORAGE_KEY)).toBeNull()
	})

	it("executeNow uploads whatever the floors say, and gives up after 30 s", async () => {
		const { engine } = openTab()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)
		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await engine.executeNow()

		expect(server.counts.upload).toBe(2)

		server.hangUploads = true
		await engine.markWatched({ stableUuids: [movie().stableUuid] })

		let done = false

		void engine.executeNow().then(() => {
			done = true
		})
		await vi.advanceTimersByTimeAsync(29_000)
		expect(done).toBe(false)
		await vi.advanceTimersByTimeAsync(1_000)
		await tick()
		expect(done).toBe(true)
		engine.cancel()
	})
})

describe("watch-state local journal", () => {
	it("merges the progress a page saved as it went away on the next open, and uploads it", async () => {
		const item = movie()
		const first = openTab({
			kv: {
				...store.kv,
				kvSetJson: (key, value) =>
					key.startsWith(JOURNAL_KV_PREFIX) ? Promise.reject(new Error("page gone")) : store.kv.kvSetJson(key, value)
			}
		})

		// The page goes away before its journal write lands.
		first.engine.reportProgress({ item, pos: 1_234, dur: 7_200, playing: true })
		await tick()
		first.hide()
		first.engine.hold()

		expect(journalRows()).toEqual([])
		expect(storage.getItem(PENDING_STORAGE_KEY)).not.toBeNull()

		const next = openTab()

		await next.engine.open()
		await advance(2_000, next.engine)

		expect(storage.getItem(PENDING_STORAGE_KEY)).toBeNull()
		expect(server.headDoc().items[itemKey(item.stableUuid)]?.p?.pos).toBe(1_234)
	})

	it("drops another account's journal and pending progress", async () => {
		const other = openTab({ account: hexUuid() })
		const item = movie()

		await other.engine.markWatched({ stableUuids: [item.stableUuid] })
		other.engine.hold()
		storage.setItem(
			PENDING_STORAGE_KEY,
			JSON.stringify({ a: "someone-else", e: [[item.stableUuid, item.uuid, 1, 5, 10, T0, T0 * 1000, "x.y", -1]] })
		)

		expect(journalRows()).toHaveLength(1)

		const { engine } = openTab()

		await engine.open()
		await advance(10_000, engine)

		expect(journalRows()).toEqual([])
		expect(storage.getItem(PENDING_STORAGE_KEY)).toBeNull()
		expect(server.counts.upload).toBe(0)
		expect(engine.getSnapshot().doc.items).toEqual({})
		expect((store.rows.get(META_KV_KEY) as { a: string } | undefined)?.a).toBe(ACCOUNT)
	})
})

// Another device's save holding `stableUuid` watched, merged over what the server has (as a well-behaved writer does).
function foreignSaveOver(stableUuid: string, t: number): SdkFile {
	const doc = server.headDoc()

	doc.items[itemKey(stableUuid)] = foreignWatched(stableUuid, t).items[itemKey(stableUuid)] ?? {}

	return server.put(encode(doc))
}

function meta(): WatchMeta | undefined {
	return store.rows.get(META_KV_KEY) as WatchMeta | undefined
}

describe("watch-state with a tab that died mid-flush", () => {
	async function peerStartsFlushing(): Promise<BroadcastChannel> {
		const peer = new BroadcastChannel(channelName)

		channels.push(peer)
		peer.postMessage({ type: "flushing", a: ACCOUNT })
		await tick()

		return peer
	}

	it("judges what the dead tab held as foreign on the next flush instead of uploading over it", async () => {
		const { engine } = openTab()
		const mine = movie()
		const theirs = movie()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)
		await peerStartsFlushing()

		// Another device saves while the dead tab's marker is up; that tab never reports back.
		server.emit(foreignSaveOver(theirs.stableUuid, (T0 + 3_000) * 1000))
		server.reset()
		await engine.markWatched({ stableUuids: [mine.stableUuid] })
		await advance(10_000, engine)

		expect(server.counts).toMatchObject({ getFile: 1, download: 1, upload: 1 })
		expect(Object.keys(server.headDoc().items)).toEqual(expect.arrayContaining([itemKey(mine.stableUuid), itemKey(theirs.stableUuid)]))
	})

	it("stops holding saves for a tab that never reported back", async () => {
		const { engine } = openTab()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)
		await peerStartsFlushing()
		await vi.advanceTimersByTimeAsync(PEER_FLUSH_EXPIRY_MS + 1)
		server.emit(foreignSaveOver(movie().stableUuid, (T0 + 60_000) * 1000))

		expect(engine.getSnapshot().unsynced).toBe(true)
	})
})

describe("watch-state saves from elsewhere", () => {
	it("drops a save deleted before it was read, without failing the open", async () => {
		const { engine } = openTab()

		await engine.open()
		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)

		const save = foreignSaveOver(movie().stableUuid, (T0 + 3_000) * 1000)

		server.emit(save)
		server.goneUuids.add(save.uuid)
		server.reset()
		await engine.open()
		await settle(engine)

		expect(server.counts.download).toBe(1)
		expect(engine.getSnapshot().unsynced).toBe(false)

		await engine.open()
		await settle(engine)

		expect(server.counts.download).toBe(1)
	})

	it("reads only the newest of several saves from elsewhere", async () => {
		const { engine } = openTab()

		await engine.open()
		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)
		server.emit(foreignSaveOver(movie().stableUuid, (T0 + 3_000) * 1000))
		server.emit(foreignSaveOver(movie().stableUuid, (T0 + 4_000) * 1000))
		server.reset()
		await engine.open()
		await settle(engine)

		expect(server.counts).toMatchObject({ download: 1, upload: 0 })
		expect(Object.keys(engine.getSnapshot().doc.items)).toHaveLength(3)
	})

	it("doesn't read a save again (or roll the head back to it) once a flush has read the head", async () => {
		const { engine } = openTab()

		await engine.open()
		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)
		server.emit(foreignSaveOver(movie().stableUuid, (T0 + 3_000) * 1000))
		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(10_000, engine)
		server.reset()
		await engine.open()
		await advance(60_000, engine)

		expect(server.requests()).toBe(0)
		expect(engine.getSnapshot().unsynced).toBe(false)
		expect(Object.keys(engine.getSnapshot().doc.items)).toHaveLength(3)
	})

	it("ignores drive events until the state is loaded, and doesn't claim to be loaded", () => {
		const { engine } = openTab()

		server.emit(server.put(encode(foreignWatched(movie().stableUuid, T0 * 1000))))

		expect(engine.getSnapshot()).toMatchObject({ loaded: false, unsynced: false })
	})
})

describe("watch-state cleanup across lineages and restores", () => {
	async function uploads(engine: WatchStateEngine, count: number): Promise<void> {
		for (let i = 0; i < count; i++) {
			await engine.markWatched({ stableUuids: [movie().stableUuid] })
			await advance(10_000, engine)
		}
	}

	async function stop(engine: WatchStateEngine): Promise<void> {
		const item = movie()

		engine.reportProgress({ item, pos: 10, dur: 7_200, playing: true })
		await engine.reportStop({ item, pos: 40, dur: 7_200 })
		await advance(10_000, engine)
	}

	it("never deletes versions of a trashed state file once a new one was started", async () => {
		const { engine } = openTab()

		await uploads(engine, 3)

		const old: string[] = server.lineage.map(entry => entry.file.uuid)

		server.trashHead()
		await uploads(engine, 2)
		await stop(engine)

		expect(server.oldUuids()).toEqual(old)
		expect(server.deleted.filter(uuid => old.includes(uuid))).toEqual([])
		const current: string | undefined = server.head()?.stableUUID

		expect(meta()?.own.every(([, stable]) => stable === current)).toBe(true)
	})

	it("looks the head up again before each batch of deletes and spares one restored meanwhile", async () => {
		const { engine } = openTab()

		await uploads(engine, 24)

		const lineage = server.lineage.map(entry => entry.file)
		// The stop's upload makes 25: 23 prune targets (all but the head and the newest superseded one), in batches of
		// 20 and 3. The second batch's head lookup finds one of its targets restored.
		const restored = lineage[21]

		if (restored === undefined) {
			throw new Error("no version")
		}

		let lookups = 0

		server.headLookup = () => (++lookups === 2 ? restored : undefined)
		server.reset()
		await stop(engine)

		expect(lookups).toBe(2)
		expect(server.counts.deletes).toBe(22)
		expect(server.deleted).not.toContain(restored.uuid)
		expect(server.headDeleted).toBe(false)
	})

	it("writes the state anew at once when the live head is deleted permanently", async () => {
		const { engine } = openTab()
		const item = movie()

		await engine.markWatched({ stableUuids: [item.stableUuid] })
		await advance(2_000, engine)
		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(10_000, engine)
		server.reset()
		server.deleteHeadPermanently()
		await settle(engine)

		expect(server.counts).toMatchObject({ getFile: 0, list: 1, upload: 1 })
		expect(Object.keys(server.headDoc().items)).toHaveLength(2)
	})
})

describe("watch-state flush costs", () => {
	it("queues no flushes behind an upload in flight, and stamps the sync when it starts", async () => {
		const { engine } = openTab()
		const item = movie()
		const reads = vi.spyOn(store.kv, "kvEntriesJson")

		server.uploadDelayMs = 20_000

		for (let second = 0; second <= 400; second++) {
			engine.reportProgress({ item, pos: second, dur: 7_200, playing: true })
			await vi.advanceTimersByTimeAsync(1_000)
		}

		await settle(engine)

		expect(server.counts.upload).toBe(1)
		expect(reads.mock.calls.length).toBeLessThan(5)
	})

	it("doesn't upload on a tab switch unless the position moved 30 s, and handles a close's double event once", async () => {
		const { engine, hide } = openTab()
		const item = movie()
		const writes = vi.spyOn(store.kv, "kvSetJson")

		engine.reportProgress({ item, pos: 100, dur: 7_200, playing: true })
		engine.reportProgress({ item, pos: 110, dur: 7_200, playing: true })
		await settle(engine)
		hide()
		await advance(10_000, engine)

		expect(server.counts.upload).toBe(0)

		engine.reportProgress({ item, pos: 140, dur: 7_200, playing: true })
		writes.mockClear()
		hide()
		hide()
		await advance(10_000, engine)

		expect(server.counts.upload).toBe(1)
		expect(writes.mock.calls.filter(([key]) => key.startsWith(JOURNAL_KV_PREFIX))).toHaveLength(1)
	})

	it("doesn't read the cached head again while nothing changed it", async () => {
		const { engine } = openTab()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)

		const reads = vi.spyOn(store.kv, "kvGetJson")

		await engine.executeNow()
		await engine.executeNow()

		expect(reads.mock.calls.filter(([key]) => key === HEAD_KV_KEY)).toEqual([])
	})

	it("renders nobody for position-only journal writes", async () => {
		const a = openTab()
		const b = openTab()
		const item = movie()

		await a.engine.open()
		await b.engine.open()
		await settle(a.engine, b.engine)
		a.engine.reportProgress({ item, pos: 0, dur: 7_200, playing: true })
		await settle(a.engine, b.engine)

		let renders = 0
		const unsubscribe = [a, b].map(tab =>
			tab.engine.subscribe(() => {
				renders++
			})
		)

		for (let second = 1; second <= 60; second++) {
			a.engine.reportProgress({ item, pos: second, dur: 7_200, playing: true })
			await vi.advanceTimersByTimeAsync(1_000)
		}

		await settle(a.engine, b.engine)

		for (const off of unsubscribe) {
			off()
		}

		expect(renders).toBe(0)
	})

	it("records an upload the deadline aborted after the server committed it, and its echo as its own", async () => {
		const { engine } = openTab()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)
		server.failAfterCommit = 1
		server.reset()
		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(10_000, engine)

		expect(server.counts).toMatchObject({ upload: 1, getFile: 1, download: 1 })
		expect(meta()?.own.at(-1)?.[0]).toBe(server.head()?.uuid)
		expect(journalRows()).toEqual([])
		expect(engine.getSnapshot().unsynced).toBe(false)

		await advance(120_000, engine)

		expect(server.counts.upload).toBe(1)
	})
})

describe("watch-state unsynced work", () => {
	it("is dirty from a journaled change until it is uploaded", async () => {
		const { engine } = openTab()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })

		expect(engine.getSnapshot().dirty).toBe(true)

		await advance(2_000, engine)

		expect(engine.getSnapshot().dirty).toBe(false)
	})

	it("joins a running executeNow instead of starting another", async () => {
		const { engine } = openTab()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })

		const first = engine.executeNow()

		expect(engine.executeNow()).toBe(first)
		await first
		expect(server.counts.upload).toBe(1)
	})
})

describe("watch-state on a new page", () => {
	// Another browser of the account: its own kv (journal, cached head), the same server.
	function otherDevice(): Tab {
		return openTab({ kv: sharedKv().kv })
	}

	it("confirms an unchanged head with one lookup and reads nothing", async () => {
		const { engine } = openTab()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)
		engine.hold()
		server.reset()

		// Version cleanup ran recently, so the new page's open does nothing else.
		store.rows.set(META_KV_KEY, { ...(store.rows.get(META_KV_KEY) as object), gc: T0 })

		const next = openTab()

		await next.engine.open()
		await settle(next.engine)

		expect(server.counts).toEqual({ getFile: 1, list: 0, download: 0, upload: 0, versions: 0, deletes: 0 })
	})

	it("reads a save made elsewhere while the page was closed (one lookup, one download) and keeps its newer position", async () => {
		const item = movie()
		const here = openTab()

		await here.engine.open()
		here.engine.reportProgress({ item, pos: 100, dur: 7_200, playing: true })
		here.engine.reportProgress({ item, pos: 101, dur: 7_200, playing: false })
		await here.engine.executeNow()
		await settle(here.engine)
		here.engine.hold()

		// Later, another browser plays on to 4000 s and saves; this browser's pages are all closed (no socket event).
		vi.setSystemTime(T0 + 60_000)

		const there = otherDevice()

		await there.engine.open()
		there.engine.reportProgress({ item, pos: 3_999, dur: 7_200, playing: true })
		there.engine.reportProgress({ item, pos: 4_000, dur: 7_200, playing: false })
		await there.engine.executeNow()
		await settle(there.engine)
		there.engine.hold()
		server.reset()
		store.rows.set(META_KV_KEY, { ...(store.rows.get(META_KV_KEY) as object), gc: T0 + 60_000 })

		const next = openTab()

		await next.engine.open()

		expect(server.counts).toMatchObject({ getFile: 1, download: 1, upload: 0 })
		expect(next.engine.getSnapshot().doc.items[itemKey(item.stableUuid)]?.p?.pos).toBe(4_000)

		// This page's next save goes over the newer position, never back to 101.
		await next.engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(10_000, next.engine)

		expect(server.headDoc().items[itemKey(item.stableUuid)]?.p?.pos).toBe(4_000)
	})

	it("finds the state file by listing when this browser never cached a head", async () => {
		const item = movie()
		const there = otherDevice()

		await there.engine.open()
		there.engine.reportProgress({ item, pos: 3_999, dur: 7_200, playing: true })
		there.engine.reportProgress({ item, pos: 4_000, dur: 7_200, playing: false })
		await there.engine.executeNow()
		await settle(there.engine)
		there.engine.hold()
		server.reset()
		// No version cleanup in the count.
		versioning = false

		const fresh = otherDevice()

		await fresh.engine.open()

		expect(server.counts).toMatchObject({ getFile: 0, list: 1, download: 1, upload: 0 })
		expect(fresh.engine.getSnapshot().doc.items[itemKey(item.stableUuid)]?.p?.pos).toBe(4_000)
	})

	it("takes the state file from a listing started once the page followed the socket, never from an older one", async () => {
		const item = movie()
		const there = otherDevice()

		await there.engine.open()
		there.engine.reportProgress({ item, pos: 3_999, dur: 7_200, playing: true })
		there.engine.reportProgress({ item, pos: 4_000, dur: 7_200, playing: false })
		await there.engine.executeNow()
		await settle(there.engine)
		there.engine.hold()
		versioning = false

		const head = server.head()

		if (head === undefined) {
			throw new Error("no head")
		}

		// Listed before this page loaded: a save in between could be missing from it.
		server.sharedListing = { startedAt: performance.now() - 1, files: [] }
		server.reset()

		const stale = otherDevice()

		await stale.engine.open()

		expect(server.counts).toMatchObject({ list: 1, download: 1 })

		// Listed after: what it holds, or a save the socket reports.
		server.sharedListing = { startedAt: Number.MAX_VALUE, files: [head] }
		server.reset()

		const fresh = otherDevice()

		await fresh.engine.open()

		expect(server.counts).toMatchObject({ getFile: 0, list: 0, download: 1 })
		expect(fresh.engine.getSnapshot().doc.items[itemKey(item.stableUuid)]?.p?.pos).toBe(4_000)
	})

	it("looks the head up again right before pruning at the first open, sparing a version restored since its check", async () => {
		const { engine } = openTab()

		for (let i = 0; i < 3; i++) {
			await engine.markWatched({ stableUuids: [movie().stableUuid] })
			await advance(10_000, engine)
		}

		engine.hold()
		store.rows.set(META_KV_KEY, { ...(store.rows.get(META_KV_KEY) as object), gc: Date.now() })

		// The oldest own upload, the one prune target; another device restores it after the open's head check,
		// before its socket event arrives.
		const restored = server.lineage[0]?.file

		if (restored === undefined) {
			throw new Error("no version")
		}

		let lookups = 0

		server.headLookup = () => (++lookups === 2 ? restored : undefined)
		server.reset()

		const next = openTab()

		await next.engine.open()
		await settle(next.engine)

		expect(server.counts).toMatchObject({ getFile: 2, list: 0, download: 0, upload: 0 })
		expect(server.deleted).not.toContain(restored.uuid)
		expect(server.headDeleted).toBe(false)
	})

	it("adds up to a quarter of jitter to the upload backoff", async () => {
		jitter = 0.999
		server.failUploads = 1

		const { engine } = openTab()

		await engine.markWatched({ stableUuids: [movie().stableUuid] })
		await advance(2_000, engine)
		expect(server.counts.upload).toBe(1)

		await advance(36_000, engine)
		expect(server.counts.upload).toBe(1)
		await advance(2_000, engine)
		expect(server.counts.upload).toBe(2)
	})
})
