import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, onlineManager } from "@tanstack/react-query"
import { type } from "arktype"
import type { Note } from "@filen/sdk-rs"

// The real sdk client imports a Vite `?worker`, unresolvable under node vitest — mock it to the two
// note ops the outbox calls (setNoteContent push + getNoteContent conflict peek / reconcile).
const { setNoteContent, getNoteContent, listNotes } = vi.hoisted(() => ({
	setNoteContent: vi.fn<(note: Note, content: string, preview: string) => Promise<Note>>(),
	getNoteContent: vi.fn<(note: Note) => Promise<string | undefined>>(),
	listNotes: vi.fn<() => Promise<Note[]>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { setNoteContent, getNoteContent, listNotes } }))

// Durable outbox backend — a plain Map standing in for the kv adapter, same boundary preferences.test
// uses. The envelope+schema contract is covered by adapter.test / the schema test below; here we only
// need get/set/delete mechanics, and to spy that the immediate-persist fires.
const { kvStore, kvGetJson, kvSetJson, kvDelete } = vi.hoisted(() => {
	const store = new Map<string, unknown>()

	return {
		kvStore: store,
		kvGetJson: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
		kvSetJson: vi.fn((key: string, value: unknown) => {
			store.set(key, value)

			return Promise.resolve()
		}),
		kvDelete: vi.fn((key: string) => {
			store.delete(key)

			return Promise.resolve()
		})
	}
})

vi.mock("@/lib/storage/adapter", () => ({ kvGetJson, kvSetJson, kvDelete }))

// A bare QueryClient stands in for the real persisted singleton (which pulls the storage worker) —
// same rationale as contacts.test. The outbox reads/writes the note-content cache and the notes list
// through it, so it must be a genuine client, shared by every importer via this one mocked object.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))

vi.mock("sonner", () => ({ toast }))

vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }))

import { queryClient as testQueryClient } from "@/queries/client"
import { Sync } from "@/features/notes/lib/sync"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import useNotesInflightStore, { hasInflight, type InflightContent } from "@/features/notes/store/useNotesInflight"
import {
	buildInflightEntries,
	mergeInflight,
	hashNoteContent,
	inflightContentSchema,
	noteKindForPreview
} from "@/features/notes/lib/sync.logic"
import { deriveSessionBaseHash } from "@/features/notes/hooks/useNoteEditor.logic"

function makeNote(uuid: string, overrides: Partial<Note> = {}): Note {
	const note: Note = {
		uuid: uuid as Note["uuid"],
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		title: `note-${uuid}`,
		...overrides
	}

	return note
}

function sdkError(kind: string): { species: "sdk"; kind: string; label: string; message: string } {
	return { species: "sdk", kind, label: kind, message: kind }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
	let resolve!: (v: T) => void
	let reject!: (e: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})

	return { promise, resolve, reject }
}

function setStore(content: InflightContent): void {
	useNotesInflightStore.setState({ inflightContent: content })
}

function getStore(): InflightContent {
	return useNotesInflightStore.getState().inflightContent
}

async function flushAsync(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 15))
}

// Build + start a fresh Sync whose init has settled (empty disk unless a test pre-seeds kvStore).
async function startedSync(): Promise<Sync> {
	const s = new Sync()
	s.start()
	// restoreFromDisk (empty disk here) resolves initPromise; let the microtask chain land.
	await flushAsync()

	return s
}

beforeEach(() => {
	kvStore.clear()
	kvGetJson.mockClear()
	kvSetJson.mockClear()
	kvDelete.mockClear()
	setNoteContent.mockReset()
	getNoteContent.mockReset()
	listNotes.mockReset()
	toast.mockClear()
	setStore({})
	testQueryClient.clear()
	onlineManager.setOnline(true)
})

afterEach(() => {
	vi.useRealTimers()
})

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("buildInflightEntries — monotonic timestamps (M1 NTP-backstep guard)", () => {
	const note = makeNote("a")

	it("stamps `now` for a fresh session", () => {
		const entries = buildInflightEntries({ previous: undefined, note, content: "x", now: 1000, sessionBaseHash: null })

		expect(entries).toHaveLength(1)
		expect(entries[0]?.timestamp).toBe(1000)
	})

	it("forces newest+1 when the clock steps backward", () => {
		const previous = [{ timestamp: 5000, content: "old", note }]
		const entries = buildInflightEntries({ previous, note, content: "new", now: 4000, sessionBaseHash: null })

		// now (4000) < newest existing (5000) → monotonic bump to 5001, never the stale 4000.
		expect(entries[0]?.timestamp).toBe(5001)
	})

	it("stamps the session base hash only on a FRESH session, carries it forward after", () => {
		const fresh = buildInflightEntries({ previous: undefined, note, content: "x", now: 1, sessionBaseHash: "base1" })

		expect(fresh[0]?.baseContentHash).toBe("base1")

		const next = buildInflightEntries({ previous: fresh, note, content: "y", now: 2, sessionBaseHash: "IGNORED" })

		// An ongoing session carries the existing base, never re-stamps the seed.
		expect(next[0]?.baseContentHash).toBe("base1")
	})

	it("omits the base hash key entirely for the legacy no-hash grace (exactOptionalPropertyTypes)", () => {
		const [first] = buildInflightEntries({ previous: undefined, note, content: "x", now: 1, sessionBaseHash: null })

		expect(first).toBeDefined()
		expect(first !== undefined && "baseContentHash" in first).toBe(false)
	})
})

describe("mergeInflight — replay-on-launch merge semantics (#41)", () => {
	const note = makeNote("a")

	it("seeds uuids the store does not have yet", () => {
		const merged = mergeInflight({}, { a: [{ timestamp: 10, content: "disk", note }] })

		expect(merged["a"]?.[0]?.content).toBe("disk")
	})

	it("keeps the store side when its local timestamp is at least as fresh", () => {
		const current: InflightContent = { a: [{ timestamp: 20, content: "typed-during-fetch", note }] }
		const merged = mergeInflight(current, { a: [{ timestamp: 10, content: "stale-disk", note }] })

		expect(merged["a"]?.[0]?.content).toBe("typed-during-fetch")
	})

	it("takes the disk side when it carries the newer local timestamp", () => {
		const current: InflightContent = { a: [{ timestamp: 5, content: "stale-store", note }] }
		const merged = mergeInflight(current, { a: [{ timestamp: 30, content: "newer-disk", note }] })

		expect(merged["a"]?.[0]?.content).toBe("newer-disk")
	})
})

describe("inflightContentSchema — corrupt persisted outbox dropped (adaptation A)", () => {
	const note = makeNote("a")

	it("accepts a well-formed record of entry arrays", () => {
		const out = inflightContentSchema({ a: [{ timestamp: 1, content: "x", note }] })

		expect(out instanceof type.errors).toBe(false)
		expect(out).toMatchObject({ a: [{ content: "x" }] })
	})

	it("rejects a corrupt entry (missing content)", () => {
		const out = inflightContentSchema({ a: [{ timestamp: 1, note }] })

		expect(out instanceof type.errors).toBe(true)

		if (out instanceof type.errors) {
			expect(out.summary).toContain("content")
		}
	})

	it("rejects a non-object note snapshot", () => {
		const out = inflightContentSchema({ a: [{ timestamp: 1, content: "x", note: "not-an-object" }] })

		expect(out instanceof type.errors).toBe(true)

		if (out instanceof type.errors) {
			expect(out.summary).toContain("note")
		}
	})
})

describe("noteKindForPreview", () => {
	it("maps checklist/rich to themselves and everything else to other", () => {
		expect(noteKindForPreview("checklist")).toBe("checklist")
		expect(noteKindForPreview("rich")).toBe("rich")
		expect(noteKindForPreview("text")).toBe("other")
		expect(noteKindForPreview("md")).toBe("other")
		expect(noteKindForPreview("code")).toBe("other")
	})
})

// ── Sync class: intake, persistence, push loop ──────────────────────────────

describe("enqueue — immediate-persist BEFORE the debounce (survives-window-close guarantee)", () => {
	it("persists the whole outbox to disk immediately, before the 3s push fires", async () => {
		vi.useFakeTimers()

		const s = new Sync()
		s.start()
		await vi.advanceTimersByTimeAsync(0)

		const note = makeNote("a")
		setNoteContent.mockResolvedValue(note)
		kvSetJson.mockClear()

		await s.enqueue(note, "hello")

		// Disk write already happened; the debounced push has NOT.
		expect(kvSetJson).toHaveBeenCalledWith("inflightNoteContent", expect.any(Object))
		expect(setNoteContent).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(3000)

		expect(setNoteContent).toHaveBeenCalledTimes(1)
	})
})

describe("push loop — prune by LOCAL author-time during the round trip (#4)", () => {
	it("keeps an entry typed mid-push and drops the one it actually sent", async () => {
		const s = await startedSync()
		const note = makeNote("a")

		setStore({ a: [{ timestamp: 100, content: "first", note }] })

		// Simulate the user typing again WHILE the push is in flight.
		setNoteContent.mockImplementation(() => {
			setStore({
				a: [
					{ timestamp: 100, content: "first", note },
					{ timestamp: 200, content: "typed-during-push", note }
				]
			})

			return Promise.resolve(note)
		})

		s.executeNow()
		await flushAsync()

		// The pass started with only t=100, so syncedUpTo = 100 — it sends t=100's content. The prune
		// keeps strictly-newer entries, so the t=200 keystroke typed mid-push survives.
		const remaining = getStore()["a"]

		expect(remaining).toHaveLength(1)
		expect(remaining?.[0]?.content).toBe("typed-during-push")
	})
})

describe("push loop — offline-keep-forever on a network-class rejection (#40/VC3)", () => {
	it("never drops the entry across repeated passes", async () => {
		const s = await startedSync()
		const note = makeNote("a")

		setStore({ a: [{ timestamp: 1, content: "offline-edit", note }] })
		setNoteContent.mockRejectedValue(sdkError("Reqwest"))

		for (let i = 0; i < 4; i++) {
			s.executeNow()
			await flushAsync()
		}

		expect(getStore()["a"]?.[0]?.content).toBe("offline-edit")
	})
})

describe("push loop — bounded drop at 3 non-retryable SDK rejections + reset on success", () => {
	it("keeps for two strikes then drops on the third", async () => {
		const s = await startedSync()
		const note = makeNote("a")

		setStore({ a: [{ timestamp: 1, content: "readonly-edit", note }] })
		setNoteContent.mockRejectedValue(sdkError("Server"))

		s.executeNow()
		await flushAsync()
		expect(hasInflight("a")).toBe(true)

		s.executeNow()
		await flushAsync()
		expect(hasInflight("a")).toBe(true)

		s.executeNow()
		await flushAsync()
		expect(hasInflight("a")).toBe(false)
	})

	it("resets the strike count after a successful push", async () => {
		const s = await startedSync()
		const note = makeNote("a")

		// Two strikes.
		setStore({ a: [{ timestamp: 1, content: "e1", note }] })
		setNoteContent.mockRejectedValue(sdkError("Server"))
		s.executeNow()
		await flushAsync()
		s.executeNow()
		await flushAsync()
		expect(hasInflight("a")).toBe(true)

		// A success drains the note and clears its counter.
		setNoteContent.mockResolvedValue(note)
		s.executeNow()
		await flushAsync()
		expect(hasInflight("a")).toBe(false)

		// A brand-new edit that fails ONCE must NOT drop — the counter restarted from zero.
		setStore({ a: [{ timestamp: 2, content: "e2", note }] })
		setNoteContent.mockRejectedValue(sdkError("Server"))
		s.executeNow()
		await flushAsync()
		expect(hasInflight("a")).toBe(true)
	})
})

describe("push loop — Unauthenticated is keep-for-retry, never counted toward the drop", () => {
	it("survives more than three Unauthenticated rejections", async () => {
		const s = await startedSync()
		const note = makeNote("a")

		setStore({ a: [{ timestamp: 1, content: "reauth-edit", note }] })
		setNoteContent.mockRejectedValue(sdkError("Unauthenticated"))

		for (let i = 0; i < 5; i++) {
			s.executeNow()
			await flushAsync()
		}

		expect(hasInflight("a")).toBe(true)
	})
})

describe("push loop — conflict DETECTION: local wins, one toast per note per pass", () => {
	it("pushes local content and toasts once when the cloud moved past our base", async () => {
		const s = await startedSync()
		const note = makeNote("a", { title: "My Note" })
		const base = hashNoteContent("original")

		setStore({ a: [{ timestamp: 1, content: "my local text", note, baseContentHash: base }] })
		getNoteContent.mockResolvedValue("changed-on-another-device")
		setNoteContent.mockResolvedValue(note)

		s.executeNow()
		await flushAsync()

		// Local wins: the push carries our text, unconditionally.
		expect(setNoteContent).toHaveBeenCalledWith(note, "my local text", expect.any(String))
		// Exactly one overwrite toast.
		expect(toast).toHaveBeenCalledTimes(1)
		expect(toast).toHaveBeenCalledWith("notes:noteOverwroteNewerRemoteChanges")
	})

	it("does not toast when the cloud still matches our session base", async () => {
		const s = await startedSync()
		const note = makeNote("a")
		const base = hashNoteContent("original")

		setStore({ a: [{ timestamp: 1, content: "my edit", note, baseContentHash: base }] })
		getNoteContent.mockResolvedValue("original")
		setNoteContent.mockResolvedValue(note)

		s.executeNow()
		await flushAsync()

		expect(setNoteContent).toHaveBeenCalledTimes(1)
		expect(toast).not.toHaveBeenCalled()
	})
})

describe("push loop — session-base renewal across a full drain (no false overwrite alarm)", () => {
	// Reproduces the editor↔outbox loop the false-alarm bug lived in: an edit, an autosave that FULLY
	// drains the outbox (writing the pushed content back into the cache), then another edit of the same
	// session. The base the editor stamps must track the just-synced content, or the second push mistakes
	// the note's own prior push for a divergent remote edit and cries wolf.
	it("does not toast on the edit that follows an autosave drain of the same session", async () => {
		const s = await startedSync()
		const note = makeNote("a", { title: "My Note" })

		// Mount: seed is the cloud content ("A"), no session yet.
		let base = deriveSessionBaseHash({ seed: "A", hasInflight: false, current: null })

		// Cloud is still "A" when the first push peeks it; the push makes "v1" the cloud content.
		getNoteContent.mockResolvedValue("A")
		setNoteContent.mockResolvedValue(note)

		// Type "v1" and let the autosave drain the outbox fully.
		await s.enqueue(note, "v1", base)
		s.executeNow()
		await flushAsync()

		expect(hasInflight("a")).toBe(false)

		// The drain wrote "v1" back into the content cache — the seed the editor recomputes is byte-equal
		// to what it read mid-session, yet the base MUST renew to hash("v1") on the drain edge.
		const seedAfterDrain = testQueryClient.getQueryData<string>(noteContentQueryKey("a")) ?? ""

		expect(seedAfterDrain).toBe("v1")

		base = deriveSessionBaseHash({ seed: seedAfterDrain, hasInflight: false, current: base })

		// Type "v2". Cloud is now "v1" — our OWN prior push, not a remote edit.
		getNoteContent.mockResolvedValue("v1")
		await s.enqueue(note, "v2", base)
		s.executeNow()
		await flushAsync()

		expect(setNoteContent).toHaveBeenLastCalledWith(note, "v2", expect.any(String))
		// The renewed base equals the cloud content, so no false overwrite alarm fires.
		expect(toast).not.toHaveBeenCalled()
	})

	it("still toasts when a genuine remote edit diverged from the session base", async () => {
		const s = await startedSync()
		const note = makeNote("a", { title: "My Note" })
		const base = deriveSessionBaseHash({ seed: "A", hasInflight: false, current: null })

		// A real concurrent edit on another device moved the cloud past our base.
		getNoteContent.mockResolvedValue("changed-on-another-device")
		setNoteContent.mockResolvedValue(note)

		await s.enqueue(note, "v2", base)
		s.executeNow()
		await flushAsync()

		expect(setNoteContent).toHaveBeenCalledWith(note, "v2", expect.any(String))
		expect(toast).toHaveBeenCalledTimes(1)
		expect(toast).toHaveBeenCalledWith("notes:noteOverwroteNewerRemoteChanges")
	})
})

describe("cancel() — suppresses the disk flush of an in-flight pass", () => {
	it("writes nothing to disk after the pass is aborted", async () => {
		const s = await startedSync()
		const note = makeNote("a")

		setStore({ a: [{ timestamp: 1, content: "edit", note }] })

		const gate = deferred<Note>()
		setNoteContent.mockReturnValue(gate.promise)

		s.executeNow()
		await vi.waitFor(() => {
			expect(setNoteContent).toHaveBeenCalledTimes(1)
		})

		// The push is in flight; clear the persistence spies, cancel, then let the push resolve.
		kvSetJson.mockClear()
		kvDelete.mockClear()
		s.cancel()
		gate.resolve(note)
		await flushAsync()

		expect(kvSetJson).not.toHaveBeenCalled()
		expect(kvDelete).not.toHaveBeenCalled()
	})
})

describe("restoreFromDisk — replay-on-launch hydrates before any network, drops synced/gone (adaptation C)", () => {
	it("hydrates the store from disk and drops an entry whose content equals the cloud", async () => {
		const noteA = makeNote("a")
		const noteB = makeNote("b")

		// Disk holds two pending notes: A's content is already the cloud value (synced), B still differs.
		kvStore.set("inflightNoteContent", {
			a: [{ timestamp: 1, content: "already-synced", note: noteA }],
			b: [{ timestamp: 1, content: "still-pending", note: noteB }]
		})

		listNotes.mockResolvedValue([noteA, noteB])
		getNoteContent.mockImplementation((n: Note) => Promise.resolve(n.uuid === noteA.uuid ? "already-synced" : "cloud-old"))
		setNoteContent.mockResolvedValue(noteB)

		const s = new Sync()
		s.start()
		await flushAsync()

		// A was reconciled away (matched cloud); B survives as genuine pending work and then gets pushed.
		expect(hasInflight("a")).toBe(false)
		await vi.waitFor(() => {
			expect(hasInflight("b")).toBe(false)
		})
		expect(setNoteContent).toHaveBeenCalledWith(noteB, "still-pending", expect.any(String))
	})

	it("drops entries for notes no longer present in the cloud", async () => {
		const gone = makeNote("gone")

		kvStore.set("inflightNoteContent", { gone: [{ timestamp: 1, content: "orphan", note: gone }] })
		listNotes.mockResolvedValue([])

		const s = new Sync()
		s.start()
		await flushAsync()

		expect(hasInflight("gone")).toBe(false)
	})

	it("hydrates unconditionally when offline (no reconcile, entry kept for reconnect)", async () => {
		onlineManager.setOnline(false)

		const note = makeNote("a")
		kvStore.set("inflightNoteContent", { a: [{ timestamp: 1, content: "offline-boot", note }] })

		const s = new Sync()
		s.start()
		await flushAsync()

		expect(hasInflight("a")).toBe(true)
		expect(listNotes).not.toHaveBeenCalled()

		onlineManager.setOnline(true)
	})

	it("writes the pushed content forward into the note-content query cache", async () => {
		const note = makeNote("a")

		setStore({ a: [{ timestamp: 1, content: "pushed-text", note }] })
		setNoteContent.mockResolvedValue(note)

		const s = await startedSync()
		s.executeNow()
		await flushAsync()

		expect(testQueryClient.getQueryData(noteContentQueryKey("a"))).toBe("pushed-text")
	})
})
