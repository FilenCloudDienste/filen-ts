import type {
	AssistantEvent,
	AssistantExchange,
	AssistantModelInfo,
	AssistantModelState,
	AssistantProposal,
	AssistantSession,
	AssistantStep
} from "@/features/assistant/types"

// A scripted AssistantSession for tests. It walks the whole UI surface: a chunked download, a load that
// starts only on request (the Load action or a sent message, which waits for it), the turn's steps
// (loading, routing, a search with its prompt-reading progress and result count), a streamed markdown
// reply, and a confirmation card when the message asks to draft, move, copy, trash or download something.
// Cards behave as the real session's (loop/session.ts): the turn waits on one until it is confirmed,
// declined or the turn is stopped, and a confirm of anything else settles as failed. Timer-driven, so tests
// step it with fake timers.

export const MOCK_ASSISTANT_MODEL: AssistantModelInfo = {
	id: "mock-model",
	name: "Qwen3.5 4B",
	sizeBytes: 2_740_000_000
}

const PROPOSAL_PATTERN = /\b(draft|move|copy|trash)\b/i

const PROPOSAL_TOOLS: Partial<Record<string, string>> = {
	draft: "draft_chat_message",
	move: "move_items",
	copy: "copy_items",
	trash: "trash_items"
}

const SEARCH_REPLY = "I found **3 files** matching that in your drive:\n\n- `Taxes 2025.pdf`\n- `Receipts.xlsx`\n- `Notes.md`"

type ToolStep = Extract<AssistantStep, { kind: "tool" }>

const FILE_TARGETS = [
	{ handle: "f1", name: "Taxes 2025.pdf" },
	{ handle: "f2", name: "Receipts.xlsx" },
	{ handle: "d1", name: "Scans" }
]

function mockProposal(id: string, verb: string): AssistantProposal {
	switch (verb) {
		case "draft":
			return {
				id,
				action: "draft-message",
				targets: [{ handle: "c1", name: "Family", recipients: ["anna@example.com", "tom@example.com"] }],
				destination: null,
				text: { text: "Running late, see you at 8!" }
			}
		case "move":
		case "copy":
			return { id, action: verb, targets: FILE_TARGETS, destination: "Documents/Archive", text: {} }
		default:
			return { id, action: "trash", targets: FILE_TARGETS, destination: null, text: {} }
	}
}

export interface MockAssistantSessionOptions {
	initialState?: AssistantModelState
	// Delay between scripted steps (download chunks, reply words).
	stepMs?: number
	downloadSteps?: number
}

export function createMockAssistantSession({
	initialState = { kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL },
	stepMs = 120,
	downloadSteps = 10
}: MockAssistantSessionOptions = {}): AssistantSession {
	const listeners = new Set<(event: AssistantEvent) => void>()
	const timers = new Set<ReturnType<typeof setTimeout>>()
	let modelState = initialState
	// Cards the running turn waits on, by proposal id.
	const proposals = new Map<string, { turnId: string; call: ToolStep }>()
	let turnCount = 0
	let activeTurn: { id: string; message: string } | null = null
	let history: readonly AssistantExchange[] = []

	function emit(event: AssistantEvent): void {
		if (event.type === "model") {
			modelState = event.state
		}

		for (const listener of listeners) {
			listener(event)
		}
	}

	function later(run: () => void, steps: number): void {
		const timer = setTimeout(() => {
			timers.delete(timer)
			run()
		}, stepMs * steps)

		timers.add(timer)
	}

	function clearTimers(): void {
		for (const timer of timers) {
			clearTimeout(timer)
		}

		timers.clear()
	}

	const LOAD_STEPS = 2
	// Apart from the turn's timers: like the runtime's, a load carries on when its turn is stopped.
	let loadTimer: ReturnType<typeof setTimeout> | undefined

	// Steps until the model is ready: 0 when it is, the rest of a load already under way, or a new load.
	function loadModel(): number {
		if (modelState.kind === "ready") {
			return 0
		}

		if (modelState.kind === "loading") {
			return LOAD_STEPS
		}

		if (modelState.kind !== "downloaded") {
			return 0
		}

		const model = modelState.model

		emit({ type: "model", state: { kind: "loading", model, verifying: false } })
		loadTimer = setTimeout(() => {
			loadTimer = undefined
			emit({ type: "model", state: { kind: "ready", model } })
		}, stepMs * LOAD_STEPS)

		return LOAD_STEPS
	}

	function downloadModel(): void {
		if (modelState.kind !== "not-downloaded" && modelState.kind !== "error") {
			return
		}

		const model = modelState.model ?? MOCK_ASSISTANT_MODEL

		emit({ type: "model", state: { kind: "downloading", model, receivedBytes: 0, waiting: false, resumed: false } })

		for (let step = 1; step <= downloadSteps; step++) {
			later(() => {
				emit({
					type: "model",
					state: {
						kind: "downloading",
						model,
						receivedBytes: Math.round((model.sizeBytes * step) / downloadSteps),
						waiting: false,
						resumed: false
					}
				})
			}, step)
		}

		later(() => {
			emit({ type: "model", state: { kind: "downloaded", model, idleUnloaded: false } })
		}, downloadSteps + 1)
	}

	function cancelDownload(): void {
		if (modelState.kind !== "downloading") {
			return
		}

		clearTimers()
		emit({ type: "model", state: { kind: "not-downloaded", model: modelState.model } })
	}

	// Like the session's: the running turn is stopped first.
	function deleteModel(): Promise<void> {
		cancel()
		clearTimers()
		clearTimeout(loadTimer)
		emit({ type: "model", state: { kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL } })

		return Promise.resolve()
	}

	function send(message: string): string {
		turnCount++

		const turnId = `turn-${String(turnCount)}`
		const step = (next: AssistantStep) => {
			emit({ type: "step", turnId, step: next, at: Date.now() })
		}
		const search = (patch: Partial<ToolStep>) => {
			step({
				id: `${turnId}-search`,
				kind: "tool",
				status: "active",
				progress: null,
				tool: "search_items",
				subject: "taxes",
				resultCount: null,
				resultMore: false,
				failure: null,
				...patch
			})
		}
		const verb = PROPOSAL_PATTERN.exec(message)?.[1]?.toLowerCase()

		cancel()
		activeTurn = { id: turnId, message }

		// A model on disk loads first, inside the turn.
		const loadSteps = loadModel()
		const loading = (status: AssistantStep["status"]) => {
			step({ id: `${turnId}-loading`, kind: "loading", status, progress: null })
		}
		const startSearch = () => {
			if (loadSteps > 0) {
				loading("done")
			}

			step({ id: `${turnId}-routing`, kind: "routing", status: "done", progress: null, route: "files" })
			search({ progress: 0.4 })
		}

		if (loadSteps === 0) {
			startSearch()
		} else {
			loading("active")
			later(startSearch, loadSteps)
		}

		later(() => {
			search({ progress: 1 })
		}, loadSteps + 1)
		later(() => {
			search({ status: "done", resultCount: 3 })

			if (verb === undefined) {
				finishTurn(turnId, SEARCH_REPLY)

				return
			}

			// Like the session's: the id is the turn's and the call's, and the turn waits on the card.
			const proposal = mockProposal(`${turnId}:call_1_0`, verb)
			const call: ToolStep = {
				id: proposal.id,
				kind: "tool",
				status: "waiting",
				progress: null,
				tool: PROPOSAL_TOOLS[verb] ?? "trash_items",
				subject: proposal.targets.length === 1 ? (proposal.targets[0]?.name ?? null) : null,
				resultCount: null,
				resultMore: false,
				failure: null
			}

			proposals.set(proposal.id, { turnId, call })
			step(call)
			emit({ type: "proposal", turnId, proposal })
		}, loadSteps + 2)

		return turnId
	}

	// Streams the closing reply, then ends the turn complete.
	function finishTurn(turnId: string, reply: string): void {
		const words = reply.split(/(?<= )/)

		words.forEach((_, index) => {
			later(() => {
				emit({
					type: "reply",
					turnId,
					replyId: `${turnId}-reply`,
					text: words.slice(0, index + 1).join(""),
					final: index === words.length - 1
				})
			}, index + 1)
		})

		later(() => {
			if (activeTurn?.id !== turnId) {
				return
			}

			history = [...history, { user: activeTurn.message, reply }]
			activeTurn = null
			emit({ type: "turn-end", turnId, at: Date.now(), outcome: "complete" })
		}, words.length + 1)
	}

	// Like the session's abort: the turn's cards go without an event of their own, a confirmed action
	// already running carries on and settles.
	function cancel(): void {
		if (activeTurn === null) {
			return
		}

		const turnId = activeTurn.id

		activeTurn = null
		clearTimers()

		for (const [id, pending] of proposals) {
			if (pending.turnId === turnId) {
				proposals.delete(id)
			}
		}

		emit({ type: "turn-end", turnId, at: Date.now(), outcome: "cancelled" })
	}

	// Refuses an id it is not waiting on (unknown, settled, or its turn ended), as the session does.
	function confirm(proposalId: string): void {
		const pending = proposals.get(proposalId)

		if (pending === undefined) {
			emit({ type: "proposal-settled", proposalId, outcome: "failed" })

			return
		}

		const { turnId, call } = pending

		proposals.delete(proposalId)
		emit({ type: "step", turnId, step: { ...call, status: "active" }, at: Date.now() })

		// Apart from the turn's timers: like the session's, a confirmed action runs to its end when its turn stops.
		setTimeout(() => {
			emit({ type: "proposal-settled", proposalId, outcome: "done" })

			if (activeTurn?.id === turnId) {
				emit({ type: "step", turnId, step: { ...call, status: "done" }, at: Date.now() })
				finishTurn(turnId, "Done.")
			}
		}, stepMs * 2)
	}

	function reject(proposalId: string): void {
		const pending = proposals.get(proposalId)

		if (pending === undefined) {
			return
		}

		proposals.delete(proposalId)
		emit({
			type: "step",
			turnId: pending.turnId,
			step: { ...pending.call, status: "failed", failure: "declined" },
			at: Date.now()
		})
		finishTurn(pending.turnId, "Okay, I left everything as it is.")
	}

	return {
		getModelState: () => modelState,
		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		setPanelOpen: () => undefined,
		downloadModel,
		// Scripted downloads never outlive the page.
		resumeInterruptedDownload: () => undefined,
		loadModel: () => {
			loadModel()
		},
		noteActivity: () => undefined,
		cancelDownload,
		deleteModel,
		send,
		cancel,
		confirm,
		reject,
		reset: (resumed = []) => {
			cancel()
			history = resumed
		},
		getHistory: () => history,
		shutdown: () => {
			cancel()
		}
	}
}
