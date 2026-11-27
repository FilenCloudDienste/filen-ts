import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { shutdownAssistantTransformer } from "@/features/assistant/store/assistantTransform"
import { assistantHidden } from "@/features/assistant/store/assistantHidden"
import { awaitingConfirmation, pendingProposalIds } from "@/features/assistant/store/transcript"
import {
	adoptConversationSlot,
	clearConversations,
	currentConversationId,
	deleteConversation,
	readConversation,
	registerConversationSnapshot,
	saveConversationNow,
	scheduleConversationSave,
	setHistoryOpen,
	startConversationSlot
} from "@/features/assistant/store/conversationHistory"
import { restoreConversation, serializeConversation, type ConversationMeta } from "@/features/assistant/store/history.logic"
import type { AssistantEvent, AssistantModelState, AssistantSession } from "@/features/assistant/types"
import { activeDocumentKey, getActiveDocument } from "@/lib/activeDocument"

// Where the runtime plugs in: it calls registerAssistantSession once at import, and the store follows its
// events from then on, panel open or not (a download keeps reporting progress with the panel closed).
// The UI only ever talks to the session through the functions below.
let session: AssistantSession | null = null
let unsubscribe: (() => void) | null = null
// Mounted panel surfaces. A count rather than a flag: a closing drawer's exit animation can still be
// mounted when the inline panel mounts at a breakpoint crossing.
let panelsShown = 0
// Events a session emits synchronously inside send(), held until the user's message is in the transcript
// so the turn's first step can never land above the message that started it.
let heldDuringSend: AssistantEvent[] | null = null

// Streamed reply text and step updates reach the store once per frame, as one update: a reply re-renders
// its markdown on every change. Everything else lands at once, after whatever is pending, so the order
// holds; a hidden tab (no frames) catches up at the turn's end.
let pending: AssistantEvent[] = []
let cancelFlush: (() => void) | null = null
// Cards this page's session proposed and has not settled. Only these can be confirmed: a card restored
// from a saved conversation, or left from another conversation, never reaches the session as a confirm.
const liveProposals = new Set<string>()
// Restored turns get ids of their own (see restoreConversation).
let restoreCount = 0
// The newest open request: an older one whose read settles later must not switch over it, and neither
// may one the user moved on from (closed the list, sent a message, picked the conversation on screen).
let openRequest = 0

// What changes a saved conversation: a turn starting or ending, a card appearing or settling.
function changesConversation(event: AssistantEvent): boolean {
	return event.type === "turn-end" || event.type === "proposal" || event.type === "proposal-settled"
}

function isUrgent(event: AssistantEvent): boolean {
	return event.type !== "step" && !(event.type === "reply" && !event.final)
}

// Only the newest of consecutive texts of one reply matters. Steps all stay: they carry the times.
function supersedes(next: AssistantEvent, last: AssistantEvent | undefined): boolean {
	return next.type === "reply" && last?.type === "reply" && next.replyId === last.replyId
}

function flushPending(): void {
	cancelFlush?.()
	cancelFlush = null

	const events = pending

	pending = []
	useAssistantStore.getState().applyEvents(events)

	if (events.some(changesConversation)) {
		scheduleConversationSave()
	}
}

function scheduleFlush(): void {
	if (cancelFlush !== null) {
		return
	}

	if (typeof requestAnimationFrame === "function") {
		const id = requestAnimationFrame(() => {
			cancelFlush = null
			flushPending()
		})

		cancelFlush = () => {
			cancelAnimationFrame(id)
		}
	} else {
		const id = setTimeout(() => {
			cancelFlush = null
			flushPending()
		}, 16)

		cancelFlush = () => {
			clearTimeout(id)
		}
	}
}

function deliver(event: AssistantEvent): void {
	if (isUrgent(event)) {
		pending.push(event)
		flushPending()

		return
	}

	if (supersedes(event, pending.at(-1))) {
		pending[pending.length - 1] = event
	} else {
		pending.push(event)
	}

	scheduleFlush()
}

function dropPending(): void {
	cancelFlush?.()
	cancelFlush = null
	pending = []
}

export function registerAssistantSession(next: AssistantSession): () => void {
	unsubscribe?.()
	dropPending()
	session = next
	liveProposals.clear()
	startConversationSlot()
	registerConversationSnapshot(() => {
		const { entries, activeTurnId } = useAssistantStore.getState()

		return { entries, activeTurnId, history: next.getHistory() }
	})
	useAssistantStore.getState().resetConversation(next.getModelState())
	unsubscribe = next.subscribe(event => {
		if (event.type === "proposal") {
			liveProposals.add(event.proposal.id)
		} else if (event.type === "proposal-settled") {
			liveProposals.delete(event.proposalId)
		} else if (event.type === "turn-end") {
			// The turn that waited on its cards is over (stopped, failed, the model deleted): they expire with it,
			// and a late Confirm must not reach the session. A confirmed card is no longer live by then.
			for (const id of liveProposals) {
				if (id.startsWith(`${event.turnId}:`)) {
					liveProposals.delete(id)
				}
			}
		}

		if (heldDuringSend !== null) {
			heldDuringSend.push(event)

			return
		}

		deliver(event)
	})
	next.setPanelOpen(panelsShown > 0)

	return () => {
		if (session !== next) {
			return
		}

		unsubscribe?.()
		unsubscribe = null
		session = null
	}
}

export function getAssistantSession(): AssistantSession | null {
	return session
}

// The panel surface mounts exactly while the panel is on screen (inline only when open, the drawer's only
// while it is open), so its mount is the open signal: the runtime checks the model early, but never loads
// it for a panel alone. Returns the matching cleanup for a React ref callback.
export function trackAssistantPanelShown(): () => void {
	panelsShown++

	if (panelsShown === 1) {
		session?.setPanelOpen(true)
	}

	return () => {
		panelsShown--

		if (panelsShown === 0) {
			session?.setPanelOpen(false)
		}
	}
}

// The session, unless the assistant is hidden (Settings > Assistant): then nothing downloads, loads or runs the model.
function shownSession(): AssistantSession | null {
	return assistantHidden() ? null : session
}

export function downloadAssistantModel(): void {
	shownSession()?.downloadModel()
}

// The signed-in shell, once it shows: the runtime continues a download a reload or crash cut off, if any.
export function resumeAssistantDownload(): void {
	shownSession()?.resumeInterruptedDownload()
}

export function cancelAssistantDownload(): void {
	session?.cancelDownload()
}

export function loadAssistantModel(): void {
	shownSession()?.loadModel()
}

export function noteAssistantActivity(): void {
	session?.noteActivity()
}

export type ConversationModelState = Extract<AssistantModelState, { kind: "ready" | "loading" | "downloaded" }>

// The states a message can be sent from, and so the ones the panel shows the conversation in: a model on
// disk is loaded by the turn itself.
export function modelAcceptsMessages(state: AssistantModelState): state is ConversationModelState {
	return state.kind === "ready" || state.kind === "loading" || state.kind === "downloaded"
}

// Rejects when the runtime could not delete the files; the caller reports it.
export async function removeAssistantModel(): Promise<void> {
	await session?.deleteModel()
}

// Returns whether a turn started. Earlier unanswered cards are rejected first (beginTurn expires them in
// the transcript), so the runtime never holds a proposal the UI can no longer confirm. A turn that only waits
// for its card is replaced: the session stops it, and it winds down without writing a closing reply.
// Whether a new turn may start now: a session, no turn running except one waiting on its card, a model that takes
// messages.
function canStartTurn(store: ReturnType<typeof useAssistantStore.getState>, active: AssistantSession | null): active is AssistantSession {
	return active !== null && (store.activeTurnId === null || awaitingConfirmation(store)) && modelAcceptsMessages(store.modelState)
}

// Starts a turn: cards still waiting are answered with no, the events the session emits synchronously wait until the
// user's row is in the transcript.
function startTurn(active: AssistantSession, text: string, start: () => string | null): boolean {
	const store = useAssistantStore.getState()

	for (const proposalId of pendingProposalIds(store.entries)) {
		liveProposals.delete(proposalId)
		active.reject(proposalId)
	}

	const held: AssistantEvent[] = []
	let turnId: string | null

	flushPending()
	heldDuringSend = held

	try {
		turnId = start()
	} finally {
		heldDuringSend = null
	}

	if (turnId === null) {
		return false
	}

	openRequest++
	store.beginTurn(turnId, text)

	store.applyEvents(held)
	scheduleConversationSave()

	return true
}

export function sendAssistantMessage(text: string): boolean {
	const store = useAssistantStore.getState()
	const message = text.trim()
	const active = shownSession()

	if (message.length === 0 || !canStartTurn(store, active)) {
		return false
	}

	const open = getActiveDocument()
	// Detached (the chip's ×) for this one question; the chip is back for the next.
	const withoutDocument = open !== null && store.detachedDocument === activeDocumentKey(open)

	if (store.detachedDocument !== null) {
		store.setDetachedDocument(null)
	}

	return startTurn(active, message, () => active.send(message, withoutDocument ? { withoutDocument } : undefined))
}

// A click in a reply's action row: Save as note or Draft reply, a turn of its own that reads as `label`.
export function actOnAssistantReply(
	turnId: string,
	action: { action: "save-note"; title: string } | { action: "draft-reply" },
	label: string
): boolean {
	const active = shownSession()

	if (!canStartTurn(useAssistantStore.getState(), active)) {
		return false
	}

	return startTurn(active, label, () => active.act(turnId, action, label))
}

export function cancelAssistantTurn(): void {
	session?.cancel()
}

// Hidden in Settings > Assistant: the panel closes and the running turn stops (its cards expire with it). The runtime
// frees the model itself (loop/register.ts).
export function closeHiddenAssistant(): void {
	const { panelOpen, drawerOpen, setPanelOpen, setDrawerOpen } = useAssistantStore.getState()

	if (panelOpen) {
		setPanelOpen(false)
	}

	if (drawerOpen) {
		setDrawerOpen(false)
	}

	session?.cancel()
}

// Signing out: no turn, card or tool call may run past this point, and the model's memory goes now.
export function shutdownAssistant(): void {
	openRequest++
	shutdownAssistantTransformer()

	if (session !== null) {
		leaveConversation(session)
		session.shutdown()
	}

	dropPending()
}

// Must run inside the Confirm button's own click handler: the session starts the write synchronously
// (see AssistantSession.confirm).
export function confirmAssistantProposal(proposalId: string): void {
	if (session === null || !liveProposals.delete(proposalId)) {
		return
	}

	useAssistantStore.getState().setProposalStatus(proposalId, "running")
	session.confirm(proposalId)
	scheduleConversationSave()
}

export function rejectAssistantProposal(proposalId: string): void {
	if (session === null) {
		return
	}

	liveProposals.delete(proposalId)
	useAssistantStore.getState().setProposalStatus(proposalId, "cancelled")
	session.reject(proposalId)
	scheduleConversationSave()
}

// Ends whatever the conversation on screen has running: its turn, its cards, its undelivered events.
function leaveConversation(current: AssistantSession): void {
	const store = useAssistantStore.getState()

	if (store.activeTurnId !== null) {
		current.cancel()
	}

	for (const proposalId of pendingProposalIds(store.entries)) {
		current.reject(proposalId)
	}

	liveProposals.clear()
	dropPending()
}

// An empty conversation and a session with no context. The one on screen was saved or deleted first.
function showEmptyConversation(): void {
	openRequest++

	if (session !== null) {
		leaveConversation(session)
		session.reset()
		useAssistantStore.getState().resetConversation(session.getModelState())
	}

	startConversationSlot()
}

export function startNewAssistantConversation(): void {
	if (session === null) {
		return
	}

	saveConversationNow()
	showEmptyConversation()
}

// "missing": it could not be read (deleted meanwhile, or storage failed). "superseded": another switch
// came first while it was read, and that one stands.
export type OpenConversationResult = "opened" | "missing" | "superseded"

// Saves the conversation on screen, stops what it has running, and shows the saved one with the model's
// context restored.
export async function openAssistantConversation(meta: ConversationMeta): Promise<OpenConversationResult> {
	if (currentConversationId() === meta.id) {
		openRequest++

		return "opened"
	}

	const request = ++openRequest
	const body = await readConversation(meta.id)
	const current = session

	if (request !== openRequest) {
		return "superseded"
	}

	if (body === null || current === null) {
		return "missing"
	}

	saveConversationNow()
	leaveConversation(current)

	const restored = restoreConversation(body, `saved${String(++restoreCount)}`)

	current.reset(restored.history)
	useAssistantStore.getState().loadConversation(restored.entries)
	adoptConversationSlot(
		meta,
		body.rev,
		serializeConversation({ entries: restored.entries, activeTurnId: null, history: current.getHistory() }, Date.now())
	)

	return "opened"
}

// Closing the list drops an open still reading: the user stays with the conversation on screen.
export function setAssistantHistoryOpen(open: boolean): void {
	if (!open) {
		openRequest++
	}

	setHistoryOpen(open)
}

export async function deleteAssistantConversation(id: string): Promise<void> {
	if (currentConversationId() === id) {
		showEmptyConversation()
	}

	await deleteConversation(id)
}

// The conversation on screen goes too, saved or not.
export async function clearAssistantConversations(): Promise<void> {
	showEmptyConversation()
	await clearConversations()
}
