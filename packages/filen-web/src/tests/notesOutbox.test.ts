import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, onlineManager } from "@tanstack/react-query"
import type { Note } from "@filen/sdk-rs"
import { mockNote } from "@/tests/fixtures/notes"

// Same worker-free seams as notesSync.test: the sdk client, the kv adapter, the persisted query client,
// and sonner are all mocked so the outbox runs under node vitest. This file exercises the
// leader-owned MULTI-TAB layer: follower routing, leader ingest, reconcile-on-broadcast, and the
// leadership-change replay. The cross-tab CHANNEL + db-lock signal are mocked at the transport seam
// (sync.attachTransport) and by driving role methods directly — no real BroadcastChannel/Web Locks.
const { setNoteContent, getNoteContent, listNotes } = vi.hoisted(() => ({
	setNoteContent: vi.fn<(note: Note, content: string, preview: string) => Promise<Note>>(),
	getNoteContent: vi.fn<(note: Note) => Promise<string | undefined>>(),
	listNotes: vi.fn<() => Promise<Note[]>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { setNoteContent, getNoteContent, listNotes } }))

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
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { toast } = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }))

import { Sync } from "@/features/notes/lib/sync"
import {
	useNotesInflightStore,
	noteIsEditing,
	beginEditingSession,
	endEditingSession,
	type InflightContent
} from "@/features/notes/store/useNotesInflight"
import { hashNoteContent } from "@filen/shared"
import { reconcileFollower, type NoteFailedState, type RemoteEnqueue } from "@/features/notes/lib/sync.logic"
import { isOwnNotePush } from "@/features/notes/lib/pushEchoes"
import type { PushDetail } from "@/lib/storage/outboxChannel"
import { forgetTabEditors, seedTabEditor, takeTabEditorEcho, tabEditorChanged } from "@/features/notes/lib/tabEditors"

function makeNote(uuid: string, overrides: Partial<Note> = {}): Note {
	return mockNote({ uuid: uuid as Note["uuid"], title: `note-${uuid}`, ...overrides })
}

// Inferred return type keeps each field a precisely-typed Mock<Sig> — assignable to NotesOutboxTransport AND
// carrying .mock/.mockClear. An explicit mapped-type annotation collapses them to a bare Mock, which is
// no longer assignable to the method signatures, so it is deliberately left to inference.
function mockTransport() {
	return {
		sendEnqueue: vi.fn<(msg: RemoteEnqueue) => void>(),
		sendExecuteNow: vi.fn<() => void>(),
		requestState: vi.fn<() => void>(),
		broadcastState: vi.fn<(state: InflightContent) => void>(),
		broadcastLeaderHello: vi.fn<() => void>(),
		sendDrop: vi.fn<(id: string) => void>(),
		broadcastPushed: vi.fn<(id: string, hash: string, detail?: PushDetail) => void>(),
		broadcastAnswered: vi.fn<(id: string) => void>(),
		broadcastFailed: vi.fn<(failed: NoteFailedState) => void>(),
		close: vi.fn<() => void>()
	}
}

// Throw-helper (project lint forbids both bare null-strip `as` and `!`): narrow the first forwarded
// enqueue arg without an assertion.
function firstEnqueue(transport: ReturnType<typeof mockTransport>): RemoteEnqueue {
	const msg = transport.sendEnqueue.mock.calls[0]?.[0]

	if (msg === undefined) {
		throw new Error("expected a forwarded enqueue")
	}

	return msg
}

function setStore(content: InflightContent): void {
	useNotesInflightStore.setState({ inflightContent: content })
}

function getStore(): InflightContent {
	return useNotesInflightStore.getState().inflightContent
}

// The QUEUE alone — what the leader drains and the header spinner reads — not the broader
// "is the user editing this note" test (noteIsEditing), which also counts a live editor session.
function queued(uuid: string): boolean {
	return (getStore()[uuid] ?? []).length > 0
}

async function flushAsync(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 15))
}

// Every instance shares the module-level store and sdk mocks, and a leader edit arms a real debounce:
// one left running would fire a pass into a later test. afterEach cancels them all.
const syncs: Sync[] = []

function newSync(): Sync {
	const s = new Sync()

	syncs.push(s)

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
	toast.error.mockClear()
	setStore({})
	useNotesInflightStore.setState({ outboxHydrated: false, failedNotes: {} })
	onlineManager.setOnline(true)
})

afterEach(() => {
	for (const s of syncs.splice(0)) {
		s.cancel()
	}

	vi.useRealTimers()
})

// ── reconcileFollower (pure) ────────────────────────────────────────────────

describe("reconcileFollower — leader-authoritative + optimistic overlay", () => {
	const note = makeNote("a")

	it("keeps an unacked entry the leader has NOT caught up to (it wins the merge)", () => {
		const unacked: InflightContent = { a: [{ timestamp: 200, content: "local-newer", note }] }
		const leaderState: InflightContent = { a: [{ timestamp: 100, content: "leader-older", note }] }

		const { store, unacked: remaining } = reconcileFollower(leaderState, unacked)

		expect(store["a"]?.[0]?.content).toBe("local-newer")
		expect(remaining["a"]).toBeDefined() // still outstanding
	})

	it("confirms (drops from unacked) once the leader's timestamp reaches ours, mirroring the leader", () => {
		const unacked: InflightContent = { a: [{ timestamp: 100, content: "mine", note }] }
		const leaderState: InflightContent = { a: [{ timestamp: 100, content: "mine", note }] }

		const { store, unacked: remaining } = reconcileFollower(leaderState, unacked)

		expect(remaining["a"]).toBeUndefined()
		expect(store["a"]?.[0]?.content).toBe("mine")
	})

	it("drains: a confirmed note absent from a later leader state disappears from the follower", () => {
		// Round 1: leader confirms our entry → unacked cleared.
		const first = reconcileFollower(
			{ a: [{ timestamp: 100, content: "mine", note }] },
			{ a: [{ timestamp: 100, content: "mine", note }] }
		)

		expect(first.unacked["a"]).toBeUndefined()

		// Round 2: leader pushed + drained → its state omits the note → follower store clears it.
		const second = reconcileFollower({}, first.unacked)

		expect(second.store["a"]).toBeUndefined()
	})

	it("keeps an unacked entry the leader has never seen (absent from state — an in-flight/lost forward)", () => {
		const unacked: InflightContent = { a: [{ timestamp: 100, content: "not-yet-received", note }] }

		const { store, unacked: remaining } = reconcileFollower({}, unacked)

		expect(store["a"]?.[0]?.content).toBe("not-yet-received")
		expect(remaining["a"]).toBeDefined()
	})
})

// ── Follower routing ────────────────────────────────────────────────────────

describe("follower enqueue — optimistic local apply + forward, no disk", () => {
	it("applies to the local store AND forwards the newest entry; never persists", async () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		const note = makeNote("a")

		await s.enqueue(note, "typed", hashNoteContent("seed"))

		// Optimistic: the store shows it immediately (UI gating must not wait a round trip).
		expect(queued("a")).toBe(true)
		expect(getStore()["a"]?.[0]?.content).toBe("typed")

		// Forwarded to the leader, carrying the follower's own timestamp + base hash.
		expect(transport.sendEnqueue).toHaveBeenCalledTimes(1)
		const forwarded = firstEnqueue(transport)

		expect(forwarded.content).toBe("typed")
		expect(forwarded.baseContentHash).toBe(hashNoteContent("seed"))
		expect(typeof forwarded.timestamp).toBe("number")

		// A follower owns no disk — the leader's immediate-persist is the durability point.
		expect(kvSetJson).not.toHaveBeenCalled()
	})

	it("marks forwarded edits as an answer to the remote-edit dialog until the note drains, re-sends included", async () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		const note = makeNote("a")

		await s.enqueue(note, "typed", hashNoteContent("seed"))
		await s.enqueueAnswer(note, "theirs", hashNoteContent("theirs"))
		await s.enqueue(note, "theirs, typed on", hashNoteContent("seed"))
		// A new leader: the re-sent edit is still an answer, so it warns of no overwrite of the last push.
		s.resendUnacked()

		expect(transport.sendEnqueue.mock.calls.map(c => c[0].answer)).toEqual([undefined, true, true, true])

		// The leader caught up, then drained the note: the answer went out.
		s.applyLeaderState({ a: getStore()["a"] ?? [] })
		s.applyLeaderState({})
		await s.enqueue(note, "later", hashNoteContent("seed"))

		expect(transport.sendEnqueue.mock.calls.at(-1)?.[0].answer).toBeUndefined()
	})

	it("forwards a flush request on executeNow instead of running a pass", () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()
		s.executeNow()

		expect(transport.sendExecuteNow).toHaveBeenCalledTimes(1)
		expect(setNoteContent).not.toHaveBeenCalled()
	})

	it("requests the leader's current state on start (catch up to another tab's pending note)", () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		expect(transport.requestState).toHaveBeenCalledTimes(1)
	})
})

// The header's "Not saved — retrying" state follows the leader's failed pushes in every tab, and an edit the
// leader gave up on is told in every tab (the leader may be hidden).
describe("failed pushes reach every tab", () => {
	it("the leader tells its failed pushes once they change, and again to a follower asking for state", async () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.start()
		await flushAsync()

		setNoteContent.mockRejectedValue(new Error("fetch failed"))
		setStore({ a: [{ timestamp: 1, content: "typed", note: makeNote("a") }] })
		s.executeNow()
		await flushAsync()

		expect(useNotesInflightStore.getState().failedNotes).toEqual({ a: true })
		expect(transport.broadcastFailed).toHaveBeenLastCalledWith({ failed: ["a"], gaveUp: [], claim: "" })

		transport.broadcastFailed.mockClear()
		s.broadcastState()

		expect(transport.broadcastFailed).toHaveBeenCalledExactlyOnceWith({ failed: ["a"], gaveUp: [], claim: "" })

		setNoteContent.mockResolvedValue(makeNote("a"))
		s.executeNow()
		await flushAsync()

		expect(useNotesInflightStore.getState().failedNotes).toEqual({})
		expect(transport.broadcastFailed).toHaveBeenLastCalledWith({ failed: [], gaveUp: [], claim: "" })
	})

	it("a follower shows the leader's failed pushes and tells of an edit given up on", async () => {
		const s = newSync()

		s.attachTransport(mockTransport())
		s.startAsFollower()
		s.applyLeaderState({ a: [{ timestamp: 1, content: "typed", note: makeNote("a") }] })
		s.applyLeaderFailed({ failed: ["a"], gaveUp: [], claim: "" })

		expect(useNotesInflightStore.getState().failedNotes).toEqual({ a: true })
		expect(toast.error).not.toHaveBeenCalled()

		s.applyLeaderFailed({ failed: [], gaveUp: ["a"], claim: "c1" })

		expect(useNotesInflightStore.getState().failedNotes).toEqual({})
		await vi.waitFor(() => {
			expect(toast.error).toHaveBeenCalledExactlyOnceWith("notes:noteSaveGaveUp")
		})
	})

	describe("the gave-up toast shows in one tab", () => {
		function follower(): Sync {
			const s = newSync()

			s.attachTransport(mockTransport())
			s.startAsFollower()

			return s
		}

		afterEach(() => {
			vi.unstubAllGlobals()
		})

		it("a visible tab claims it, the others find it taken", async () => {
			vi.stubGlobal("document", { visibilityState: "visible" })

			for (const s of [follower(), follower(), follower()]) {
				s.applyLeaderFailed({ failed: [], gaveUp: ["a"], claim: "once" })
			}

			await vi.waitFor(() => {
				expect(toast.error).toHaveBeenCalledOnce()
			})
			await flushAsync()
			expect(toast.error).toHaveBeenCalledOnce()
		})

		it("a hidden follower stays quiet", async () => {
			vi.stubGlobal("document", { visibilityState: "hidden" })
			follower().applyLeaderFailed({ failed: [], gaveUp: ["a"], claim: "quiet" })
			await flushAsync()

			expect(toast.error).not.toHaveBeenCalled()
		})
	})

	it("a follower ignores a malformed payload", () => {
		const s = newSync()

		s.startAsFollower()
		s.applyLeaderFailed({ failed: "a" })

		expect(useNotesInflightStore.getState().failedNotes).toEqual({})
	})
})

// A follower owns no disk: the leader's first broadcast IS its hydration, and until it lands an empty
// inflight view means "not known yet" — an editor seeding there would paint the server's content over
// an edit another tab has queued.
describe("follower hydration gate", () => {
	it("stays closed until the leader's first state broadcast lands", () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		expect(useNotesInflightStore.getState().outboxHydrated).toBe(false)

		const note = makeNote("a")

		s.applyLeaderState({ a: [{ timestamp: 1, content: "another tab's edit", note }] })

		expect(useNotesInflightStore.getState().outboxHydrated).toBe(true)
		expect(queued("a")).toBe(true)
	})

	it("opens immediately when no channel is attached — nothing can ever answer", () => {
		const s = newSync()

		s.startAsFollower()

		expect(useNotesInflightStore.getState().outboxHydrated).toBe(true)
	})
})

describe("follower reconcile-on-broadcast — spinner clears when the leader drains", () => {
	it("drops the note from the store once the leader confirms then drains it", async () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		const note = makeNote("a")

		await s.enqueue(note, "typed", null)
		const forwarded = firstEnqueue(transport)

		// Leader confirms receipt (its state carries our entry).
		s.applyLeaderState({ a: [{ timestamp: forwarded.timestamp, content: "typed", note }] })
		expect(queued("a")).toBe(true)

		// Leader pushed + drained → empty state → the follower's spinner clears.
		s.applyLeaderState({})
		expect(queued("a")).toBe(false)
	})
})

describe("follower re-send on takeover announcement", () => {
	it("re-forwards every still-unacked edit when a new leader says hello", async () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		await s.enqueue(makeNote("a"), "a-edit", null)
		await s.enqueue(makeNote("b"), "b-edit", null)
		transport.sendEnqueue.mockClear()

		// The old leader died before confirming; a new leader announces itself.
		s.resendUnacked()

		expect(transport.sendEnqueue).toHaveBeenCalledTimes(2)
		const contents = transport.sendEnqueue.mock.calls.map(c => c[0].content).sort()

		expect(contents).toEqual(["a-edit", "b-edit"])
	})
})

// ── Leader ingest ───────────────────────────────────────────────────────────

describe("leader ingest — apply forwarded edit, persist, broadcast", () => {
	async function startedLeader(): Promise<{ s: Sync; transport: ReturnType<typeof mockTransport> }> {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.start() // leader replay-on-launch (empty disk) resolves init
		await flushAsync()
		transport.broadcastState.mockClear()

		return { s, transport }
	}

	it("merges a forwarded edit by its timestamp, persists it, then broadcasts the new state", async () => {
		const { s, transport } = await startedLeader()
		const note = makeNote("a")

		setNoteContent.mockResolvedValue(note)

		s.ingestRemoteEnqueue({ note, content: "from-follower", timestamp: 500 })
		await flushAsync()

		// Persisted to disk (the durability point), then broadcast to followers.
		expect(kvStore.get("inflightNoteContent")).toStrictEqual({ a: [{ timestamp: 500, content: "from-follower", note }] })
		expect(transport.broadcastState).toHaveBeenCalled()
		expect(kvSetJson.mock.invocationCallOrder[0]).toBeLessThan(transport.broadcastState.mock.invocationCallOrder[0] ?? 0)
	})

	// A follower's "Load theirs" over a push of the local edits that landed after their save.
	it("a forwarded answer puts their content back over this browser's own push without an overwrite warning", async () => {
		const { s } = await startedLeader()
		const note = makeNote("a")

		setNoteContent.mockResolvedValue(note)
		setStore({ a: [{ timestamp: 1, content: "mine", note }] })
		s.executeNow()
		await flushAsync()

		getNoteContent.mockResolvedValue("mine")
		s.ingestRemoteEnqueue({ note, content: "theirs", timestamp: 500, baseContentHash: hashNoteContent("theirs"), answer: true })
		s.executeNow()
		await flushAsync()

		expect(setNoteContent).toHaveBeenLastCalledWith(note, "theirs", expect.any(String))
		expect(toast).not.toHaveBeenCalled()
	})

	it("last-enqueue-wins per note by timestamp (an older forward loses to the current entry)", async () => {
		const { s } = await startedLeader()
		const note = makeNote("a")

		setStore({ a: [{ timestamp: 1000, content: "newer-local", note }] })

		// A stale forward (older timestamp) must not clobber the newer entry.
		s.ingestRemoteEnqueue({ note, content: "stale-forward", timestamp: 500 })

		expect(getStore()["a"]?.[0]?.content).toBe("newer-local")
	})
})

// ── Leadership-change replay (failover) ─────────────────────────────────────

describe("a follower hears the leader's pushes", () => {
	it("knows a push of an entry it queued for its own, by the entry's origin, and no other", async () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()
		forgetTabEditors()
		seedTabEditor("a", "a:1", "old", "old")
		tabEditorChanged("a", "mine")

		const note = makeNote("a")

		await s.enqueue(note, "mine", hashNoteContent("old"))

		const { origin, timestamp } = firstEnqueue(transport)

		expect(origin).toEqual(expect.any(String))

		// Another tab's entry, pushed; then one persisted by an earlier page load, with no origin.
		s.heardPush("a", hashNoteContent("other"), { origin: "another tab", stamp: timestamp })
		s.heardPush("a", hashNoteContent("restored"), { stamp: 1 })

		expect(takeTabEditorEcho("a", hashNoteContent("other"))).toBe("elsewhere")
		expect(takeTabEditorEcho("a", hashNoteContent("restored"))).toBe("elsewhere")

		s.heardPush("a", hashNoteContent("mine"), { origin: origin ?? "", stamp: timestamp })

		expect(takeTabEditorEcho("a", hashNoteContent("mine"))).toBe("this tab")
		forgetTabEditors()
	})

	// Same-millisecond entries carry the same timestamp: only the origin tells whose was pushed.
	it("two tabs queuing the note in the same millisecond: each knows exactly whether the push was its own", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1000)
		const leader = newSync()
		const leaderTransport = mockTransport()
		const follower = newSync()
		const followerTransport = mockTransport()

		leader.attachTransport(leaderTransport)
		leader.start()
		await flushAsync()
		follower.attachTransport(followerTransport)
		follower.startAsFollower()
		forgetTabEditors()
		seedTabEditor("a", "a:1", "old", "old")
		tabEditorChanged("a", "typed here")

		const note = makeNote("a")

		// The follower queues first, into its own view of the queue (one store stands in for both tabs here).
		await follower.enqueue(note, "follower text", hashNoteContent("old"))

		const forwarded = firstEnqueue(followerTransport)

		setStore({})
		await leader.enqueue(note, "leader text", hashNoteContent("old"))

		expect(getStore()["a"]?.[0]?.timestamp).toBe(forwarded.timestamp)

		// Same stamp: the leader keeps its own entry.
		leader.ingestRemoteEnqueue(forwarded)
		getNoteContent.mockResolvedValue("old")
		setNoteContent.mockResolvedValue(note)
		leader.executeNow()
		await flushAsync()
		now.mockRestore()

		expect(setNoteContent).toHaveBeenCalledExactlyOnceWith(note, "leader text", expect.any(String))

		const [, hash, detail] = leaderTransport.broadcastPushed.mock.calls[0] ?? []
		const origin = detail?.origin

		expect(origin).toBeDefined()
		expect(origin).not.toBe(forwarded.origin)
		// The leader tab's own push, told to its editor.
		expect(takeTabEditorEcho("a", hashNoteContent("leader text"))).toBe("this tab")

		// The follower hears it: not its own, although its entry has the same stamp.
		follower.heardPush("a", hash ?? "", detail ?? {})

		expect(takeTabEditorEcho("a", hashNoteContent("leader text"))).toBe("elsewhere")
		forgetTabEditors()
	})

	it("the overwrite a follower's push made is told in that tab, not the leader's", async () => {
		const leader = newSync()
		const leaderTransport = mockTransport()
		const follower = newSync()
		const followerTransport = mockTransport()

		leader.attachTransport(leaderTransport)
		leader.start()
		await flushAsync()
		follower.attachTransport(followerTransport)
		follower.startAsFollower()

		const note = makeNote("a", { title: "Plan" })

		await follower.enqueue(note, "mine", hashNoteContent("old"))
		leader.ingestRemoteEnqueue(firstEnqueue(followerTransport))
		getNoteContent.mockResolvedValue("newer elsewhere")
		setNoteContent.mockResolvedValue(note)
		leader.executeNow()
		await flushAsync()

		expect(toast).not.toHaveBeenCalled()

		const landed = leaderTransport.broadcastPushed.mock.calls.find(call => call[2]?.landed === true)

		expect(landed?.[2]?.overwrote).toBe(true)

		follower.heardLanded("a", landed?.[1] ?? "", landed?.[2] ?? {})

		expect(toast).toHaveBeenCalledExactlyOnceWith("notes:noteOverwroteNewerRemoteChanges")
		follower.cancel()
		leader.cancel()
	})

	it("a follower's drop reaches the leader, and a follower writes no durable outbox", async () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()
		await s.enqueue(makeNote("a"), "typed", hashNoteContent("old"))
		s.dropEntry("a")

		expect(transport.sendDrop).toHaveBeenCalledExactlyOnceWith("a")
		expect(queued("a")).toBe(false)
		expect(await s.flushToDisk({ a: [{ timestamp: 1, content: "x", note: makeNote("a") }] })).toBe(true)
		expect(kvSetJson).not.toHaveBeenCalled()
		s.cancel()
	})

	// The answer and the push it answers over outlive the leader that knew them.
	it("a promoted follower puts their content back over this browser's last push without an overwrite warning", async () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		const note = makeNote("a")

		s.heardPush("a", hashNoteContent("mine"), {})
		await s.enqueueAnswer(note, "theirs", hashNoteContent("theirs"))
		listNotes.mockResolvedValue([note])
		getNoteContent.mockResolvedValue("mine")
		setNoteContent.mockResolvedValue(note)

		s.promoteToLeader()
		await flushAsync()

		expect(setNoteContent).toHaveBeenCalledWith(note, "theirs", expect.any(String))
		expect(toast).not.toHaveBeenCalled()
	})
})

describe("promoteToLeader — a follower wins the lock and pushes carried-over work", () => {
	it("pushes an optimistic edit the follower held locally even when disk was empty", async () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		const note = makeNote("z")

		// Follower typed Z; it lives in the store optimistically. The dead leader never persisted it.
		await s.enqueue(note, "z-edit", null)
		expect(kvStore.get("inflightNoteContent")).toBeUndefined()

		listNotes.mockResolvedValue([note])
		getNoteContent.mockResolvedValue("") // Z exists on the cloud empty; the local edit still differs
		setNoteContent.mockResolvedValue(note)

		// The leader died → this follower is promoted.
		s.promoteToLeader()
		await flushAsync()

		// Z reaches the server without any user action, and this tab announced its takeover.
		expect(setNoteContent).toHaveBeenCalledWith(note, "z-edit", expect.any(String))
		expect(transport.broadcastLeaderHello).toHaveBeenCalledTimes(1)
	})

	it("records what it pushes and tells the other tabs, before the push goes out", async () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		const note = makeNote("p")

		await s.enqueue(note, "p-edit", null)

		listNotes.mockResolvedValue([note])
		getNoteContent.mockResolvedValue("")
		// The echo can beat the response: by the time the request is made, the push is already known.
		setNoteContent.mockImplementation(() => {
			expect(isOwnNotePush("p", hashNoteContent("p-edit"))).toBe(true)
			expect(transport.broadcastPushed.mock.calls[0]?.slice(0, 2)).toEqual(["p", hashNoteContent("p-edit")])
			expect(typeof transport.broadcastPushed.mock.calls[0]?.[2]?.stamp).toBe("number")

			return Promise.resolve(note)
		})

		s.promoteToLeader()
		await flushAsync()

		expect(setNoteContent).toHaveBeenCalledTimes(1)
	})

	it("merges disk state persisted by the dead leader with the follower's local store, then pushes", async () => {
		const s = newSync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		const onDisk = makeNote("d")
		const local = makeNote("l")

		// The dead leader persisted D to disk; the follower still holds L optimistically.
		kvStore.set("inflightNoteContent", { d: [{ timestamp: 1, content: "disk-edit", note: onDisk }] })
		await s.enqueue(local, "local-edit", null)

		listNotes.mockResolvedValue([onDisk, local])
		getNoteContent.mockResolvedValue("")
		setNoteContent.mockImplementation((n: Note) => Promise.resolve(n))

		s.promoteToLeader()
		await flushAsync()

		const pushed = setNoteContent.mock.calls.map(c => c[0].uuid).sort()

		expect(pushed).toEqual(["d", "l"])
	})
})

describe("terminal shutdown — no cross-tab resurrection after logout", () => {
	it("cancel() closes the cross-tab channel exactly once", async () => {
		const transport = mockTransport()
		const s = newSync()

		s.attachTransport(transport)
		s.start()
		await flushAsync()

		s.cancel()

		expect(transport.close).toHaveBeenCalledTimes(1)
	})

	it("ingestRemoteEnqueue after cancel() neither queues nor persists a peer's forwarded edit", async () => {
		const transport = mockTransport()
		const note = makeNote("a")
		const s = newSync()

		s.attachTransport(transport)
		s.start()
		await flushAsync()

		s.cancel()
		kvSetJson.mockClear()
		kvDelete.mockClear()

		s.ingestRemoteEnqueue({ note, content: "peer edit", timestamp: 1 })
		await flushAsync()

		expect(getStore()).toStrictEqual({})
		expect(kvSetJson).not.toHaveBeenCalled()
		expect(kvDelete).not.toHaveBeenCalled()
	})

	it("broadcastState() after cancel() posts nothing — the role is no longer leader", async () => {
		const transport = mockTransport()
		const s = newSync()

		s.attachTransport(transport)
		s.start()
		await flushAsync()

		s.cancel()
		transport.broadcastState.mockClear()

		s.broadcastState()

		expect(transport.broadcastState).not.toHaveBeenCalled()
	})
})

// The editing session is what "the user is editing this note" actually means. The outbox entry alone
// answers a narrower question and stops being true at every push — see useNoteContentQuery's gate.
describe("editing sessions", () => {
	beforeEach(() => {
		useNotesInflightStore.setState({ inflightContent: {}, editingSessions: {} })
	})

	it("survives the drain that empties the note's outbox entry", () => {
		const note = makeNote("a")

		useNotesInflightStore.setState({ inflightContent: { a: [{ timestamp: 1, content: "x", note }] } })
		beginEditingSession("a")

		expect(noteIsEditing(useNotesInflightStore.getState(), "a")).toBe(true)

		// The push drained the queue; the user is still typing.
		useNotesInflightStore.setState({ inflightContent: {} })

		expect(queued("a")).toBe(false)
		expect(noteIsEditing(useNotesInflightStore.getState(), "a")).toBe(true)
	})

	it("ends on request and leaves other notes alone", () => {
		beginEditingSession("a")
		beginEditingSession("b")
		endEditingSession("a")

		expect(noteIsEditing(useNotesInflightStore.getState(), "a")).toBe(false)
		expect(noteIsEditing(useNotesInflightStore.getState(), "b")).toBe(true)
	})

	it("cancel() clears every session so a wiped account leaves no note gated", () => {
		beginEditingSession("a")

		newSync().cancel()

		expect(useNotesInflightStore.getState().editingSessions).toStrictEqual({})
	})

	it("is idempotent in both directions (no state churn per keystroke)", () => {
		beginEditingSession("a")
		const afterBegin = useNotesInflightStore.getState().editingSessions

		beginEditingSession("a")

		expect(useNotesInflightStore.getState().editingSessions).toBe(afterBegin)

		endEditingSession("a")
		const afterEnd = useNotesInflightStore.getState().editingSessions

		endEditingSession("a")

		expect(useNotesInflightStore.getState().editingSessions).toBe(afterEnd)
	})
})
