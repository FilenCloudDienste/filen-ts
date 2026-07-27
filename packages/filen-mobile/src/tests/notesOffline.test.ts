import { vi, describe, it, expect, beforeEach } from "vitest"
import { onlineManager } from "@tanstack/react-query"

// notesOffline reaches SQLite, the SDK and the query client; all of those are stubbed here so the
// ledger, the sync plan and — most importantly — the open-editor write rules can be exercised for
// real. The kv fake is a plain Map so ledger rows genuinely round-trip through serialize/deserialize
// shaped access rather than being asserted on a spy.
const { kvStore, contentCache, contentStamps, getContentMock, notesFetchMock, flushNowMock, scanHook, kvSetShouldFail, loggerMock } =
	vi.hoisted(() => ({
		kvStore: new Map<string, unknown>(),
		contentCache: new Map<string, string>(),
		// Mirrors the query's dataUpdatedAt: bumped on every write, so the "did someone else write while
		// we were fetching" guard is exercised for real rather than stubbed to a constant.
		contentStamps: new Map<string, number>(),
		getContentMock: vi.fn(async (): Promise<string | undefined> => ""),
		notesFetchMock: vi.fn(async () => [] as unknown[]),
		flushNowMock: vi.fn(async () => undefined),
		// Lets a test inject a scan failure (SQLITE_BUSY and friends) without stubbing the whole pager.
		scanHook: vi.fn(),
		// Lets a test make kv writes fail, for the "eviction could not be recorded" contract.
		kvSetShouldFail: { value: false },
		loggerMock: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
	}))

vi.mock("@/lib/logger", () => ({ default: loggerMock }))

// Echoes the key back, so the offline-guard assertion can name the string a user would actually see.
// The real module reaches expo-localization.
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }))

// Sentinel a test can plant to make exactly one row undecodable.
const CORRUPT_ROW = "__corrupt__"

vi.mock("@/lib/serializer", () => ({
	serialize: (value: unknown) => JSON.stringify(value),
	deserialize: (value: string) => JSON.parse(value)
}))

vi.mock("@/lib/sqlite", () => ({
	default: {
		openDb: async () => ({
			executeBatch: async () => undefined
		}),
		kvAsync: {
			get: async (key: string) => kvStore.get(key) ?? null,
			set: async (key: string, value: unknown) => {
				if (kvSetShouldFail.value) {
					throw new Error("kv write failed")
				}

				kvStore.set(key, value)

				return 1
			},
			remove: async (key: string) => {
				kvStore.delete(key)
			}
		}
	}
}))

// The real pager walks a DB cursor; here it just replays the fake store's matching rows in the same
// (key, serializedValue) shape the caller deserializes.
vi.mock("@/lib/kvScan", () => ({
	forEachKvRowByPrefix: async (_db: unknown, prefix: string, onRow: (key: string, value: string) => void) => {
		scanHook()

		for (const [key, value] of kvStore) {
			if (key.startsWith(prefix)) {
				onRow(key, value === "__corrupt__" ? "{not json" : JSON.stringify(value))
			}
		}
	},
	prefixUpperBound: (prefix: string) => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
}))

vi.mock("@/features/notes/queries/useNotesQuery", () => ({
	fetchData: notesFetchMock
}))

vi.mock("@/features/notes/queries/useNoteContent.query", () => ({
	noteContentQueryGet: ({ uuid }: { uuid: string }) => contentCache.get(uuid),
	// Faithful to queries/client's queryUpdater.set: an explicit `dataUpdatedAt` is honoured verbatim
	// and only its ABSENCE bumps the stamp. components/sync's post-push write passes the previous
	// value back on purpose (to keep the editor's remount key stable), so a fake that always bumped
	// modelled a writer that does not exist — and made the staleness guard look like it worked.
	noteContentQueryUpdate: ({ params, updater, dataUpdatedAt }: { params: { uuid: string }; updater: string; dataUpdatedAt?: number }) => {
		contentCache.set(params.uuid, updater)
		contentStamps.set(params.uuid, typeof dataUpdatedAt === "number" ? dataUpdatedAt : (contentStamps.get(params.uuid) ?? 0) + 1)
	},
	noteContentQueryDataUpdatedAt: ({ uuid }: { uuid: string }) => contentStamps.get(uuid),
	noteContentQueryKey: ({ uuid }: { uuid: string }) => ["useNoteContentQuery", { uuid }]
}))

vi.mock("@/features/notes/notesContent", () => ({
	getContent: getContentMock
}))

vi.mock("@/queries/client", () => ({
	removeQueryEverywhere: (queryKey: unknown[]) => {
		const uuid = (queryKey[1] as { uuid: string }).uuid

		contentCache.delete(uuid)
		contentStamps.delete(uuid)
	},
	queryClientPersisterKv: { flushNow: flushNowMock }
}))

import { NotesOffline, planNoteOfflineSync, noteEditedStamp, isNoteScreenOpen } from "@/features/notes/notesOffline"
import useNotesInflightStore from "@/features/notes/store/useNotesInflight.store"
import useNotesOfflineStore from "@/features/notes/store/useNotesOffline.store"
import useAppStore from "@/stores/useApp.store"
import type { Note } from "@/types"

function note(uuid: string, editedTimestamp: number): Note {
	return {
		uuid,
		editedTimestamp: BigInt(editedTimestamp)
	} as unknown as Note
}

// Seeds a cached body the way a real fetch would, keeping the stamp in step.
function seedCachedBody(uuid: string, content: string): void {
	contentCache.set(uuid, content)
	contentStamps.set(uuid, (contentStamps.get(uuid) ?? 0) + 1)
}

// Writes a body the way components/sync's post-push truth write does: content replaced, stamp
// deliberately PRESERVED so the editor's remount key stays stable.
function pushLikeNotesSync(uuid: string, content: string): void {
	contentCache.set(uuid, content)
}

function setInflight(uuid: string, content: string): void {
	useNotesInflightStore.getState().setInflightContent(prev => ({
		...prev,
		[uuid]: [{ timestamp: 1, content, note: note(uuid, 1) }]
	}))
}

beforeEach(() => {
	vi.clearAllMocks()
	kvStore.clear()
	contentCache.clear()
	contentStamps.clear()
	useNotesInflightStore.getState().setInflightContent({})
	useNotesOfflineStore.getState().setMarked({})
	useNotesOfflineStore.setState({ openContentViews: {} })
	useAppStore.getState().setPathname("/")
	onlineManager.setOnline(true)
	getContentMock.mockResolvedValue("")
	notesFetchMock.mockResolvedValue([])
	scanHook.mockImplementation(() => undefined)
	kvSetShouldFail.value = false
})

describe("planNoteOfflineSync", () => {
	it("fetches a marked note whose body was never cached", () => {
		const plan = planNoteOfflineSync({
			marked: new Map([["a", { editedTimestamp: null }]]),
			notes: [note("a", 10)],
			inflightUuids: new Set(),
			cachedUuids: new Set(),
			openUuids: new Set()
		})

		expect(plan.fetch).toEqual(["a"])
		expect(plan.prune).toEqual([])
	})

	it("fetches a marked note whose edit stamp moved past the cached body", () => {
		const plan = planNoteOfflineSync({
			marked: new Map([["a", { editedTimestamp: "10" }]]),
			notes: [note("a", 20)],
			inflightUuids: new Set(),
			cachedUuids: new Set(["a"]),
			openUuids: new Set()
		})

		expect(plan.fetch).toEqual(["a"])
	})

	it("leaves a marked note alone when the cached body matches the current stamp", () => {
		const plan = planNoteOfflineSync({
			marked: new Map([["a", { editedTimestamp: "10" }]]),
			notes: [note("a", 10)],
			inflightUuids: new Set(),
			cachedUuids: new Set(["a"]),
			openUuids: new Set()
		})

		expect(plan.fetch).toEqual([])
	})

	// A ledger entry can claim currency while the body itself is gone — evicted, or written by a
	// background run whose persist never reached disk. The cached-set check is what re-fetches it.
	it("re-fetches when the ledger claims currency but no body is cached", () => {
		const plan = planNoteOfflineSync({
			marked: new Map([["a", { editedTimestamp: "10" }]]),
			notes: [note("a", 10)],
			inflightUuids: new Set(),
			cachedUuids: new Set(),
			openUuids: new Set()
		})

		expect(plan.fetch).toEqual(["a"])
	})

	// The draft is the newest truth; replacing the cached body underneath it would re-base the
	// conflict detection in components/sync against content the user never saw.
	it("never fetches a note carrying unsynced local edits, however stale the body is", () => {
		const plan = planNoteOfflineSync({
			marked: new Map([["a", { editedTimestamp: "10" }]]),
			notes: [note("a", 99)],
			inflightUuids: new Set(["a"]),
			cachedUuids: new Set(["a"]),
			openUuids: new Set()
		})

		expect(plan.fetch).toEqual([])
		expect(plan.prune).toEqual([])
	})

	it("prunes a marked note the account no longer has", () => {
		const plan = planNoteOfflineSync({
			marked: new Map([
				["a", { editedTimestamp: "10" }],
				["gone", { editedTimestamp: "5" }]
			]),
			notes: [note("a", 10)],
			inflightUuids: new Set(),
			cachedUuids: new Set(["a"]),
			openUuids: new Set()
		})

		expect(plan.prune).toEqual(["gone"])
		expect(plan.fetch).toEqual([])
	})

	it("stringifies the bigint edit stamp so ledger comparisons are boring", () => {
		expect(noteEditedStamp(note("a", 1750000000000))).toBe("1750000000000")
	})
})

describe("isNoteScreenOpen", () => {
	it("is false on the default route", () => {
		expect(isNoteScreenOpen("a")).toBe(false)
	})

	it("is true while the note's own detail route is showing", () => {
		useAppStore.getState().setPathname("/note/a")

		expect(isNoteScreenOpen("a")).toBe(true)
	})

	it("is false for a different note's detail route", () => {
		useAppStore.getState().setPathname("/note/b")

		expect(isNoteScreenOpen("a")).toBe(false)
	})
})

describe("mark", () => {
	it("fetches the body, caches it and records the stamp", async () => {
		const notesOffline = new NotesOffline()

		getContentMock.mockResolvedValue("hello")

		await notesOffline.mark({ note: note("a", 10) })

		expect(contentCache.get("a")).toBe("hello")
		expect(kvStore.get("notesOffline:marked:a")).toEqual({ editedTimestamp: "10" })
		expect(useNotesOfflineStore.getState().marked["a"]).toBe(true)
	})

	it("leaves no ledger row behind when the body could not be fetched", async () => {
		const notesOffline = new NotesOffline()

		getContentMock.mockRejectedValue(new Error("network"))

		await expect(notesOffline.mark({ note: note("a", 10) })).rejects.toThrow("network")

		expect(kvStore.has("notesOffline:marked:a")).toBe(false)
		expect(useNotesOfflineStore.getState().marked["a"]).toBeUndefined()
	})

	// The menu entry is already requiresOnline-gated, but a native menu snapshots its actions at
	// presentation time — so this message is genuinely reachable and must be a translation key, not
	// raw English: the menu hands it straight to alerts.error, which renders an Error's message
	// verbatim.
	it("refuses while offline with a localized message rather than promising a body it cannot fetch", async () => {
		const notesOffline = new NotesOffline()

		onlineManager.setOnline(false)

		await expect(notesOffline.mark({ note: note("a", 10) })).rejects.toThrow("note_offline_requires_connection")
		expect(getContentMock).not.toHaveBeenCalled()
		expect(kvStore.has("notesOffline:marked:a")).toBe(false)
	})

	// Marking from inside the editor must not swap the text under the user. The mark still lands,
	// but with a null stamp so the next pass fetches once they have left.
	it("does not replace a differing body while the note is on screen", async () => {
		const notesOffline = new NotesOffline()

		seedCachedBody("a", "what the editor is showing")
		useAppStore.getState().setPathname("/note/a")
		getContentMock.mockResolvedValue("newer remote text")

		await notesOffline.mark({ note: note("a", 10) })

		expect(contentCache.get("a")).toBe("what the editor is showing")
		expect(kvStore.get("notesOffline:marked:a")).toEqual({ editedTimestamp: null })
	})

	// Identical content is not a change — writing it anyway would bump dataUpdatedAt and remount the
	// editor for nothing, so the ledger advances without a write.
	it("records the stamp without writing when the on-screen note's body already matches", async () => {
		const notesOffline = new NotesOffline()

		seedCachedBody("a", "same")
		useAppStore.getState().setPathname("/note/a")
		getContentMock.mockResolvedValue("same")

		await notesOffline.mark({ note: note("a", 10) })

		expect(kvStore.get("notesOffline:marked:a")).toEqual({ editedTimestamp: "10" })
	})
})

describe("unmark", () => {
	it("drops the ledger row and reclaims the cached body", async () => {
		const notesOffline = new NotesOffline()

		getContentMock.mockResolvedValue("body")

		await notesOffline.mark({ note: note("a", 10) })
		await notesOffline.unmark({ uuid: "a" })

		expect(kvStore.has("notesOffline:marked:a")).toBe(false)
		expect(contentCache.has("a")).toBe(false)
		expect(useNotesOfflineStore.getState().marked["a"]).toBeUndefined()
	})

	// Evicting under an unsynced edit would strand components/sync's post-push write with no
	// dataUpdatedAt to preserve, and its fresh-timestamp fallback would remount the editor mid-edit.
	it("defers the eviction while the note carries unsynced edits", async () => {
		const notesOffline = new NotesOffline()

		getContentMock.mockResolvedValue("body")

		await notesOffline.mark({ note: note("a", 10) })

		setInflight("a", "draft")

		await notesOffline.unmark({ uuid: "a" })

		expect(kvStore.has("notesOffline:marked:a")).toBe(false)
		expect(contentCache.get("a")).toBe("body")
		expect(kvStore.get("notesOffline:evict:a")).toBe(true)
	})

	it("defers the eviction while the note is on screen", async () => {
		const notesOffline = new NotesOffline()

		getContentMock.mockResolvedValue("body")

		await notesOffline.mark({ note: note("a", 10) })

		useAppStore.getState().setPathname("/note/a")

		await notesOffline.unmark({ uuid: "a" })

		expect(contentCache.get("a")).toBe("body")
		expect(kvStore.get("notesOffline:evict:a")).toBe(true)
	})

	it("drains a deferred eviction on the next pass once nothing depends on the body", async () => {
		const notesOffline = new NotesOffline()

		getContentMock.mockResolvedValue("body")

		await notesOffline.mark({ note: note("a", 10) })

		useAppStore.getState().setPathname("/note/a")

		await notesOffline.unmark({ uuid: "a" })

		useAppStore.getState().setPathname("/")

		await notesOffline.sync()

		expect(contentCache.has("a")).toBe(false)
		expect(kvStore.has("notesOffline:evict:a")).toBe(false)
	})

	it("cancels a pending eviction when the note is marked again", async () => {
		const notesOffline = new NotesOffline()

		getContentMock.mockResolvedValue("body")

		await notesOffline.mark({ note: note("a", 10) })

		useAppStore.getState().setPathname("/note/a")

		await notesOffline.unmark({ uuid: "a" })

		await notesOffline.mark({ note: note("a", 10) })

		expect(kvStore.has("notesOffline:evict:a")).toBe(false)
		expect(contentCache.get("a")).toBe("body")
	})
})

describe("sync", () => {
	it("populates the badge projection even while offline", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		onlineManager.setOnline(false)

		const notesOffline = new NotesOffline()

		await notesOffline.sync()

		expect(useNotesOfflineStore.getState().marked["a"]).toBe(true)
		expect(notesFetchMock).not.toHaveBeenCalled()
	})

	it("refreshes a marked body whose note was edited elsewhere", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		seedCachedBody("a", "old")
		notesFetchMock.mockResolvedValue([note("a", 20)])
		getContentMock.mockResolvedValue("new")

		const notesOffline = new NotesOffline()

		await notesOffline.sync()

		expect(contentCache.get("a")).toBe("new")
		expect(kvStore.get("notesOffline:marked:a")).toEqual({ editedTimestamp: "20" })
	})

	it("prunes and reclaims a marked note the account no longer has", async () => {
		kvStore.set("notesOffline:marked:gone", { editedTimestamp: "10" })
		seedCachedBody("gone", "body")
		notesFetchMock.mockResolvedValue([])

		const notesOffline = new NotesOffline()

		await notesOffline.sync()

		expect(kvStore.has("notesOffline:marked:gone")).toBe(false)
		expect(contentCache.has("gone")).toBe(false)
	})

	it("does not reach the network when nothing is marked", async () => {
		const notesOffline = new NotesOffline()

		await notesOffline.sync()

		expect(notesFetchMock).not.toHaveBeenCalled()
	})

	// The ledger must not advance past a body that failed to land, or the note would be considered
	// current forever and never retried.
	it("leaves the ledger un-advanced when a body fetch fails", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		notesFetchMock.mockResolvedValue([note("a", 20)])
		getContentMock.mockRejectedValue(new Error("boom"))

		const notesOffline = new NotesOffline()

		await notesOffline.sync()

		expect(kvStore.get("notesOffline:marked:a")).toEqual({ editedTimestamp: "10" })
		expect(loggerMock.warn).toHaveBeenCalled()
	})

	it("never rejects, so a background run is not failed by a transient list error", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		notesFetchMock.mockRejectedValue(new Error("offline mid-pass"))

		const notesOffline = new NotesOffline()

		await expect(notesOffline.sync({ background: true })).resolves.toBeUndefined()
		expect(loggerMock.error).toHaveBeenCalled()
	})

	// Deliberately NOT flushing here. The background task already defers an awaited flush that runs
	// after this phase on every exit path, and flushNow writes through executeBatch — bypassing
	// sqlite's clearGeneration guard — so an un-gated flush unwinding across a logout would
	// re-insert the previous account's decrypted bodies after the wipe.
	it("never flushes the persister itself, in either mode", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		notesFetchMock.mockResolvedValue([note("a", 20)])
		getContentMock.mockResolvedValue("new")

		const notesOffline = new NotesOffline()

		await notesOffline.sync({ background: true })
		await notesOffline.sync()

		expect(flushNowMock).not.toHaveBeenCalled()
	})

	it("skips a note the user started editing after the plan was built", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		notesFetchMock.mockResolvedValue([note("a", 20)])

		getContentMock.mockImplementation(async () => {
			setInflight("a", "typed while the pass was in flight")

			return "remote"
		})

		const notesOffline = new NotesOffline()

		await notesOffline.sync()

		expect(contentCache.has("a")).toBe(false)
		expect(kvStore.get("notesOffline:marked:a")).toEqual({ editedTimestamp: "10" })
	})
})

describe("refreshAfterRemoteEdit", () => {
	it("replaces a stale body we hold for a note that is not on screen", async () => {
		seedCachedBody("a", "stale")
		getContentMock.mockResolvedValue("fresh")

		const notesOffline = new NotesOffline()

		await notesOffline.refreshAfterRemoteEdit({ note: note("a", 20) })

		expect(contentCache.get("a")).toBe("fresh")
	})

	// The reload prompt exists precisely so the user decides when their editor is replaced.
	it("leaves the note the user is currently in entirely alone", async () => {
		seedCachedBody("a", "what the editor is showing")
		useAppStore.getState().setPathname("/note/a")

		const notesOffline = new NotesOffline()

		await notesOffline.refreshAfterRemoteEdit({ note: note("a", 20) })

		expect(getContentMock).not.toHaveBeenCalled()
		expect(contentCache.get("a")).toBe("what the editor is showing")
	})

	it("leaves a note with unsynced edits alone", async () => {
		seedCachedBody("a", "stale")
		setInflight("a", "draft")

		const notesOffline = new NotesOffline()

		await notesOffline.refreshAfterRemoteEdit({ note: note("a", 20) })

		expect(getContentMock).not.toHaveBeenCalled()
	})

	// Holding no copy means there is nothing wrong to correct — fetching here would cache a note the
	// user never asked to keep.
	it("does not start caching a note we hold no body for and that is not marked", async () => {
		const notesOffline = new NotesOffline()

		await notesOffline.refreshAfterRemoteEdit({ note: note("a", 20) })

		expect(getContentMock).not.toHaveBeenCalled()
		expect(contentCache.has("a")).toBe(false)
	})

	it("fetches for a marked note even when its body is missing", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		getContentMock.mockResolvedValue("fresh")

		const notesOffline = new NotesOffline()

		await notesOffline.refreshAfterRemoteEdit({ note: note("a", 20) })

		expect(contentCache.get("a")).toBe("fresh")
		expect(kvStore.get("notesOffline:marked:a")).toEqual({ editedTimestamp: "20" })
	})

	// Offline, the ledger keeps its pre-edit stamp so the reconnect pass re-fetches.
	it("leaves the ledger stale while offline so the next pass retries", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		seedCachedBody("a", "stale")
		onlineManager.setOnline(false)

		const notesOffline = new NotesOffline()

		await notesOffline.refreshAfterRemoteEdit({ note: note("a", 20) })

		expect(getContentMock).not.toHaveBeenCalled()
		expect(kvStore.get("notesOffline:marked:a")).toEqual({ editedTimestamp: "10" })
	})
})

// The single most dangerous coalescing in this feature. getNoteContent resolves `undefined` when the
// note HAS content that could not be decrypted (empty notes resolve ""), and such a note is NOT
// flagged undecryptable, so it renders normally. Caching "" for it would seed an EDITABLE EMPTY
// editor — isNoteContentUnavailable accepts "" as a real body — and the first keystroke would push
// blank over the real note with no conflict toast, because components/sync's overwrite peek coalesces
// the cloud side the same way and both hashes would be hash("").
describe("undecryptable bodies are never cached as empty", () => {
	it("fails the mark instead of badging a note whose offline copy would be blank", async () => {
		const notesOffline = new NotesOffline()

		getContentMock.mockResolvedValue(undefined)

		await expect(notesOffline.mark({ note: note("a", 10) })).rejects.toThrow("note_offline_content_undecryptable")

		expect(contentCache.has("a")).toBe(false)
		expect(kvStore.has("notesOffline:marked:a")).toBe(false)
	})

	it("caches nothing and leaves the ledger un-advanced during a pass", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		notesFetchMock.mockResolvedValue([note("a", 20)])
		getContentMock.mockResolvedValue(undefined)

		const notesOffline = new NotesOffline()

		await notesOffline.sync()

		expect(contentCache.has("a")).toBe(false)
		expect(kvStore.get("notesOffline:marked:a")).toEqual({ editedTimestamp: "10" })
	})

	it("keeps the existing copy when a remote-edit refresh cannot decrypt", async () => {
		seedCachedBody("a", "readable old body")
		getContentMock.mockResolvedValue(undefined)

		const notesOffline = new NotesOffline()

		await notesOffline.refreshAfterRemoteEdit({ note: note("a", 20) })

		expect(contentCache.get("a")).toBe("readable old body")
	})

	// An empty note is a real, cacheable body — the guard must not swallow it.
	it("still caches a genuinely empty note", async () => {
		const notesOffline = new NotesOffline()

		getContentMock.mockResolvedValue("")

		await notesOffline.mark({ note: note("a", 10) })

		expect(contentCache.get("a")).toBe("")
		expect(kvStore.get("notesOffline:marked:a")).toEqual({ editedTimestamp: "10" })
	})
})

describe("open content views", () => {
	// The route pathname cannot answer "is an editor mounted": pushing /noteHistory or
	// /noteParticipants from the note's own header freezes the editor rather than unmounting it, so a
	// pathname test reports it closed while the user is one back-swipe from their cursor.
	it("counts a mounted content view as open even when the route moved on", async () => {
		useNotesOfflineStore.getState().openContentView("a")
		useAppStore.getState().setPathname("/noteHistory")

		expect(isNoteScreenOpen("a")).toBe(true)

		seedCachedBody("a", "what the editor is showing")
		getContentMock.mockResolvedValue("newer remote text")

		const notesOffline = new NotesOffline()

		await notesOffline.refreshAfterRemoteEdit({ note: note("a", 20) })

		expect(contentCache.get("a")).toBe("what the editor is showing")
	})

	it("reference-counts, so a note's history view closing does not unmask the editor beneath it", () => {
		useNotesOfflineStore.getState().openContentView("a")
		useNotesOfflineStore.getState().openContentView("a")
		useNotesOfflineStore.getState().closeContentView("a")

		expect(isNoteScreenOpen("a")).toBe(true)

		useNotesOfflineStore.getState().closeContentView("a")

		expect(isNoteScreenOpen("a")).toBe(false)
	})
})

describe("concurrent writers", () => {
	// The pass decided to fetch this note before the user un-marked it. Committing on the far side of
	// the round trip would resurrect the row, the badge and the body the user asked to reclaim.
	it("does not resurrect a note un-marked while its body was in flight", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		notesFetchMock.mockResolvedValue([note("a", 20)])

		const notesOffline = new NotesOffline()

		getContentMock.mockImplementation(async () => {
			await notesOffline.unmark({ uuid: "a" })

			return "remote body"
		})

		await notesOffline.sync()

		expect(kvStore.has("notesOffline:marked:a")).toBe(false)
		expect(contentCache.has("a")).toBe(false)
		expect(useNotesOfflineStore.getState().marked["a"]).toBeUndefined()
	})

	// components/sync landing the user's own push mid-fetch. Our copy predates it, so writing it back
	// would serve a body missing their last edit — and seed the next editing session from it.
	//
	// The push is replayed EXACTLY as components/sync performs it: `dataUpdatedAt` preserved, so the
	// stamp does not move. A guard that compared timestamps would be blind to this — and every marked
	// note has a cached body, hence a real stamp, so it would be blind for the entire population the
	// feature serves. The guard compares body identity for that reason.
	it("does not overwrite a body the user's own push landed while the fetch was in flight", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		seedCachedBody("a", "pre-edit body")
		notesFetchMock.mockResolvedValue([note("a", 20)])

		const stampBeforePush = contentStamps.get("a")

		getContentMock.mockImplementation(async () => {
			pushLikeNotesSync("a", "what the user just typed")

			return "stale remote body"
		})

		const notesOffline = new NotesOffline()

		await notesOffline.sync()

		expect(contentStamps.get("a")).toBe(stampBeforePush)
		expect(contentCache.get("a")).toBe("what the user just typed")
		expect(kvStore.get("notesOffline:marked:a")).toEqual({ editedTimestamp: "10" })
	})

	it("protects a stamp-preserving push from the socket-driven refresh too", async () => {
		seedCachedBody("a", "pre-edit body")

		getContentMock.mockImplementation(async () => {
			pushLikeNotesSync("a", "what the user just typed")

			return "stale remote body"
		})

		const notesOffline = new NotesOffline()

		await notesOffline.refreshAfterRemoteEdit({ note: note("a", 20) })

		expect(contentCache.get("a")).toBe("what the user just typed")
	})
})

describe("pass coalescing", () => {
	// Uses background passes throughout so the min-interval floor cannot satisfy the assertion on the
	// join's behalf — with a plain sync() this passed even with the join deleted entirely.
	it("joins an in-flight pass instead of running a second listNotes", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		notesFetchMock.mockResolvedValue([note("a", 10)])

		const notesOffline = new NotesOffline()

		await Promise.all([
			notesOffline.sync({ background: true }),
			notesOffline.sync({ background: true }),
			notesOffline.sync({ background: true })
		])

		expect(notesFetchMock).toHaveBeenCalledTimes(1)
	})

	it("hands concurrent callers the same promise", () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		notesFetchMock.mockResolvedValue([note("a", 10)])

		const notesOffline = new NotesOffline()
		const first = notesOffline.sync()

		expect(notesOffline.sync()).toBe(first)
	})

	// A background run joining a foreground pass would inherit that pass's floor, return having
	// fetched nothing, and the task would still record the phase as a success — a silent no-op that
	// reports as healthy, which is what blinds field diagnosis of "background refresh never runs".
	it("does not let a background run inherit a foreground pass's floor", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		notesFetchMock.mockResolvedValue([note("a", 10)])

		const notesOffline = new NotesOffline()
		const foreground = notesOffline.sync()
		const background = notesOffline.sync({ background: true })

		expect(background).not.toBe(foreground)

		await Promise.all([foreground, background])

		expect(notesFetchMock).toHaveBeenCalledTimes(2)
	})

	// Reconnect is the opposite of a spurious wake — socket events are lost while offline, so it is
	// precisely when a pull is needed.
	it("lets a force caller through the floor", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		notesFetchMock.mockResolvedValue([note("a", 10)])

		const notesOffline = new NotesOffline()

		await notesOffline.sync()
		await notesOffline.sync()

		expect(notesFetchMock).toHaveBeenCalledTimes(1)

		await notesOffline.sync({ force: true })

		expect(notesFetchMock).toHaveBeenCalledTimes(2)
	})

	// Every `inactive -> active` flip reaches sync(): Face ID, the share sheet, an app-switcher peek.
	it("holds an automatic pass off within the min interval, but never a background one", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		notesFetchMock.mockResolvedValue([note("a", 10)])

		const notesOffline = new NotesOffline()

		await notesOffline.sync()
		await notesOffline.sync()

		expect(notesFetchMock).toHaveBeenCalledTimes(1)

		await notesOffline.sync({ background: true })

		expect(notesFetchMock).toHaveBeenCalledTimes(2)
	})
})

// Each of these guards survived a mutation run — deleting it broke no test. They are the ones whose
// failure modes are silent (a body evicted under a live editor, a draft overwritten in a headless
// run, a ledger silently emptied), so documentation alone is not enough.
describe("drain guards", () => {
	async function markThenDeferUnmark(notesOffline: NotesOffline, uuid: string): Promise<void> {
		getContentMock.mockResolvedValue("body")

		await notesOffline.mark({ note: note(uuid, 10) })

		useAppStore.getState().setPathname(`/note/${uuid}`)

		await notesOffline.unmark({ uuid })

		useAppStore.getState().setPathname("/")
	}

	it("does not evict a body under a mounted editor", async () => {
		const notesOffline = new NotesOffline()

		await markThenDeferUnmark(notesOffline, "a")

		useNotesOfflineStore.getState().openContentView("a")

		await notesOffline.sync()

		expect(contentCache.get("a")).toBe("body")
		expect(kvStore.get("notesOffline:evict:a")).toBe(true)
	})

	it("does not evict a body carrying an in-memory draft", async () => {
		const notesOffline = new NotesOffline()

		await markThenDeferUnmark(notesOffline, "a")

		setInflight("a", "draft")

		await notesOffline.sync()

		expect(contentCache.get("a")).toBe("body")
	})

	// The in-memory inflight store is hydrated only by components/sync's host component, which never
	// mounts in a headless run — so a background pass would see no drafts at all and evict a body the
	// foreground deliberately deferred. The persisted row is the only truth available there.
	it("does not evict a body whose draft exists only in the persisted queue", async () => {
		const notesOffline = new NotesOffline()

		await markThenDeferUnmark(notesOffline, "a")

		kvStore.set("inflightNoteContent", { a: [{ timestamp: 1, content: "draft from a previous session" }] })

		await notesOffline.sync({ background: true })

		expect(contentCache.get("a")).toBe("body")
		expect(kvStore.get("notesOffline:evict:a")).toBe(true)
	})

	it("cancels a queued eviction for a note that was re-marked", async () => {
		notesFetchMock.mockResolvedValue([note("a", 10)])

		const notesOffline = new NotesOffline()

		await markThenDeferUnmark(notesOffline, "a")
		await notesOffline.mark({ note: note("a", 10) })
		await notesOffline.sync()

		expect(contentCache.get("a")).toBe("body")
		expect(kvStore.has("notesOffline:evict:a")).toBe(false)
	})
})

describe("ledger load resilience", () => {
	// This ledger is user INTENT, not a rebuildable shield — a transient SQLITE_BUSY must not silently
	// un-mark every note the user ever marked.
	it("keeps rows on disk when the scan fails, and recovers on the next pass", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		notesFetchMock.mockResolvedValue([note("a", 10)])

		let failNextScan = true

		scanHook.mockImplementation(() => {
			if (failNextScan) {
				failNextScan = false

				throw new Error("SQLITE_BUSY")
			}
		})

		const notesOffline = new NotesOffline()

		await notesOffline.sync()

		expect(kvStore.has("notesOffline:marked:a")).toBe(true)
		expect(useNotesOfflineStore.getState().marked["a"]).toBeUndefined()

		await notesOffline.sync({ force: true })

		expect(useNotesOfflineStore.getState().marked["a"]).toBe(true)
	})

	it("drops only the corrupt row, never its neighbours", async () => {
		kvStore.set("notesOffline:marked:good", { editedTimestamp: "10" })
		kvStore.set("notesOffline:marked:corrupt", CORRUPT_ROW)

		const notesOffline = new NotesOffline()

		await notesOffline.load()

		expect(useNotesOfflineStore.getState().marked["good"]).toBe(true)
		expect(useNotesOfflineStore.getState().marked["corrupt"]).toBeUndefined()
	})
})

describe("plan exclusions", () => {
	it("skips a note on screen that already has a body, so no pass re-downloads it", () => {
		const plan = planNoteOfflineSync({
			marked: new Map([["a", { editedTimestamp: null }]]),
			notes: [note("a", 10)],
			inflightUuids: new Set(),
			cachedUuids: new Set(["a"]),
			openUuids: new Set(["a"])
		})

		expect(plan.fetch).toEqual([])
	})

	it("still fetches a note on screen that has NO body — there is nothing to disturb", () => {
		const plan = planNoteOfflineSync({
			marked: new Map([["a", { editedTimestamp: null }]]),
			notes: [note("a", 10)],
			inflightUuids: new Set(),
			cachedUuids: new Set(),
			openUuids: new Set(["a"])
		})

		expect(plan.fetch).toEqual(["a"])
	})

	// getNoteContent can only ever return undefined for these, so fetching one is a guaranteed failed
	// round trip plus a persisted warning, on every pass, forever.
	it("skips a note whose key we do not have", () => {
		const plan = planNoteOfflineSync({
			marked: new Map([["a", { editedTimestamp: null }]]),
			notes: [{ ...note("a", 10), undecryptable: true }],
			inflightUuids: new Set(),
			cachedUuids: new Set(),
			openUuids: new Set()
		})

		expect(plan.fetch).toEqual([])
		expect(plan.prune).toEqual([])
	})
})

describe("un-mark during a refresh", () => {
	// The sync-path twin is covered above; this path had the identical failure mode — a body written
	// back with no ledger row to account for it, which nothing ever reclaims.
	it("does not write a body back for a note un-marked mid-refresh", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })

		const notesOffline = new NotesOffline()

		getContentMock.mockImplementation(async () => {
			await notesOffline.unmark({ uuid: "a" })

			return "remote body"
		})

		await notesOffline.refreshAfterRemoteEdit({ note: note("a", 20) })

		expect(contentCache.has("a")).toBe(false)
		expect(kvStore.has("notesOffline:marked:a")).toBe(false)
	})

	// A collaborator's editor pushes on a 3s debounce, so co-editing a shared note emits a steady
	// stream of ContentEdited events. Without collapsing, each one is a full body download.
	it("collapses a burst of remote edits for the same note into one fetch", async () => {
		seedCachedBody("a", "old")

		// Deferred created up front so the resolver exists before the first refresh is even started —
		// resolving from inside the mock raced the fetch actually beginning.
		let resolveFetch: (value: string) => void = () => undefined
		const inFlightFetch = new Promise<string>(resolve => {
			resolveFetch = resolve
		})

		getContentMock.mockImplementation(async () => await inFlightFetch)

		const notesOffline = new NotesOffline()
		const first = notesOffline.refreshAfterRemoteEdit({ note: note("a", 20) })

		await notesOffline.refreshAfterRemoteEdit({ note: note("a", 21) })
		await notesOffline.refreshAfterRemoteEdit({ note: note("a", 22) })

		resolveFetch("fresh")

		await first

		expect(getContentMock).toHaveBeenCalledTimes(1)
		expect(contentCache.get("a")).toBe("fresh")
	})
})

// Each of these guards survived a mutation run against the suite as it stood — deleting the guard
// broke no test. They are the ones whose failure is silent: a user's mark undone, a decrypted body
// left unreclaimable, a draft re-based, or the pass's rate limit quietly never arming.
describe("guards that were unpinned", () => {
	// A note marked DURING the listNotes round trip is absent from that response, so without the
	// snapshot the prune reads it as "gone from the account" and deletes the mark the user just made.
	it("does not prune a note marked while the list request was in flight", async () => {
		kvStore.set("notesOffline:marked:existing", { editedTimestamp: "10" })
		seedCachedBody("existing", "body")

		const notesOffline = new NotesOffline()

		notesFetchMock.mockImplementation(async () => {
			await notesOffline.mark({ note: note("late", 10) })

			return [note("existing", 10)]
		})
		getContentMock.mockResolvedValue("late body")

		await notesOffline.sync()

		expect(kvStore.get("notesOffline:marked:late")).toEqual({ editedTimestamp: "10" })
		expect(contentCache.get("late")).toBe("late body")
	})

	// Steady state IS "nothing to fetch", so a floor that only arms on the fetching path never arms
	// in practice and every app-switcher flip pays a full listNotes.
	it("arms the min-interval floor even when the pass had nothing to fetch", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		seedCachedBody("a", "current")
		notesFetchMock.mockResolvedValue([note("a", 10)])

		const notesOffline = new NotesOffline()

		await notesOffline.sync()
		await notesOffline.sync()

		expect(notesFetchMock).toHaveBeenCalledTimes(1)
	})

	// mark() has no pre-fetch inflight check of its own, so commitContent's is the only thing standing
	// between a marked note and a body written under the user's unsynced draft.
	it("marking a note that carries a draft leaves the cached body alone", async () => {
		seedCachedBody("a", "what the draft was based on")
		setInflight("a", "unsynced draft")
		getContentMock.mockResolvedValue("remote body")

		const notesOffline = new NotesOffline()

		await notesOffline.mark({ note: note("a", 10) })

		expect(contentCache.get("a")).toBe("what the draft was based on")
		expect(kvStore.get("notesOffline:marked:a")).toEqual({ editedTimestamp: null })
	})

	// Latching mid-flight is the case the latch exists for; entry-point checks alone do not cover it.
	it("writes nothing when logout latches during a mark's fetch", async () => {
		const notesOffline = new NotesOffline()

		getContentMock.mockImplementation(async () => {
			notesOffline.clearForLogout()

			return "body"
		})

		await notesOffline.mark({ note: note("a", 10) })

		expect(contentCache.has("a")).toBe(false)
		expect(kvStore.has("notesOffline:marked:a")).toBe(false)
	})

	it("does not repopulate the projection from a load after the latch", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })

		const notesOffline = new NotesOffline()

		notesOffline.clearForLogout()

		await notesOffline.load()

		expect(useNotesOfflineStore.getState().marked).toEqual({})
	})

	// The ledger row is a direct write while the body is debounced, so a mark that does not flush can
	// leave a badge promising a body that never reached disk.
	it("forces a committed mark's body to disk", async () => {
		getContentMock.mockResolvedValue("body")

		const notesOffline = new NotesOffline()

		await notesOffline.mark({ note: note("a", 10) })

		expect(flushNowMock).toHaveBeenCalled()
	})

	// Mirror reason: the eviction is buffered, the ledger delete is immediate, so the flush is what
	// makes the on-disk order match the intended one.
	it("forces an immediate un-mark's eviction to disk before dropping the ledger row", async () => {
		getContentMock.mockResolvedValue("body")

		const notesOffline = new NotesOffline()

		await notesOffline.mark({ note: note("a", 10) })

		flushNowMock.mockClear()

		await notesOffline.unmark({ uuid: "a" })

		expect(flushNowMock).toHaveBeenCalled()
		expect(contentCache.has("a")).toBe(false)
	})

	// Better to leave a note marked and retryable than un-marked with a body nothing owns.
	it("keeps the note marked when a deferred eviction cannot be queued", async () => {
		getContentMock.mockResolvedValue("body")

		const notesOffline = new NotesOffline()

		await notesOffline.mark({ note: note("a", 10) })

		// Deferred branch, and the queue write fails.
		useAppStore.getState().setPathname("/note/a")
		kvSetShouldFail.value = true

		await expect(notesOffline.unmark({ uuid: "a" })).rejects.toThrow("note_offline_remove_failed")

		kvSetShouldFail.value = false

		expect(kvStore.has("notesOffline:marked:a")).toBe(true)
	})

	// forget() is the socket-delete path: the note is gone from the account, the caller already
	// reclaimed the body, and there is nothing to defer or surface.
	it("forget drops the ledger row without touching the body", async () => {
		kvStore.set("notesOffline:marked:a", { editedTimestamp: "10" })
		seedCachedBody("a", "body")

		const notesOffline = new NotesOffline()

		await notesOffline.forget({ uuid: "a" })

		expect(kvStore.has("notesOffline:marked:a")).toBe(false)
		expect(useNotesOfflineStore.getState().marked["a"]).toBeUndefined()
		expect(contentCache.get("a")).toBe("body")
	})
})

describe("clearForLogout", () => {
	it("empties memory and the badge projection, and refuses later writes", async () => {
		const notesOffline = new NotesOffline()

		getContentMock.mockResolvedValue("body")

		await notesOffline.mark({ note: note("a", 10) })

		notesOffline.clearForLogout()

		// Only what happens AFTER the latch is under test; the setup mark() above legitimately fetched.
		vi.clearAllMocks()
		contentCache.clear()
		contentStamps.clear()

		expect(useNotesOfflineStore.getState().marked).toEqual({})

		// A pass still unwinding after the wipe must not re-insert into the next account's ledger.
		// The latch has to survive the load() that every entry point starts with — otherwise it is
		// cleared by the very next caller and is not a latch at all.
		kvStore.set("notesOffline:marked:previous-account", { editedTimestamp: "10" })

		await notesOffline.sync()
		await notesOffline.refreshAfterRemoteEdit({ note: note("previous-account", 20) })

		expect(useNotesOfflineStore.getState().marked).toEqual({})
		expect(contentCache.size).toBe(0)

		kvStore.clear()

		await expect(notesOffline.mark({ note: note("zombie", 10) })).resolves.toEqual({ committed: false })

		// Asserted AFTER the zombie mark, not before it: with the check placed earlier this passed even
		// with mark()'s latch removed, because the setup mark() was the only call it ever saw.
		expect(getContentMock).not.toHaveBeenCalled()
		expect(kvStore.size).toBe(0)
	})
})
