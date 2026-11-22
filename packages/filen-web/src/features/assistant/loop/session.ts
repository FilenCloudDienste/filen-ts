import {
	AssistantAbortError,
	AssistantContextError,
	AssistantMessageTooLongError,
	messageFitsContext,
	runAssistantTurn,
	windowHistory,
	type AssistantConfirmationRequest,
	type AssistantHistoryTurn,
	type AssistantModel,
	type AssistantToolCallStatus,
	type AssistantTurnEvent,
	type AssistantTurnResult
} from "@filen/shared/assistant"
import { bytesToHex } from "@filen/shared/bytes"
import type { ToolExecutor } from "@/features/assistant/runtime/executor"
import { userCalendar } from "@/features/assistant/tools/dates"
import {
	endedStep,
	type AssistantEvent,
	type AssistantModelState,
	type AssistantSession,
	type AssistantStep,
	type AssistantStepFailure,
	type AssistantStepStatus
} from "@/features/assistant/types"
import { buildProposal, supportedTools, turnExecutor, type TurnExecutor } from "@/features/assistant/loop/executorAdapter"
import { log } from "@/lib/log"

// What the session needs of the model runtime (runtime/client.ts), so tests drive it with a fake.
export interface AssistantRuntimeLike {
	readonly model: AssistantModel
	getState(): AssistantModelState
	subscribe(listener: (state: AssistantModelState) => void): () => void
	init(): Promise<void>
	setPanelOpen(open: boolean): void
	// Settles once the model is ready or has failed to load; the state says which.
	load(): Promise<void>
	// Postpones the idle unload.
	touch(): void
	retry(): void
	resumeInterruptedDownload(): void
	cancelDownload(): void
	deleteModel(): Promise<void>
	// Keeps the model loaded until the returned release runs; `activity: false` when nothing the user did ended
	// the hold (an expired card), so the idle unload still counts from the user's last activity.
	hold(): (options?: { activity?: boolean }) => void
	// Signing out: the model's worker goes at once and nothing starts again.
	shutdown(): void
}

// A card left unanswered this long ends its turn (it expires) so the idle unload can free the model: the
// card is the user's to answer, not a reason to hold ~4 GB indefinitely.
export const CARD_EXPIRY_MS = 10 * 60_000

const STEP_STATUS: Record<AssistantToolCallStatus, AssistantStepStatus> = {
	preparing: "active",
	queued: "queued",
	running: "active",
	confirming: "waiting",
	ok: "done",
	error: "failed",
	invalid: "failed",
	blocked: "failed",
	declined: "failed",
	discarded: "discarded",
	repeated: "failed"
}

const STEP_FAILURES = new Map<AssistantToolCallStatus, AssistantStepFailure>([
	["error", "error"],
	["invalid", "invalid"],
	["blocked", "blocked"],
	["declined", "declined"],
	["repeated", "repeated"]
])

function sameStep(a: AssistantStep, b: AssistantStep): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)])

	return [...keys].every(key => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key])
}

export interface TurnSteps {
	// Brackets the model load a turn waits for.
	loading: (status: AssistantStepStatus) => void
	event: (event: AssistantTurnEvent) => void
	// The turn ended: rows still running end with it, as stopped by the user or failed with the turn (a turn
	// that completed leaves none). Whatever arrives afterwards is stale and dropped.
	close: (outcome: "done" | "stopped" | "failed") => void
}

// The loop's events as the turn's progress list. Routing, each step's thinking and the closing reply are
// phase rows, at most one active at a time; a call is a row of its own, re-emitted only when what it
// shows changed. Prompt-reading progress goes to the active phase, or to the running call while the
// loop extracts its content.
export function turnSteps({ turnId, emit, now }: { turnId: string; emit: (event: AssistantEvent) => void; now: () => number }): TurnSteps {
	const steps = new Map<string, AssistantStep>()
	let phase: AssistantStep | null = null
	let inTool = false
	let runningTool: string | null = null
	let count = 0
	let closed = false

	const put = (step: AssistantStep) => {
		steps.set(step.id, step)
		emit({ type: "step", turnId, step, at: now() })
	}

	const endPhase = (status: AssistantStepStatus) => {
		if (phase !== null) {
			put({ ...phase, status, progress: null })
			phase = null
		}
	}

	const startPhase = (kind: "routing" | "thinking" | "replying") => {
		endPhase("done")
		count++
		phase =
			kind === "routing"
				? { id: `${turnId}:routing`, kind, status: "active", progress: null, route: null }
				: { id: `${turnId}:${kind}${String(count)}`, kind, status: "active", progress: null }
		put(phase)
	}

	const progress = (share: number) => {
		const target = inTool && runningTool !== null ? steps.get(runningTool) : phase

		if (target?.status !== "active" || target.progress === share) {
			return
		}

		const next = { ...target, progress: share }

		if (target === phase) {
			phase = next
		}

		put(next)
	}

	return {
		loading: status => {
			if (!closed) {
				put({ id: `${turnId}:loading`, kind: "loading", status, progress: null })
			}
		},

		event: event => {
			if (closed) {
				return
			}

			switch (event.type) {
				case "phase":
					inTool = event.phase === "tool" || event.phase === "confirming"

					if (event.phase === "routing" || event.phase === "thinking" || event.phase === "replying") {
						startPhase(event.phase)
					}

					break
				case "route":
					if (phase?.kind === "routing") {
						put({ ...phase, status: "done", progress: null, route: event.route })
						phase = null
					}

					break
				case "progress": {
					const { processed, total } = event.progress

					progress(total > 0 ? Math.min(1, Math.max(0, processed / total)) : 1)

					break
				}
				case "callProgress": {
					const target = steps.get(`${turnId}:${event.callId}`)

					if (target?.kind !== "tool" || target.status !== "active") {
						break
					}

					const { share, found } = event.progress
					const next: AssistantStep = {
						...target,
						progress: share === null ? null : Math.min(1, Math.max(0, share)),
						...(found === null ? {} : { found })
					}

					if (!sameStep(target, next)) {
						put(next)
					}

					break
				}
				case "call": {
					endPhase("done")

					const id = `${turnId}:${event.call.id}`
					const step: AssistantStep = {
						id,
						kind: "tool",
						status: STEP_STATUS[event.call.status],
						progress: null,
						tool: event.call.tool,
						subject: event.call.subject ?? null,
						resultCount: event.call.resultCount ?? null,
						resultMore: event.call.resultMore ?? false,
						failure: STEP_FAILURES.get(event.call.status) ?? null
					}
					const previous = steps.get(id)

					runningTool = event.call.status === "running" ? id : runningTool === id ? null : runningTool

					// The loop re-emits a call whenever its record changes; the list hears only what it shows.
					if (previous === undefined || !sameStep({ ...previous, progress: null }, step)) {
						put(step)
					}

					break
				}
				case "reply":
					// The reply itself shows from its first word on.
					if (event.final || event.text.length > 0) {
						endPhase("done")
					}

					break
			}
		},

		close: outcome => {
			if (closed) {
				return
			}

			const status = outcome === "failed" ? "failed" : "stopped"

			endPhase(outcome === "done" ? "done" : status)

			for (const step of steps.values()) {
				if (step.status === "active" || step.status === "queued" || step.status === "waiting") {
					put(endedStep(step, status))
				}
			}

			closed = true
		}
	}
}

// Settles with the promise, or rejects as soon as the signal aborts: Stop ends a turn that is still waiting
// for the model to load (the load itself carries on, the user asked for it).
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(new AssistantAbortError())
		}

		if (signal.aborted) {
			onAbort()

			return
		}

		signal.addEventListener("abort", onAbort, { once: true })
		void promise.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", onAbort)
		})
	})
}

function randomHex(bytes: number): string {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

function nonce(): string {
	return randomHex(6)
}

// Drawn once per conversation, so its system prompt reads the same on every turn.
function conversationSecrets(): { canary: string } {
	return { canary: randomHex(6) }
}

interface PendingProposal {
	request: AssistantConfirmationRequest
	turn: TurnExecutor
	decide: (approved: boolean) => void
}

export type AssistantRuntimeSession = AssistantSession

// The AssistantSession the UI talks to: the shared agent loop (@filen/shared/assistant runAssistantTurn)
// over the on-device model and the app's tool executor, one turn at a time.
export function createAssistantSession({
	runtime,
	executor,
	now = Date.now
}: {
	runtime: AssistantRuntimeLike
	executor: ToolExecutor
	// The clock of the steps' `at`, which the UI compares with Date.now() for live durations.
	now?: () => number
}): AssistantRuntimeSession {
	const listeners = new Set<(event: AssistantEvent) => void>()
	const proposals = new Map<string, PendingProposal>()
	let history: AssistantHistoryTurn[] = []
	// What the user saw of each reply in `history`, which the model reads with handles. A saved conversation
	// keeps this: its handles mean nothing once the page reloads, and copied back they would be guessed at.
	const shownReplies = new WeakMap<AssistantHistoryTurn, string>()
	let secrets = conversationSecrets()
	let shutDown = false
	// Bumped by reset: a turn of the previous conversation that still completes must not add its exchange to
	// the new one's history.
	let conversation = 0
	let turnCount = 0
	let active: AbortController | null = null
	// A confirmed action runs to its end even when its turn stops (Stop, a new conversation, removing the
	// model): the user clicked it, and one stopped halfway would read as failed with its effect still landing.
	// Only signing out stops it.
	const actions = new AbortController()

	function emit(event: AssistantEvent): void {
		for (const listener of listeners) {
			listener(event)
		}
	}

	runtime.subscribe(state => {
		emit({ type: "model", state })
	})

	async function runTurn({
		turnId,
		message,
		controller,
		withoutDocument
	}: {
		turnId: string
		message: string
		controller: AbortController
		withoutDocument: boolean
	}): Promise<void> {
		// Refused before anything loads: a message too long for even a first step would load ~4 GB for nothing.
		if (!messageFitsContext(message, runtime.model.contextTokens, supportedTools(executor))) {
			if (active === controller) {
				active = null
			}

			emit({ type: "turn-end", turnId, at: now(), outcome: "error", error: "message-too-long" })

			return
		}

		const release = runtime.hold()
		const turnConversation = conversation
		// One calendar per turn: the prompt's date line and every date filter its tools resolve.
		const calendar = userCalendar()
		const turn = turnExecutor({ executor, signal: controller.signal, actionSignal: actions.signal, calendar, withoutDocument })
		let segment = 0
		let segmentHasText = false
		const steps = turnSteps({ turnId, emit, now })
		let winding: Promise<unknown> = Promise.resolve()
		// A card left unanswered ended the turn, which says so instead of reading as stopped by the user.
		const card = { expired: false }

		const onEvent = (event: AssistantTurnEvent) => {
			steps.event(event)

			if (event.type === "reply") {
				const withheld = event.withheld === true

				if (event.text.length > 0 || segmentHasText || withheld) {
					segmentHasText = true
					emit({
						type: "reply",
						turnId,
						replyId: `${turnId}:r${String(segment)}`,
						text: event.text,
						final: event.final,
						...(withheld ? { withheld } : {})
					})
				}

				if (event.final && segmentHasText) {
					segment++
					segmentHasText = false
				}
			}
		}

		// Shows the card and waits for the user; aborting the turn declines it.
		const confirm = async (request: AssistantConfirmationRequest): Promise<boolean> => {
			const id = `${turnId}:${request.callId}`
			const preview = await executor.preview({ tool: request.tool, args: request.args })
			const proposal = preview.ok ? buildProposal({ id, tool: request.tool, args: request.args, preview }) : null
			const signal = controller.signal

			if (proposal === null || signal.aborted) {
				return false
			}

			return new Promise<boolean>(resolve => {
				// Hidden tabs fire timers late, so a visibility change checks the wall-clock deadline too.
				const deadline = Date.now() + CARD_EXPIRY_MS
				let timer: ReturnType<typeof setTimeout> | undefined
				const settle = () => {
					clearTimeout(timer)
					signal.removeEventListener("abort", onAbort)

					if (typeof document !== "undefined") {
						document.removeEventListener("visibilitychange", check)
					}

					proposals.delete(id)
				}
				const onAbort = () => {
					settle()
					resolve(false)
				}
				const check = () => {
					if (Date.now() >= deadline) {
						// The whole turn ends: its hold goes, and the card expires with it.
						card.expired = true
						controller.abort()
					} else {
						clearTimeout(timer)
						timer = setTimeout(check, deadline - Date.now())
					}
				}

				signal.addEventListener("abort", onAbort, { once: true })

				if (typeof document !== "undefined") {
					document.addEventListener("visibilitychange", check)
				}

				timer = setTimeout(check, CARD_EXPIRY_MS)
				proposals.set(id, {
					request,
					turn,
					decide: approved => {
						settle()
						resolve(approved)
					}
				})
				emit({ type: "proposal", turnId, proposal })
			})
		}

		try {
			if (runtime.getState().kind !== "ready") {
				steps.loading("active")
				await unlessAborted(runtime.load(), controller.signal)
				steps.loading(runtime.getState().kind === "ready" ? "done" : "failed")
			}

			// The load failed or another tab holds the model; the panel shows that state.
			if (runtime.getState().kind !== "ready") {
				emit({ type: "turn-end", turnId, at: now(), outcome: "error", error: "model-unavailable" })

				return
			}

			const run = runAssistantTurn({
				model: runtime.model,
				executor: turn.shared,
				history,
				message,
				signal: controller.signal,
				onEvent,
				confirm,
				nonce,
				secrets,
				now: calendar.now,
				timeZone: calendar.timeZone,
				weekStart: calendar.weekStart
			})

			// Stop ends the turn at once, even while a tool still waits on something that ignores the signal (a
			// paused offline fetch, a navigation a dialog blocked); the loop winds down behind it.
			winding = run

			const result: AssistantTurnResult = await unlessAborted(run, controller.signal)
			const replied = result.withheld || result.reply.trim().length > 0

			if (turnConversation === conversation && replied) {
				// A withheld reply is not shown, so the model does not read it back either.
				const exchange = { user: message, reply: result.historyReply, prompt: result.prompt, calls: result.historyCalls }

				shownReplies.set(exchange, result.withheld ? "" : result.reply)
				history = windowHistory([...history, exchange])
			}

			steps.close("done")
			emit(
				replied
					? { type: "turn-end", turnId, at: now(), outcome: "complete" }
					: { type: "turn-end", turnId, at: now(), outcome: "error", error: "no-reply" }
			)
		} catch (e) {
			const cancelled = e instanceof AssistantAbortError || controller.signal.aborted

			steps.close(cancelled ? "stopped" : "failed")

			if (cancelled && card.expired) {
				emit({ type: "turn-end", turnId, at: now(), outcome: "error", error: "expired" })
			} else if (cancelled) {
				emit({ type: "turn-end", turnId, at: now(), outcome: "cancelled" })
			} else if (e instanceof AssistantMessageTooLongError) {
				emit({ type: "turn-end", turnId, at: now(), outcome: "error", error: "message-too-long" })
			} else if (e instanceof AssistantContextError) {
				emit({ type: "turn-end", turnId, at: now(), outcome: "error", error: "context-full" })
			} else {
				log.error("assistant", "turn failed", e)
				emit({
					type: "turn-end",
					turnId,
					at: now(),
					outcome: "error",
					error: runtime.getState().kind === "ready" ? "failed" : "model-unavailable"
				})
			}
		} finally {
			for (const [id, pending] of proposals) {
				if (pending.turn === turn) {
					pending.decide(false)
					proposals.delete(id)
				}
			}

			if (active === controller) {
				active = null
			}

			// The model stays held until the loop has actually wound down, not just until the turn ended.
			void winding
				.catch(() => undefined)
				.finally(() => {
					release({ activity: !card.expired })
				})
		}
	}

	return {
		getModelState: () => runtime.getState(),

		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},

		setPanelOpen: open => {
			runtime.setPanelOpen(open)
		},

		downloadModel: () => {
			runtime.retry()
		},

		loadModel: () => {
			void runtime.load()
		},

		noteActivity: () => {
			runtime.touch()
		},

		resumeInterruptedDownload: () => {
			runtime.resumeInterruptedDownload()
		},

		cancelDownload: () => {
			runtime.cancelDownload()
		},

		deleteModel: async () => {
			active?.abort()
			await runtime.deleteModel()
		},

		send: (message, options) => {
			const turnId = `turn-${String(++turnCount)}`
			const controller = new AbortController()

			active?.abort()

			if (shutDown) {
				controller.abort()
			}

			active = controller
			void runTurn({ turnId, message, controller, withoutDocument: options?.withoutDocument === true })

			return turnId
		},

		cancel: () => {
			active?.abort()
		},

		confirm: proposalId => {
			const pending = proposals.get(proposalId)

			if (pending === undefined || shutDown) {
				emit({ type: "proposal-settled", proposalId, outcome: "failed" })

				return
			}

			// Started here, synchronously, inside the click that confirmed it.
			const running = pending.turn.start(pending.request)

			pending.decide(true)

			const release = runtime.hold()

			void running
				.then(
					result => {
						emit({ type: "proposal-settled", proposalId, outcome: result.ok ? "done" : "failed" })
					},
					(e: unknown) => {
						log.error("assistant", "confirmed action failed", e)
						emit({ type: "proposal-settled", proposalId, outcome: "failed" })
					}
				)
				.finally(release)
		},

		reject: proposalId => {
			proposals.get(proposalId)?.decide(false)
		},

		reset: (resumed = []) => {
			active?.abort()
			conversation++
			secrets = conversationSecrets()
			history = windowHistory(resumed.map(({ user, reply }) => ({ user, reply })))
			executor.reset(history)
		},

		getHistory: () => history.map(exchange => ({ ...exchange, reply: shownReplies.get(exchange) ?? exchange.reply })),

		shutdown: () => {
			shutDown = true
			active?.abort()
			actions.abort()

			for (const pending of proposals.values()) {
				pending.decide(false)
			}

			runtime.shutdown()
		}
	}
}
