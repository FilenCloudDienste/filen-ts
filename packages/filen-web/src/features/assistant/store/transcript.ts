import {
	endedStep,
	type AssistantEvent,
	type AssistantModelState,
	type AssistantProposal,
	type AssistantStep,
	type AssistantTurnError
} from "@/features/assistant/types"

// The panel's transcript as a flat, ordered row list, folded from AssistantEvents by one pure reducer so
// the whole conversation flow is testable without React or a session.

// pending: awaiting the user. running: confirmed, the write is in flight. expired: a newer message was
// sent before the card was answered, so it can no longer be confirmed out of context. interrupted: a saved
// card that was still running when its conversation was left, so its outcome is unknown.
export type ProposalStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "expired" | "interrupted"

// A step with its times (the session's Date.now() clock); `endedAt` once it no longer runs. A queued call's
// time starts when it runs.
export type TranscriptStep = AssistantStep & { startedAt: number; endedAt: number | null }

// How a turn ended, for its steps summary; null while it runs.
export type StepsOutcome = "complete" | "cancelled" | "failed"

export type TranscriptEntry =
	| { kind: "user"; id: string; turnId: string; text: string }
	| { kind: "reply"; id: string; turnId: string; text: string; final: boolean; withheld?: boolean }
	// One per turn, right below its message. `lastAt` is the newest step time, then the turn's end, so the
	// turn's duration counts the rows that came and went and the reply streamed after the last of them. `expanded` is the user's choice; null follows the turn
	// (open while it runs or after it failed, collapsed to its summary once it completed).
	| {
			kind: "steps"
			id: string
			turnId: string
			steps: readonly TranscriptStep[]
			startedAt: number
			lastAt: number
			outcome: StepsOutcome | null
			expanded: boolean | null
	  }
	| { kind: "proposal"; id: string; turnId: string; proposal: AssistantProposal; status: ProposalStatus }
	| { kind: "turnEnd"; id: string; turnId: string; outcome: "cancelled" | AssistantTurnError }

// A reply's action row (Copy, Save as note, Draft reply), by its turn; this session's only, never saved.
export interface TurnActions {
	sourceName: string | null
	draftChat: string | null
}

export interface TranscriptState {
	modelState: AssistantModelState
	entries: readonly TranscriptEntry[]
	actions: Readonly<Record<string, TurnActions>>
	// The turn still producing output; the composer shows Stop while it is set.
	activeTurnId: string | null
	// The last turn to finish, read by the polite live region. A counter rather than the id alone, so a
	// re-announcement of the same turn is impossible and a new one always registers as a change.
	settled: { turnId: string; seq: number } | null
}

export const INITIAL_MODEL_STATE: AssistantModelState = { kind: "checking", model: null }

export const INITIAL_TRANSCRIPT_STATE: TranscriptState = {
	modelState: INITIAL_MODEL_STATE,
	entries: [],
	actions: {},
	activeTurnId: null,
	settled: null
}

// Updates land on the newest rows, so the search runs from the end.
function indexOfEntry(entries: readonly TranscriptEntry[], id: string): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index]?.id === id) {
			return index
		}
	}

	return -1
}

function upsert(entries: readonly TranscriptEntry[], entry: TranscriptEntry): readonly TranscriptEntry[] {
	const index = indexOfEntry(entries, entry.id)

	if (index === -1) {
		return [...entries, entry]
	}

	return entries.with(index, entry)
}

// Returns the same array when nothing changed, so an untouched transcript keeps its identity.
function mapEntries(entries: readonly TranscriptEntry[], update: (entry: TranscriptEntry) => TranscriptEntry): readonly TranscriptEntry[] {
	let next: TranscriptEntry[] | null = null

	for (const [index, entry] of entries.entries()) {
		const updated = update(entry)

		if (updated !== entry) {
			next ??= entries.slice()
			next[index] = updated
		}
	}

	return next ?? entries
}

export function stepsEntryId(turnId: string): string {
	return `steps:${turnId}`
}

// Rows that only say what is happening now leave once it has happened.
const TRANSIENT_KINDS = new Set<AssistantStep["kind"]>(["thinking", "replying"])

function isLive(status: AssistantStep["status"]): boolean {
	return status === "active" || status === "queued" || status === "waiting"
}

function applyStep(steps: readonly TranscriptStep[], step: AssistantStep, at: number): readonly TranscriptStep[] {
	const index = steps.findIndex(existing => existing.id === step.id)

	if (step.status === "discarded" || (TRANSIENT_KINDS.has(step.kind) && !isLive(step.status))) {
		return index === -1 ? steps : steps.toSpliced(index, 1)
	}

	const previous = steps[index]
	const startedAt = previous === undefined || (previous.status === "queued" && step.status !== "queued") ? at : previous.startedAt
	const endedAt = isLive(step.status) ? null : (previous?.endedAt ?? at)
	const next: TranscriptStep = { ...step, startedAt, endedAt }

	return previous === undefined ? [...steps, next] : steps.with(index, next)
}

// The turn's steps entry goes right below its message, wherever the replies are.
function upsertSteps(state: TranscriptState, turnId: string, update: (entry: StepsEntry | null) => StepsEntry): readonly TranscriptEntry[] {
	const id = stepsEntryId(turnId)
	const index = indexOfEntry(state.entries, id)
	const existing = state.entries[index]

	if (existing?.kind === "steps") {
		return state.entries.with(index, update(existing))
	}

	const user = indexOfEntry(state.entries, `user:${turnId}`)

	return state.entries.toSpliced(user === -1 ? state.entries.length : user + 1, 0, update(null))
}

type StepsEntry = Extract<TranscriptEntry, { kind: "steps" }>

export function replyEntryId(replyId: string): string {
	return `reply:${replyId}`
}

export function proposalEntryId(proposalId: string): string {
	return `proposal:${proposalId}`
}

// A turn of this conversation: its message is in the transcript. A turn stopped by starting or opening
// another conversation still winds down afterwards; its late events must not land in that one.
function hasTurn(state: TranscriptState, turnId: string): boolean {
	return indexOfEntry(state.entries, `user:${turnId}`) !== -1
}

export function applyAssistantEvent(state: TranscriptState, event: AssistantEvent): TranscriptState {
	if (event.type !== "model" && event.type !== "proposal-settled" && !hasTurn(state, event.turnId)) {
		return state.activeTurnId === event.turnId && event.type === "turn-end" ? { ...state, activeTurnId: null } : state
	}

	switch (event.type) {
		case "model": {
			return { ...state, modelState: event.state }
		}

		case "reply": {
			const id = replyEntryId(event.replyId)
			const withheld = event.withheld === true

			// A reply that ended with nothing to show leaves no empty bubble behind.
			if (event.final && !withheld && event.text.trim().length === 0) {
				const index = indexOfEntry(state.entries, id)

				return index === -1 ? state : { ...state, entries: state.entries.toSpliced(index, 1) }
			}

			return {
				...state,
				entries: upsert(state.entries, {
					kind: "reply",
					id,
					turnId: event.turnId,
					text: event.text,
					final: event.final,
					...(withheld ? { withheld } : {})
				})
			}
		}

		case "step": {
			const existing = state.entries[indexOfEntry(state.entries, stepsEntryId(event.turnId))]

			// The turn already ended: a late row would restart its spinner and clock.
			if (existing?.kind === "steps" && existing.outcome !== null) {
				return state
			}

			return {
				...state,
				entries: upsertSteps(state, event.turnId, entry => ({
					kind: "steps",
					id: stepsEntryId(event.turnId),
					turnId: event.turnId,
					steps: applyStep(entry?.steps ?? [], event.step, event.at),
					startedAt: Math.min(entry?.startedAt ?? event.at, event.at),
					lastAt: Math.max(entry?.lastAt ?? event.at, event.at),
					outcome: entry?.outcome ?? null,
					expanded: entry?.expanded ?? null
				}))
			}
		}

		case "proposal": {
			return {
				...state,
				entries: upsert(state.entries, {
					kind: "proposal",
					id: proposalEntryId(event.proposal.id),
					turnId: event.turnId,
					proposal: event.proposal,
					status: "pending"
				})
			}
		}

		case "proposal-settled": {
			return { ...state, entries: setProposalStatus(state.entries, event.proposalId, event.outcome) }
		}

		case "turn-actions": {
			return { ...state, actions: { ...state.actions, [event.turnId]: { sourceName: event.sourceName, draftChat: event.draftChat } } }
		}

		case "turn-end": {
			const outcome = event.outcome === "error" ? event.error : event.outcome
			const stepsOutcome: StepsOutcome =
				event.outcome === "complete" ? "complete" : event.outcome === "cancelled" ? "cancelled" : "failed"
			// A cancelled or failed turn leaves its last reply as it stood: nothing more will stream into it, and
			// a row the runtime left running stops, or fails with a failed turn.
			const entries = mapEntries(state.entries, entry => {
				if (entry.turnId !== event.turnId) {
					return entry
				}

				if (entry.kind === "reply" && !entry.final) {
					return { ...entry, final: true }
				}

				// The turn that showed the card is over: it can no longer act on a confirmation.
				if (entry.kind === "proposal" && entry.status === "pending") {
					return { ...entry, status: "expired" }
				}

				if (entry.kind === "steps" && entry.outcome === null) {
					const lastAt = Math.max(entry.lastAt, event.at)

					return {
						...entry,
						lastAt,
						outcome: stepsOutcome,
						steps: entry.steps.flatMap(step =>
							!isLive(step.status)
								? [step]
								: TRANSIENT_KINDS.has(step.kind)
									? []
									: [{ ...endedStep(step, stepsOutcome === "failed" ? "failed" : "stopped"), endedAt: lastAt }]
						)
					}
				}

				return entry
			})

			// A turn cancelled after a newer one began was superseded by the user's next message (sent while its
			// card waited): no "Stopped" row, the user stopped nothing.
			const superseded = outcome === "cancelled" && state.activeTurnId !== null && state.activeTurnId !== event.turnId

			return {
				...state,
				entries:
					outcome === "complete" || superseded
						? entries
						: [...entries, { kind: "turnEnd", id: `turnEnd:${event.turnId}`, turnId: event.turnId, outcome }],
				activeTurnId: state.activeTurnId === event.turnId ? null : state.activeTurnId,
				settled: { turnId: event.turnId, seq: (state.settled?.seq ?? 0) + 1 }
			}
		}
	}
}

export function setStepsExpanded(entries: readonly TranscriptEntry[], turnId: string, expanded: boolean): readonly TranscriptEntry[] {
	const index = indexOfEntry(entries, stepsEntryId(turnId))
	const entry = entries[index]

	if (entry?.kind !== "steps" || entry.expanded === expanded) {
		return entries
	}

	return entries.with(index, { ...entry, expanded })
}

// Whether a steps entry shows its rows: the user's choice, else open while the turn runs or after it
// failed, and collapsed to its summary once it completed.
export function stepsExpanded(entry: StepsEntry): boolean {
	return entry.expanded ?? entry.outcome !== "complete"
}

export function setProposalStatus(
	entries: readonly TranscriptEntry[],
	proposalId: string,
	status: ProposalStatus
): readonly TranscriptEntry[] {
	const index = indexOfEntry(entries, proposalEntryId(proposalId))
	const entry = entries[index]

	if (entry?.kind !== "proposal" || entry.status === status) {
		return entries
	}

	return entries.with(index, { ...entry, status })
}

// The user's message opens its turn. Cards still waiting from earlier turns expire: answering them after
// the conversation moved on would act on a request the user may no longer mean.
export function beginTurn(state: TranscriptState, turnId: string, text: string): TranscriptState {
	const entries = mapEntries(state.entries, entry =>
		entry.kind === "proposal" && entry.status === "pending" ? { ...entry, status: "expired" } : entry
	)

	return {
		...state,
		entries: [...entries, { kind: "user", id: `user:${turnId}`, turnId, text }],
		activeTurnId: turnId
	}
}

// The running turn waits only for the user to answer its card: a new message may be sent, which answers
// the card with no and replaces the turn.
export function awaitingConfirmation(state: Pick<TranscriptState, "entries" | "activeTurnId">): boolean {
	const { activeTurnId, entries } = state

	if (activeTurnId === null) {
		return false
	}

	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]

		if (entry?.turnId !== activeTurnId) {
			return false
		}

		if (entry.kind === "proposal" && entry.status === "pending") {
			return true
		}
	}

	return false
}

export function pendingProposalIds(entries: readonly TranscriptEntry[]): string[] {
	const ids: string[] = []

	for (const entry of entries) {
		if (entry.kind === "proposal" && entry.status === "pending") {
			ids.push(entry.proposal.id)
		}
	}

	return ids
}
