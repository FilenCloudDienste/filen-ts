import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The kv adapter, backed by a Map reset per test; values pass through JSON like the real envelope. Every
// write is recorded so a test can tell which rows a save touched.
// The session row is a flag of its own, so the history rows stay the only ones in the Map.
const { kvStore, kvWrites, signOut, authHandlers } = vi.hoisted(() => ({
	kvStore: new Map<string, unknown>(),
	kvWrites: [] as string[],
	signOut: { pending: false, session: true },
	authHandlers: new Set<(message: { kind: "login" | "logout" }) => void>()
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvWrites.push(key)
		kvStore.set(key, JSON.parse(JSON.stringify(value)) as unknown)

		return Promise.resolve()
	},
	kvEntriesJson: (prefix: string) =>
		Promise.resolve(
			[...kvStore].filter(([key, value]) => key.startsWith(prefix) && typeof value === "object" && value !== null && "rev" in value)
		),
	kvKeys: (prefix: string) => Promise.resolve([...kvStore.keys()].filter(key => key.startsWith(prefix))),
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	},
	kvDeletePrefix: (prefix: string) => {
		for (const key of [...kvStore.keys()].filter(key => key.startsWith(prefix))) {
			kvStore.delete(key)
		}

		return Promise.resolve()
	}
}))

vi.mock("@/lib/signOutPending", () => ({ readSignOutPending: () => signOut.pending }))

vi.mock("@/lib/sdk/session", () => ({
	hasPersistedSession: () => Promise.resolve(signOut.session),
	onAuthBroadcast: (handler: (message: { kind: "login" | "logout" }) => void) => {
		authHandlers.add(handler)

		return () => {
			authHandlers.delete(handler)
		}
	}
}))

import {
	conversationBodySchema,
	conversationTitle,
	groupConversations,
	historyBodyKey,
	historyMetaKey,
	planHistoryPrune,
	restoreConversation,
	serializeConversation,
	HISTORY_KV_PREFIX,
	HISTORY_MAX_CONVERSATION_BYTES,
	HISTORY_MAX_CONVERSATIONS,
	HISTORY_MAX_TOTAL_BYTES,
	type ConversationMeta,
	type ConversationSnapshot
} from "@/features/assistant/store/history.logic"
import {
	currentConversationId,
	loadConversationIndex,
	registerConversationSnapshot,
	resetConversationHistory,
	saveConversationNow,
	scheduleConversationSave,
	setHistoryOpen,
	startConversationSlot,
	useAssistantHistoryStore,
	whenHistoryWritten,
	withHistoryWritesHeld
} from "@/features/assistant/store/conversationHistory"
import {
	clearAssistantConversations,
	confirmAssistantProposal,
	deleteAssistantConversation,
	openAssistantConversation,
	registerAssistantSession,
	sendAssistantMessage,
	setAssistantHistoryOpen,
	startNewAssistantConversation
} from "@/features/assistant/store/assistantSession"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { createMockAssistantSession, MOCK_ASSISTANT_MODEL } from "@/features/assistant/store/mockAssistantSession"
import { beginTurn, INITIAL_TRANSCRIPT_STATE, type TranscriptEntry } from "@/features/assistant/store/transcript"
import type { AssistantProposal, AssistantSession } from "@/features/assistant/types"

const DRAFT: AssistantProposal = {
	id: "turn-1:call_1_0",
	action: "draft-message",
	targets: [{ handle: "c1", name: "Maria" }],
	destination: null,
	text: { text: "Running late" }
}

// A completed turn with steps, a reply and a card in the given status.
function turnEntries(turnId: string, text: string, status: "pending" | "running" | "done" = "done"): TranscriptEntry[] {
	return [
		{ kind: "user", id: `user:${turnId}`, turnId, text },
		{
			kind: "steps",
			id: `steps:${turnId}`,
			turnId,
			steps: [
				{ id: `${turnId}:routing`, kind: "routing", status: "done", progress: null, route: "chats", startedAt: 1, endedAt: 2 },
				{
					id: `${turnId}:call_1_0`,
					kind: "tool",
					status: "done",
					progress: null,
					tool: "list_chats",
					subject: "Maria",
					resultCount: 1,
					resultMore: false,
					failure: null,
					startedAt: 2,
					endedAt: 3
				}
			],
			startedAt: 1,
			lastAt: 4,
			outcome: "complete",
			expanded: true
		},
		{ kind: "reply", id: `reply:${turnId}:r0`, turnId, text: `Answer to ${text}`, final: true },
		{ kind: "proposal", id: `proposal:${DRAFT.id}`, turnId, proposal: { ...DRAFT, id: `${turnId}:p` }, status }
	]
}

function snapshot(
	entries: TranscriptEntry[],
	history = [{ user: "q", reply: "a" }],
	activeTurnId: string | null = null
): ConversationSnapshot {
	return { entries, activeTurnId, history }
}

function meta(id: string, updatedAt: number, bytes = 100): ConversationMeta {
	return { id, title: id, createdAt: updatedAt, updatedAt, bytes, rev: `r-${id}` }
}

function metaRows(): ConversationMeta[] {
	return [...kvStore].filter(([key]) => key.startsWith(historyMetaKey(""))).map(([, value]) => value as ConversationMeta)
}

beforeEach(() => {
	kvStore.clear()
	kvWrites.length = 0
	signOut.pending = false
	signOut.session = true
})

describe("conversation serialization", () => {
	it("round-trips a conversation: what a restore gives back saves to exactly the same content", () => {
		const content = serializeConversation(snapshot([...turnEntries("turn-1", "first"), ...turnEntries("turn-2", "second")]), 10)

		expect(conversationBodySchema({ v: 1, rev: "x", ...content })).not.toBeInstanceOf(Error)

		const restored = restoreConversation(content, "saved1")

		expect(restored.history).toEqual([{ user: "q", reply: "a" }])
		expect(restored.entries.map(entry => entry.kind)).toEqual([
			"user",
			"steps",
			"reply",
			"proposal",
			"user",
			"steps",
			"reply",
			"proposal"
		])
		expect(restored.entries[0]).toEqual({ kind: "user", id: "user:saved1-0", turnId: "saved1-0", text: "first" })
		expect(serializeConversation(snapshot(restored.entries), 99)).toEqual(content)
	})

	it("stores step labels, statuses and times, never more than the step showed", () => {
		const content = serializeConversation(snapshot(turnEntries("turn-1", "find Maria")), 10)
		const steps = content.entries.find(entry => entry.kind === "steps")

		expect(steps).toEqual({
			kind: "steps",
			turn: 0,
			startedAt: 1,
			lastAt: 4,
			outcome: "complete",
			steps: [
				{ kind: "routing", route: "chats", status: "done", startedAt: 1, endedAt: 2 },
				{
					kind: "tool",
					tool: "list_chats",
					subject: "Maria",
					resultCount: 1,
					resultMore: false,
					failure: null,
					status: "done",
					startedAt: 2,
					endedAt: 3
				}
			]
		})
	})

	it("never stores a card as actionable: a pending one is restored expired, a running one interrupted, under ids no session holds", () => {
		for (const [status, restoredAs] of [
			["pending", "expired"],
			["running", "interrupted"]
		] as const) {
			const content = serializeConversation(snapshot(turnEntries("turn-1", "draft it", status)), 10)
			const restored = restoreConversation(content, "saved7")
			const card = restored.entries.find(entry => entry.kind === "proposal")

			expect(card).toMatchObject({ status: restoredAs, proposal: { id: "saved7-0:p0", action: "draft-message" } })
		}
	})

	it("saves a turn still running as stopped", () => {
		const state = beginTurn({ ...INITIAL_TRANSCRIPT_STATE }, "turn-9", "still going")
		const entries: TranscriptEntry[] = [
			...state.entries,
			{ kind: "reply", id: "reply:turn-9:r0", turnId: "turn-9", text: "Half a", final: false }
		]
		const restored = restoreConversation(serializeConversation(snapshot(entries, [], "turn-9"), 50), "saved2")

		expect(restored.entries.map(entry => entry.kind)).toEqual(["user", "reply", "turnEnd"])
		expect(restored.entries.at(-1)).toMatchObject({ kind: "turnEnd", outcome: "cancelled" })
		expect(restored.entries[1]).toMatchObject({ final: true })
	})

	it("keeps a conversation under its cap by dropping its oldest turns first", () => {
		const long = "x".repeat(15_000)
		const entries = Array.from({ length: 30 }, (_, index) => turnEntries(`turn-${String(index)}`, `${String(index)} ${long}`)).flat()
		const content = serializeConversation(snapshot(entries), 10)
		const bytes = new TextEncoder().encode(JSON.stringify(content)).byteLength
		const turns = content.entries.filter(entry => entry.kind === "user")

		expect(bytes).toBeLessThanOrEqual(HISTORY_MAX_CONVERSATION_BYTES)
		expect(turns.length).toBeLessThan(30)
		expect(turns.at(-1)).toMatchObject({ text: `29 ${long}` })
	})

	it("caps a pasted wall of text", () => {
		const content = serializeConversation(snapshot(turnEntries("turn-1", "y".repeat(100_000))), 10)

		expect(content.entries[0]).toMatchObject({ kind: "user" })
		expect((content.entries[0] as { text: string }).text.length).toBeLessThan(20_000)
	})

	it("titles a conversation from its first message, on one line, cut at a word", () => {
		const titleOf = (text: string) => conversationTitle(serializeConversation(snapshot(turnEntries("turn-1", text)), 1))

		expect(titleOf("  find\nmy   taxes ")).toBe("find my taxes")
		expect(titleOf("Summarize every note I wrote about the garden renovation last spring please")).toBe(
			"Summarize every note I wrote about the garden renovation…"
		)
	})
})

describe("history budget", () => {
	it("prunes by count, the conversations active longest ago first", () => {
		const metas = Array.from({ length: HISTORY_MAX_CONVERSATIONS + 3 }, (_, index) => meta(`c${String(index)}`, index))

		expect(planHistoryPrune(metas, new Set())).toEqual(["c0", "c1", "c2"])
	})

	it("prunes by total bytes, never a kept conversation", () => {
		const big = HISTORY_MAX_TOTAL_BYTES / 2
		const metas = [meta("old", 1, big), meta("kept", 0, big), meta("mid", 2, big), meta("new", 3, 10)]

		expect(planHistoryPrune(metas, new Set(["kept"]))).toEqual(["old", "mid"])
		expect(planHistoryPrune(metas, new Set(["kept", "old"]))).toEqual(["mid", "new"])
		expect(planHistoryPrune(metas.slice(2), new Set())).toEqual([])
	})

	it("groups by the local calendar day of the last activity, newest first", () => {
		const now = new Date(2026, 9, 8, 9, 0).getTime()
		const at = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime()
		const groups = groupConversations(
			[meta("a", at(8, 1)), meta("b", at(7, 23)), meta("c", at(2, 12)), meta("d", at(0, 23)), meta("e", at(8, 8))],
			now
		)

		expect(groups.map(({ group, conversations }) => [group, conversations.map(entry => entry.id)])).toEqual([
			["today", ["e", "a"]],
			["yesterday", ["b"]],
			["previous7Days", ["c"]],
			["older", ["d"]]
		])
	})
})

describe("saving conversations", () => {
	let current: ConversationSnapshot

	beforeEach(() => {
		vi.useFakeTimers()
		current = snapshot(turnEntries("turn-1", "first"))
		registerConversationSnapshot(() => current)
		startConversationSlot()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("debounces saves: nothing is written until the conversation goes quiet, then once", async () => {
		scheduleConversationSave()
		vi.advanceTimersByTime(500)
		scheduleConversationSave()
		vi.advanceTimersByTime(900)

		expect(kvWrites).toEqual([])

		vi.advanceTimersByTime(100)
		await whenHistoryWritten()

		const id = currentConversationId()

		expect(id).not.toBeNull()
		expect(kvWrites).toEqual([historyBodyKey(id ?? ""), historyMetaKey(id ?? "")])
		expect(metaRows()).toMatchObject([{ id, title: "first" }])
	})

	it("never rewrites an unchanged conversation, and writes only its own rows", async () => {
		saveConversationNow()
		await whenHistoryWritten()

		const first = currentConversationId() ?? ""

		saveConversationNow()
		await whenHistoryWritten()

		expect(kvWrites).toHaveLength(2)

		startConversationSlot()
		current = snapshot(turnEntries("turn-5", "second"))
		saveConversationNow()
		await whenHistoryWritten()

		const second = currentConversationId() ?? ""

		expect(second).not.toBe(first)
		expect(kvWrites.slice(2)).toEqual([historyBodyKey(second), historyMetaKey(second)])
	})

	it("prunes the oldest conversations once over the count", async () => {
		for (let index = 0; index < HISTORY_MAX_CONVERSATIONS; index++) {
			kvStore.set(historyMetaKey(`old${String(index)}`), meta(`old${String(index)}`, index))
			kvStore.set(historyBodyKey(`old${String(index)}`), { v: 1, rev: `r-old${String(index)}`, entries: [], history: [] })
		}

		saveConversationNow()
		await whenHistoryWritten()

		expect(metaRows()).toHaveLength(HISTORY_MAX_CONVERSATIONS)
		expect(kvStore.has(historyMetaKey("old0"))).toBe(false)
		expect(kvStore.has(historyBodyKey("old0"))).toBe(false)
		expect(kvStore.has(historyMetaKey("old1"))).toBe(true)
	})

	it("never overwrites a conversation another tab changed or deleted: this tab's copy becomes its own", async () => {
		saveConversationNow()
		await whenHistoryWritten()

		const id = currentConversationId() ?? ""
		const theirs = { ...(kvStore.get(historyMetaKey(id)) as ConversationMeta), rev: "other-tab", title: "theirs" }

		kvStore.set(historyMetaKey(id), theirs)
		current = snapshot([...turnEntries("turn-1", "first"), ...turnEntries("turn-2", "more")])
		saveConversationNow()
		await whenHistoryWritten()

		const forked = currentConversationId() ?? ""

		expect(forked).not.toBe(id)
		expect(kvStore.get(historyMetaKey(id))).toEqual(theirs)
		expect(metaRows()).toHaveLength(2)

		kvStore.delete(historyMetaKey(forked))
		kvStore.delete(historyBodyKey(forked))
		current = snapshot([...turnEntries("turn-1", "first"), ...turnEntries("turn-3", "again")])
		saveConversationNow()
		await whenHistoryWritten()

		expect(currentConversationId()).not.toBe(forked)
		expect(kvStore.has(historyMetaKey(forked))).toBe(false)
	})

	it("writes nothing while a sign-out is under way", async () => {
		signOut.pending = true
		saveConversationNow()
		await whenHistoryWritten()

		expect(kvWrites).toEqual([])
	})

	it("writes nothing once the session is gone, also a write that waited for the wipe to finish", async () => {
		vi.useRealTimers()
		await withHistoryWritesHeld(async () => {
			saveConversationNow()
			await Promise.resolve()
			// What the logout wipe does while it holds the lock: the session row, then everything.
			signOut.session = false
			kvStore.clear()
		})
		await whenHistoryWritten()

		expect(kvWrites).toEqual([])

		// The next change tries again once a session is back.
		signOut.session = true
		saveConversationNow()
		await whenHistoryWritten()

		expect(metaRows()).toHaveLength(1)
	})

	it("drops rows no valid index row covers when it prunes, never a valid conversation", async () => {
		kvStore.set(historyBodyKey("orphan"), { v: 1, rev: "r", entries: [], history: [] })
		kvStore.set(historyMetaKey("broken"), { id: "broken" })
		kvStore.set(historyBodyKey("broken"), { v: 1, rev: "r", entries: [], history: [] })
		kvStore.set(historyMetaKey("misfiled"), meta("elsewhere", 1))
		kvStore.set(historyMetaKey("valid"), meta("valid", 1))
		kvStore.set(historyBodyKey("valid"), { v: 1, rev: "r-valid", entries: [], history: [] })
		saveConversationNow()
		await whenHistoryWritten()

		const id = currentConversationId() ?? ""

		expect([...kvStore.keys()].sort()).toEqual(
			[historyBodyKey(id), historyMetaKey(id), historyBodyKey("valid"), historyMetaKey("valid")].sort()
		)
	})

	it("reads the index only when the history opens, newest first, with the conversation on screen saved", async () => {
		kvStore.set(historyMetaKey("a"), meta("a", 1))
		kvStore.set(historyMetaKey("b"), meta("b", 5))
		useAssistantHistoryStore.setState({ conversations: null })
		scheduleConversationSave()

		expect(useAssistantHistoryStore.getState().conversations).toBeNull()

		setHistoryOpen(true)
		await vi.waitFor(() => {
			expect(useAssistantHistoryStore.getState().conversations?.map(entry => entry.id)).toEqual([currentConversationId(), "b", "a"])
		})
		setHistoryOpen(false)
	})

	it("keeps every row under the history prefix, so the logout kv wipe takes them all", async () => {
		saveConversationNow()
		await whenHistoryWritten()

		expect([...kvStore.keys()].every(key => key.startsWith(HISTORY_KV_PREFIX))).toBe(true)

		kvStore.clear()
		await loadConversationIndex()

		expect(useAssistantHistoryStore.getState().conversations).toEqual([])
	})
})

describe("switching conversations", () => {
	let session: AssistantSession
	let unregister: () => void = () => undefined

	function state() {
		return useAssistantStore.getState()
	}

	beforeEach(() => {
		vi.useFakeTimers()
		session = createMockAssistantSession({ initialState: { kind: "ready", model: MOCK_ASSISTANT_MODEL }, stepMs: 10 })
		unregister = registerAssistantSession(session)
	})

	afterEach(() => {
		unregister()
		vi.useRealTimers()
	})

	async function saveOne(message: string): Promise<ConversationMeta> {
		sendAssistantMessage(message)
		vi.runAllTimers()
		await whenHistoryWritten()

		const saved = metaRows().find(entry => entry.id === currentConversationId())

		if (saved === undefined) {
			throw new Error("not saved")
		}

		return saved
	}

	it("restores a saved conversation and the model's context, and starts a new one clean", async () => {
		const first = await saveOne("find my taxes")
		const reset = vi.spyOn(session, "reset")

		startNewAssistantConversation()

		expect(reset).toHaveBeenLastCalledWith()
		expect(state().entries).toEqual([])
		expect(session.getHistory()).toEqual([])

		await expect(openAssistantConversation(first)).resolves.toBe("opened")

		expect(reset).toHaveBeenLastCalledWith([{ user: "find my taxes", reply: expect.stringContaining("3 files") as string }])
		expect(session.getHistory()).toHaveLength(1)
		expect(state().entries[0]).toMatchObject({ kind: "user", text: "find my taxes" })
		expect(state().activeTurnId).toBeNull()
		expect(currentConversationId()).toBe(first.id)

		// Opening it changed nothing, so nothing is written back and it keeps its place in the list.
		kvWrites.length = 0
		await vi.advanceTimersByTimeAsync(2000)
		saveConversationNow()
		await whenHistoryWritten()

		expect(kvWrites).toEqual([])
	})

	it("stops a running turn when switching, saving it as stopped", async () => {
		const first = await saveOne("find my taxes")
		const cancel = vi.spyOn(session, "cancel")

		startNewAssistantConversation()
		sendAssistantMessage("a second question")

		expect(state().activeTurnId).not.toBeNull()

		await openAssistantConversation(first)

		expect(cancel).toHaveBeenCalled()
		expect(state().activeTurnId).toBeNull()
		await whenHistoryWritten()

		const second = metaRows().find(entry => entry.title === "a second question")

		expect(second).toBeDefined()

		const body = kvStore.get(historyBodyKey(second?.id ?? "")) as { entries: { kind: string; outcome?: string }[] }

		expect(body.entries.at(-1)).toEqual({ kind: "turnEnd", turn: 0, outcome: "cancelled" })
		// The cancelled turn's late events never land in the conversation now on screen.
		vi.runAllTimers()
		expect(state().entries.some(entry => entry.kind === "user" && entry.text === "a second question")).toBe(false)
	})

	it("shows a restored card inert: expired, and a confirm never reaches the session", async () => {
		const saved = await saveOne("draft a message to Maria")
		const card = state().entries.find(entry => entry.kind === "proposal")

		expect(card).toMatchObject({ status: "pending" })

		startNewAssistantConversation()
		await openAssistantConversation(saved)

		const restored = state().entries.find(entry => entry.kind === "proposal")
		const confirm = vi.spyOn(session, "confirm")

		expect(restored).toMatchObject({ status: "expired" })

		if (restored?.kind !== "proposal" || card?.kind !== "proposal") {
			throw new Error("no card")
		}

		confirmAssistantProposal(restored.proposal.id)
		confirmAssistantProposal(card.proposal.id)

		expect(confirm).not.toHaveBeenCalled()
	})

	it("deletes the conversation on screen into an empty one, and clears them all", async () => {
		const first = await saveOne("find my taxes")

		startNewAssistantConversation()
		await saveOne("play some music")
		await deleteAssistantConversation(currentConversationId() ?? "")

		expect(state().entries).toEqual([])
		expect(metaRows().map(entry => entry.id)).toEqual([first.id])

		sendAssistantMessage("unsaved yet")
		await clearAssistantConversations()
		vi.runAllTimers()
		await whenHistoryWritten()

		expect(state().entries).toEqual([])
		expect([...kvStore.keys()].filter(key => key.startsWith(HISTORY_KV_PREFIX))).toEqual([])
	})

	it("lets a newer switch stand over an open still reading its conversation", async () => {
		const first = await saveOne("find my taxes")

		startNewAssistantConversation()

		const opening = openAssistantConversation(first)

		startNewAssistantConversation()

		await expect(opening).resolves.toBe("superseded")
		expect(state().entries).toEqual([])
		expect(currentConversationId()).toBeNull()
	})

	it("drops an open still reading once the user moves on: list closed, message sent, or the conversation on screen picked", async () => {
		const first = await saveOne("find my taxes")

		startNewAssistantConversation()

		const closed = openAssistantConversation(first)

		setAssistantHistoryOpen(false)

		await expect(closed).resolves.toBe("superseded")
		expect(state().entries).toEqual([])

		const sent = openAssistantConversation(first)

		sendAssistantMessage("a new question")

		await expect(sent).resolves.toBe("superseded")
		expect(state().activeTurnId).not.toBeNull()
		expect(state().entries[0]).toMatchObject({ kind: "user", text: "a new question" })

		vi.runAllTimers()
		await whenHistoryWritten()

		const onScreen = metaRows().find(entry => entry.id === currentConversationId())

		if (onScreen === undefined) {
			throw new Error("not saved")
		}

		const other = openAssistantConversation(first)

		await expect(openAssistantConversation(onScreen)).resolves.toBe("opened")
		await expect(other).resolves.toBe("superseded")
		expect(currentConversationId()).toBe(onScreen.id)
	})

	it("never prunes the conversation just opened while the one left behind is saved", async () => {
		for (let index = 0; index < HISTORY_MAX_CONVERSATIONS; index++) {
			kvStore.set(historyMetaKey(`old${String(index)}`), meta(`old${String(index)}`, index + 1))
			kvStore.set(historyBodyKey(`old${String(index)}`), {
				v: 1,
				rev: `r-old${String(index)}`,
				entries: [{ kind: "user", turn: 0, text: `old ${String(index)}` }],
				history: []
			})
		}

		sendAssistantMessage("unsaved yet")
		vi.advanceTimersByTime(500)

		const oldest = meta("old0", 1)

		await expect(openAssistantConversation(oldest)).resolves.toBe("opened")
		await whenHistoryWritten()

		expect(currentConversationId()).toBe("old0")
		expect(useAssistantHistoryStore.getState().currentId).toBe("old0")
		expect(kvStore.has(historyMetaKey("old0"))).toBe(true)
		expect(kvStore.has(historyMetaKey("old1"))).toBe(false)
		expect(metaRows()).toHaveLength(HISTORY_MAX_CONVERSATIONS)
	})

	it("saves a confirmed card still running when switching as interrupted, never as expired", async () => {
		const first = await saveOne("find my taxes")

		startNewAssistantConversation()

		const saved = await saveOne("draft a message to Maria")
		const card = state().entries.find(entry => entry.kind === "proposal")

		if (card?.kind !== "proposal") {
			throw new Error("no card")
		}

		confirmAssistantProposal(card.proposal.id)
		await openAssistantConversation(first)
		await whenHistoryWritten()
		await openAssistantConversation(saved)

		expect(state().entries.find(entry => entry.kind === "proposal")).toMatchObject({ status: "interrupted" })
	})

	it("reports a conversation deleted meanwhile as not opened", async () => {
		const first = await saveOne("find my taxes")

		startNewAssistantConversation()
		kvStore.clear()

		await expect(openAssistantConversation(first)).resolves.toBe("missing")
		expect(state().entries).toEqual([])
	})
})

// Last: logout closes the module for the rest of the page's life.
describe("logout", () => {
	it("closes on another tab's sign-out, so the save its reload runs writes nothing", async () => {
		vi.resetModules()

		// A tab of its own: a fresh module, not the one the tests above share.
		const history = await import("@/features/assistant/store/conversationHistory")
		const before = new Set(authHandlers)

		vi.useFakeTimers()
		history.registerConversationSnapshot(() => snapshot(turnEntries("turn-1", "secret plans")))
		history.startConversationSlot()
		history.scheduleConversationSave()

		const added = [...authHandlers].filter(handler => !before.has(handler))

		expect(added).toHaveLength(1)

		for (const handler of added) {
			handler({ kind: "logout" })
		}

		// What the reload's pagehide runs.
		history.saveConversationNow()
		vi.runAllTimers()
		await history.whenHistoryWritten()
		vi.useRealTimers()

		expect(kvWrites).toEqual([])
		expect(authHandlers.size).toBe(before.size)
	})

	it("drops the list and writes nothing after the wipe, not even a save that was waiting", async () => {
		vi.useFakeTimers()

		registerConversationSnapshot(() => snapshot(turnEntries("turn-1", "secret plans")))
		startConversationSlot()
		useAssistantHistoryStore.setState({ conversations: [meta("a", 1)] })
		scheduleConversationSave()
		resetConversationHistory()
		vi.runAllTimers()
		saveConversationNow()
		await whenHistoryWritten()
		vi.useRealTimers()

		expect(kvWrites).toEqual([])
		expect(useAssistantHistoryStore.getState()).toMatchObject({ conversations: null, open: false, currentId: null })
	})
})
