import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, onlineManager } from "@tanstack/react-query"
import type { Note } from "@filen/sdk-rs"

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

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }))

import { Sync } from "@/features/notes/lib/sync"
import useNotesInflightStore, { hasInflight, type InflightContent } from "@/features/notes/store/useNotesInflight"
import { reconcileFollower, hashNoteContent, type RemoteEnqueue } from "@/features/notes/lib/sync.logic"

function makeNote(uuid: string, overrides: Partial<Note> = {}): Note {
	return {
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
}

// Inferred return type keeps each field a precisely-typed Mock<Sig> — assignable to OutboxTransport AND
// carrying .mock/.mockClear. An explicit mapped-type annotation collapses them to a bare Mock, which is
// no longer assignable to the method signatures, so it is deliberately left to inference.
function mockTransport() {
	return {
		sendEnqueue: vi.fn<(msg: RemoteEnqueue) => void>(),
		sendExecuteNow: vi.fn<() => void>(),
		requestState: vi.fn<() => void>(),
		broadcastState: vi.fn<(state: InflightContent) => void>(),
		broadcastLeaderHello: vi.fn<() => void>(),
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

async function flushAsync(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 15))
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
	onlineManager.setOnline(true)
})

afterEach(() => {
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
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		const note = makeNote("a")

		await s.enqueue(note, "typed", hashNoteContent("seed"))

		// Optimistic: the store shows it immediately (UI gating must not wait a round trip).
		expect(hasInflight("a")).toBe(true)
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

	it("forwards a flush request on executeNow instead of running a pass", () => {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()
		s.executeNow()

		expect(transport.sendExecuteNow).toHaveBeenCalledTimes(1)
		expect(setNoteContent).not.toHaveBeenCalled()
	})

	it("requests the leader's current state on start (catch up to another tab's pending note)", () => {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		expect(transport.requestState).toHaveBeenCalledTimes(1)
	})
})

describe("follower reconcile-on-broadcast — spinner clears when the leader drains", () => {
	it("drops the note from the store once the leader confirms then drains it", async () => {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		const note = makeNote("a")

		await s.enqueue(note, "typed", null)
		const forwarded = firstEnqueue(transport)

		// Leader confirms receipt (its state carries our entry).
		s.applyLeaderState({ a: [{ timestamp: forwarded.timestamp, content: "typed", note }] })
		expect(hasInflight("a")).toBe(true)

		// Leader pushed + drained → empty state → the follower's spinner clears.
		s.applyLeaderState({})
		expect(hasInflight("a")).toBe(false)
	})
})

describe("follower re-send on takeover announcement", () => {
	it("re-forwards every still-unacked edit when a new leader says hello", async () => {
		const s = new Sync()
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
		const s = new Sync()
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

		// Persisted to disk (the durability point) and broadcast to followers.
		expect(kvSetJson).toHaveBeenCalledWith("inflightNoteContent", expect.any(Object))
		expect(transport.broadcastState).toHaveBeenCalled()
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

describe("promoteToLeader — a follower wins the lock and pushes carried-over work", () => {
	it("pushes an optimistic edit the follower held locally even when disk was empty", async () => {
		const s = new Sync()
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

	it("merges disk state persisted by the dead leader with the follower's local store, then pushes", async () => {
		const s = new Sync()
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
