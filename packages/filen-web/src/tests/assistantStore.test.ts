import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Same kv boundary as sidebarWidth.test.ts: the adapter itself, backed by a Map reset per test.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

// The real accessor reads `window` at import, which the node environment has none of; the session store imports it.
vi.mock("@/lib/desktop", () => ({ desktopBridge: () => undefined }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvEntriesJson: (prefix: string) => Promise.resolve([...kvStore].filter(([key]) => key.startsWith(prefix))),
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

import { useAssistantStore, toggleAssistant, hydrateAssistantPanelOpen } from "@/features/assistant/store/useAssistantStore"
import {
	cancelAssistantTurn,
	confirmAssistantProposal,
	downloadAssistantModel,
	loadAssistantModel,
	noteAssistantActivity,
	registerAssistantSession,
	rejectAssistantProposal,
	removeAssistantModel,
	sendAssistantMessage,
	startNewAssistantConversation,
	trackAssistantPanelShown
} from "@/features/assistant/store/assistantSession"
import { createMockAssistantSession, MOCK_ASSISTANT_MODEL } from "@/features/assistant/store/mockAssistantSession"
import { createAssistantSession } from "@/features/assistant/loop/session"
import { awaitingConfirmation, type TranscriptEntry } from "@/features/assistant/store/transcript"
import type { AssistantToolExecution } from "@/features/assistant/runtime/executor"
import type { AssistantEvent, AssistantSession, AssistantStep } from "@/features/assistant/types"
import { call, fakeExecutor, fakeRuntime, ScriptedModel } from "@/tests/support/assistantFakes"
import { unlessStopped } from "@/features/assistant/tools/format"

const STEP_MS = 10

let unregister: () => void = () => undefined

function withMock(options: Parameters<typeof createMockAssistantSession>[0] = {}): AssistantSession {
	const session = createMockAssistantSession({ stepMs: STEP_MS, downloadSteps: 2, ...options })

	unregister = registerAssistantSession(session)

	return session
}

function ready(): AssistantSession {
	return withMock({ initialState: { kind: "ready", model: MOCK_ASSISTANT_MODEL } })
}

function state(): ReturnType<typeof useAssistantStore.getState> {
	return useAssistantStore.getState()
}

beforeEach(() => {
	vi.useFakeTimers()
	kvStore.clear()
	useAssistantStore.setState({ panelOpen: false, drawerOpen: false, draft: "", focusRequested: false })
})

afterEach(() => {
	unregister()
	vi.useRealTimers()
})

describe("panel open state", () => {
	it("toggles the inline panel at desktop widths, persists it, and asks for focus only when opening", async () => {
		toggleAssistant(false)

		expect(state().panelOpen).toBe(true)
		expect(state().takeFocusRequest()).toBe(true)
		expect(state().takeFocusRequest()).toBe(false)

		await vi.waitFor(() => {
			expect(kvStore.get("assistant.v1.panelOpen")).toBe(true)
		})

		toggleAssistant(false)

		expect(state().panelOpen).toBe(false)
		expect(state().focusRequested).toBe(false)
	})

	it("toggles the drawer below the breakpoint without touching the persisted panel", () => {
		toggleAssistant(true)

		expect(state().drawerOpen).toBe(true)
		expect(state().panelOpen).toBe(false)
		expect(kvStore.has("assistant.v1.panelOpen")).toBe(false)
	})

	// The loader is load-once per module, so this is the file's only hydration case: a toggle has already
	// happened in the tests above, and that choice must win over the stored value.
	it("never lets a late stored value override the user's own toggle", async () => {
		kvStore.set("assistant.v1.panelOpen", true)
		useAssistantStore.setState({ panelOpen: false })

		await hydrateAssistantPanelOpen()

		expect(state().panelOpen).toBe(false)
	})
})

describe("session wiring", () => {
	it("tells a newly registered session whether the panel already shows, and every change after", () => {
		const calls: boolean[] = []
		const mock = createMockAssistantSession()
		const release = trackAssistantPanelShown()

		unregister = registerAssistantSession({
			...mock,
			setPanelOpen: open => {
				calls.push(open)
			}
		})
		release()

		expect(calls).toEqual([true, false])
	})

	it("downloads, then leaves the model on disk with the panel showing until it is asked to load", () => {
		withMock()

		const release = trackAssistantPanelShown()

		downloadAssistantModel()

		expect(state().modelState.kind).toBe("downloading")

		vi.advanceTimersByTime(STEP_MS * 3)

		expect(state().modelState).toMatchObject({ kind: "downloaded", idleUnloaded: false })

		vi.advanceTimersByTime(STEP_MS * 100)

		expect(state().modelState.kind).toBe("downloaded")

		loadAssistantModel()

		expect(state().modelState.kind).toBe("loading")

		vi.advanceTimersByTime(STEP_MS * 2)

		expect(state().modelState.kind).toBe("ready")

		release()
	})

	it("sends from a model on disk: the turn loads it first, then runs", () => {
		withMock({ initialState: { kind: "downloaded", model: MOCK_ASSISTANT_MODEL, idleUnloaded: true } })

		expect(sendAssistantMessage("find my taxes")).toBe(true)
		expect(state().modelState.kind).toBe("loading")
		expect(state().entries[0]).toMatchObject({ kind: "user", text: "find my taxes" })
		expect(state().entries[1]).toMatchObject({ kind: "steps", steps: [{ kind: "loading", status: "active" }] })
		expect(state().activeTurnId).not.toBeNull()

		vi.advanceTimersByTime(STEP_MS * 2 + 16)

		expect(state().modelState.kind).toBe("ready")
		expect(state().entries[1]).toMatchObject({
			kind: "steps",
			steps: [
				{ kind: "loading", status: "done" },
				{ kind: "routing", status: "done", route: "files" },
				{ kind: "tool", tool: "search_items", status: "active" }
			]
		})

		vi.runAllTimers()

		expect(state().activeTurnId).toBeNull()
		expect(state().entries.some(entry => entry.kind === "reply" && entry.final)).toBe(true)
	})

	it("hands the user's typing to the session", () => {
		const mock = ready()
		const noteActivity = vi.spyOn(mock, "noteActivity")

		noteAssistantActivity()

		expect(noteActivity).toHaveBeenCalledTimes(1)
	})

	// The mock emits the turn's first steps synchronously inside send(); they must still land after the
	// user's message.
	it("streams a turn into the transcript below the message that started it, and frees the composer when it ends", () => {
		ready()

		expect(sendAssistantMessage("  find my taxes  ")).toBe(true)
		expect(state().entries[0]).toMatchObject({ kind: "user", text: "find my taxes" })
		expect(state().entries[1]).toMatchObject({
			kind: "steps",
			outcome: null,
			steps: [
				{ kind: "routing", status: "done" },
				{ kind: "tool", tool: "search_items", subject: "taxes", status: "active" }
			]
		})
		expect(state().activeTurnId).not.toBeNull()
		// A second message while one is running is refused.
		expect(sendAssistantMessage("again")).toBe(false)

		vi.runAllTimers()

		expect(state().activeTurnId).toBeNull()
		expect(state().entries.some(entry => entry.kind === "reply" && entry.final)).toBe(true)
		expect(state().entries[1]).toMatchObject({
			kind: "steps",
			outcome: "complete",
			steps: [{ kind: "routing" }, { kind: "tool", status: "done", resultCount: 3 }]
		})
	})

	it("refuses to send before the model is on disk or with nothing typed", () => {
		withMock()

		expect(sendAssistantMessage("hello")).toBe(false)

		unregister()
		withMock({ initialState: { kind: "downloading", model: MOCK_ASSISTANT_MODEL, receivedBytes: 1, waiting: false, resumed: false } })

		expect(sendAssistantMessage("hello")).toBe(false)

		unregister()
		ready()

		expect(sendAssistantMessage("   ")).toBe(false)
	})

	it("stops a running turn", () => {
		ready()
		sendAssistantMessage("hello")
		cancelAssistantTurn()

		expect(state().activeTurnId).toBeNull()
		expect(state().entries.at(-1)).toMatchObject({ kind: "turnEnd", outcome: "cancelled" })
	})

	it("confirms a card synchronously into the session, then settles it from the runtime's outcome", () => {
		const mock = ready()
		const confirm = vi.spyOn(mock, "confirm")

		sendAssistantMessage("move my receipts")
		vi.runAllTimers()

		const card = state().entries.find(entry => entry.kind === "proposal")

		if (card?.kind !== "proposal") {
			throw new Error("no card")
		}

		expect(state().activeTurnId).not.toBeNull()

		confirmAssistantProposal(card.proposal.id)

		expect(confirm).toHaveBeenCalledWith(card.proposal.id)
		expect(state().entries.find(entry => entry.id === card.id)).toMatchObject({ status: "running" })

		vi.runAllTimers()

		expect(state().entries.find(entry => entry.id === card.id)).toMatchObject({ status: "done" })
		expect(state().activeTurnId).toBeNull()
	})

	it("keeps the turn open while a card waits, then declines it through the session and lets the turn end", () => {
		const mock = ready()
		const reject = vi.spyOn(mock, "reject")

		sendAssistantMessage("trash these")
		vi.runAllTimers()

		expect(state().entries.find(entry => entry.id === "proposal:turn-1:call_1_0")).toMatchObject({ status: "pending" })
		expect(state().activeTurnId).toBe("turn-1")
		expect(awaitingConfirmation(state())).toBe(true)

		rejectAssistantProposal("turn-1:call_1_0")

		expect(reject).toHaveBeenCalledWith("turn-1:call_1_0")
		expect(state().entries.find(entry => entry.id === "proposal:turn-1:call_1_0")).toMatchObject({ status: "cancelled" })

		vi.runAllTimers()

		expect(state().activeTurnId).toBeNull()
		expect(state().entries.find(entry => entry.kind === "steps")).toMatchObject({
			outcome: "complete",
			steps: [{ kind: "routing" }, { kind: "tool", tool: "search_items" }, { kind: "tool", tool: "trash_items", failure: "declined" }]
		})
	})

	it("starts a new conversation with an empty transcript and a reset session", () => {
		const mock = ready()
		const reset = vi.spyOn(mock, "reset")

		sendAssistantMessage("hello")
		vi.runAllTimers()
		startNewAssistantConversation()

		expect(reset).toHaveBeenCalled()
		expect(state().entries).toEqual([])
		expect(state().modelState.kind).toBe("ready")
	})

	it("removes the downloaded model back to the setup state", async () => {
		ready()

		await removeAssistantModel()

		expect(state().modelState.kind).toBe("not-downloaded")
	})
})

describe("event delivery", () => {
	// A session whose events the test emits by hand; send() starts turn "t1".
	function manual(): { emit: (event: AssistantEvent) => void } {
		const listeners = new Set<(event: AssistantEvent) => void>()
		const mock = createMockAssistantSession({ initialState: { kind: "ready", model: MOCK_ASSISTANT_MODEL } })

		unregister = registerAssistantSession({
			...mock,
			subscribe: listener => {
				listeners.add(listener)

				return () => {
					listeners.delete(listener)
				}
			},
			send: () => "t1",
			cancel: () => undefined
		})

		return {
			emit: event => {
				for (const listener of listeners) {
					listener(event)
				}
			}
		}
	}

	const thinking = (progress: number): AssistantStep => ({ id: "t1:think", kind: "thinking", status: "active", progress })

	it("folds streamed text and step updates into one store update per frame, in order", () => {
		const { emit } = manual()

		sendAssistantMessage("hello")

		const updates = vi.fn()
		const stop = useAssistantStore.subscribe(updates)

		emit({ type: "step", turnId: "t1", step: thinking(0.2), at: 1 })
		emit({ type: "step", turnId: "t1", step: thinking(0.7), at: 2 })
		emit({ type: "reply", turnId: "t1", replyId: "r", text: "Hel", final: false })
		emit({ type: "reply", turnId: "t1", replyId: "r", text: "Hello", final: false })

		expect(updates).not.toHaveBeenCalled()

		vi.advanceTimersByTime(16)

		expect(updates).toHaveBeenCalledTimes(1)
		expect(state().entries.map(entry => entry.kind)).toEqual(["user", "steps", "reply"])
		expect(state().entries[1]).toMatchObject({ steps: [{ id: "t1:think", progress: 0.7, startedAt: 1 }] })
		expect(state().entries[2]).toMatchObject({ text: "Hello", final: false })

		stop()
	})

	it("applies anything else at once, after what is pending", () => {
		const { emit } = manual()

		sendAssistantMessage("hello")
		emit({ type: "reply", turnId: "t1", replyId: "r", text: "Hel", final: false })
		emit({ type: "reply", turnId: "t1", replyId: "r", text: "Hello.", final: true })

		expect(state().entries[1]).toMatchObject({ kind: "reply", text: "Hello.", final: true })

		emit({ type: "step", turnId: "t1", step: thinking(0.5), at: 3 })
		emit({ type: "turn-end", turnId: "t1", at: 0, outcome: "complete" })

		expect(state().activeTurnId).toBeNull()
		// The pending step landed first, then the turn's end removed the row it no longer needs.
		expect(state().entries.find(entry => entry.kind === "steps")).toMatchObject({ outcome: "complete", steps: [] })
	})

	it("drops what a stopped turn still delivers once a new conversation started", () => {
		const { emit } = manual()

		sendAssistantMessage("hello")
		emit({ type: "step", turnId: "t1", step: thinking(0.5), at: 3 })
		startNewAssistantConversation()
		vi.advanceTimersByTime(16)
		emit({ type: "turn-end", turnId: "t1", at: 0, outcome: "cancelled" })

		expect(state().entries).toEqual([])
		expect(state().activeTurnId).toBeNull()
	})
})

// The real session (loop/session.ts) over a scripted model, so the store meets the card flow production
// runs: the turn waits on a card, and Stop, a model delete or a new conversation can end it under the card.
describe("with the real session", () => {
	const MARIA = { list_chats: { chats: [{ handle: "c1", name: "Maria" }] } }

	beforeEach(() => {
		vi.useRealTimers()
	})

	function draftSession(executor = fakeExecutor(MARIA)): {
		session: ReturnType<typeof createAssistantSession>
		executor: ReturnType<typeof fakeExecutor>
	} {
		const model = new ScriptedModel({
			route: "chats change",
			steps: [
				call("list_chats", { query: "Maria" }),
				call("draft_chat_message", { chat: "c1", text: "I'm running late" }),
				"Drafted it."
			]
		})
		const session = createAssistantSession({ runtime: fakeRuntime(model), executor })

		unregister = registerAssistantSession(session)

		return { session, executor }
	}

	function waitForCard(): Promise<Extract<TranscriptEntry, { kind: "proposal" }>> {
		return vi.waitFor(() => {
			const card = state().entries.find(entry => entry.kind === "proposal")

			if (card?.kind !== "proposal") {
				throw new Error("no card yet")
			}

			return card
		})
	}

	function cardStatus(id: string): string | undefined {
		const entry = state().entries.find(candidate => candidate.id === id)

		return entry?.kind === "proposal" ? entry.status : undefined
	}

	function drafts(executor: ReturnType<typeof fakeExecutor>): number {
		return executor.executed.filter(entry => entry.call.name === "draft_chat_message").length
	}

	it("keeps the turn running while a card waits, and runs a confirmed card once before the turn completes", async () => {
		const { session, executor } = draftSession()
		const confirm = vi.spyOn(session, "confirm")

		expect(sendAssistantMessage("Tell Maria I'm running late")).toBe(true)

		const card = await waitForCard()

		expect(card.status).toBe("pending")
		expect(state().activeTurnId).not.toBeNull()

		confirmAssistantProposal(card.proposal.id)
		confirmAssistantProposal(card.proposal.id)

		expect(confirm).toHaveBeenCalledTimes(1)
		expect(drafts(executor)).toBe(1)

		await vi.waitFor(() => {
			expect(state().activeTurnId).toBeNull()
		})

		expect(cardStatus(card.id)).toBe("done")
		expect(drafts(executor)).toBe(1)
	})

	it("sends a message typed while a card waits: the card expires and the old turn goes without a Stopped row", async () => {
		const { executor } = draftSession()

		sendAssistantMessage("Tell Maria I'm running late")

		const card = await waitForCard()
		const first = card.turnId

		// While only the card waits, sending is open again; before that a turn refuses a second message.
		expect(sendAssistantMessage("No, tell her I'm on time")).toBe(true)
		expect(state().activeTurnId).not.toBe(first)
		expect(cardStatus(card.id)).toBe("expired")
		expect(sendAssistantMessage("And one more")).toBe(false)

		await vi.waitFor(() => {
			expect(state().activeTurnId).toBeNull()
		})

		expect(state().entries.some(entry => entry.kind === "turnEnd" && entry.turnId === first)).toBe(false)
		expect(drafts(executor)).toBe(0)
	})

	for (const [name, end] of [
		["Stop", cancelAssistantTurn],
		["deleting the model", () => void removeAssistantModel()]
	] as const) {
		it(`expires a waiting card when ${name} ends its turn, so a later Confirm reaches nothing`, async () => {
			const { session, executor } = draftSession()
			const confirm = vi.spyOn(session, "confirm")

			sendAssistantMessage("Tell Maria I'm running late")

			const card = await waitForCard()

			end()

			await vi.waitFor(() => {
				expect(state().activeTurnId).toBeNull()
			})

			expect(state().entries.at(-1)).toMatchObject({ kind: "turnEnd", outcome: "cancelled" })
			expect(cardStatus(card.id)).toBe("expired")

			confirmAssistantProposal(card.proposal.id)

			expect(confirm).not.toHaveBeenCalled()
			expect(cardStatus(card.id)).toBe("expired")
			expect(drafts(executor)).toBe(0)
		})
	}

	it("starts a new conversation clean while a turn is mid-tool: the old turn's late events and exchange stay out", async () => {
		let finishLookup: () => void = () => undefined
		const executor = fakeExecutor(MARIA)
		const execute = executor.execute.bind(executor)

		executor.execute = request => {
			if (request.tool.name !== "list_chats") {
				return execute(request)
			}

			executor.executed.push({ call: { name: request.tool.name, args: request.args }, confirmed: request.confirmed })

			return new Promise<AssistantToolExecution>(resolve => {
				finishLookup = () => {
					resolve({ ok: true, result: MARIA.list_chats })
				}
			})
		}

		const model = new ScriptedModel({ route: "chats read", steps: [call("list_chats", { query: "Maria" }), "Yes, Maria.", "Hello."] })
		const session = createAssistantSession({ runtime: fakeRuntime(model), executor })

		const events: AssistantEvent[] = []

		session.subscribe(event => events.push(event))
		unregister = registerAssistantSession(session)
		sendAssistantMessage("Do I have a chat with Maria?")

		await vi.waitFor(() => {
			expect(executor.executed).toHaveLength(1)
		})

		startNewAssistantConversation()

		expect(state().entries).toEqual([])
		expect(state().activeTurnId).toBeNull()
		expect(sendAssistantMessage("hi")).toBe(true)

		finishLookup()

		// Both turns ended: the stopped one too, late.
		await vi.waitFor(() => {
			expect(events.flatMap(event => (event.type === "turn-end" ? [event.outcome] : []))).toEqual(
				expect.arrayContaining(["cancelled", "complete"])
			)
		})

		expect(state().activeTurnId).toBeNull()

		expect(state().entries.flatMap(entry => (entry.kind === "user" ? [entry.text] : []))).toEqual(["hi"])
		expect(state().entries.some(entry => entry.kind === "turnEnd")).toBe(false)
		expect(session.getHistory().map(exchange => exchange.user)).toEqual(["hi"])
	})

	it("starts a new conversation clean while a confirmed action still runs: its outcome lands nowhere", async () => {
		let finishDraft: () => void = () => undefined
		const executor = fakeExecutor(MARIA)
		const execute = executor.execute.bind(executor)

		executor.execute = request => {
			if (request.tool.name !== "draft_chat_message") {
				return execute(request)
			}

			executor.executed.push({ call: { name: request.tool.name, args: request.args }, confirmed: request.confirmed })

			// Stopped by its signal, as the app's executor is.
			return unlessStopped(
				new Promise<AssistantToolExecution>(resolve => {
					finishDraft = () => {
						resolve({ ok: true, result: { done: true } })
					}
				}),
				request.signal
			)
		}

		const { session } = draftSession(executor)
		const events: AssistantEvent[] = []

		session.subscribe(event => events.push(event))
		sendAssistantMessage("Tell Maria I'm running late")

		const card = await waitForCard()

		confirmAssistantProposal(card.proposal.id)

		expect(cardStatus(card.id)).toBe("running")

		startNewAssistantConversation()
		finishDraft()

		await vi.waitFor(() => {
			expect(events.some(event => event.type === "proposal-settled")).toBe(true)
		})

		// It ran to its end: the draft landed and its card settled as done.
		expect(events.find(event => event.type === "proposal-settled")).toMatchObject({ outcome: "done" })
		expect(state().entries).toEqual([])
		expect(state().activeTurnId).toBeNull()
		expect(drafts(executor)).toBe(1)
		expect(session.getHistory()).toEqual([])
	})
})
