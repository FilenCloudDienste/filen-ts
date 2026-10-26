import { create } from "zustand"
import { kvDelete, kvDeletePrefix, kvEntriesJson, kvGetJson, kvKeys, kvSetJson } from "@/lib/storage/adapter"
import { hasPersistedSession, onAuthBroadcast } from "@/lib/sdk/session"
import { readSignOutPending } from "@/lib/signOutPending"
import { log } from "@/lib/log"
import {
	conversationBodySchema,
	conversationMetaSchema,
	conversationTitle,
	historyBodyKey,
	historyMetaKey,
	historyRowId,
	planHistoryPrune,
	serializeConversation,
	utf8Bytes,
	HISTORY_KV_PREFIX,
	HISTORY_META_PREFIX,
	type ConversationBody,
	type ConversationContent,
	type ConversationMeta,
	type ConversationSnapshot
} from "@/features/assistant/store/history.logic"

// Saved conversations, on this device only: kv rows, which logout wipes with every other decrypted local
// cache (so they belong to the signed-in account without a prefix). One body row and one small index row
// per conversation, so a save rewrites only its own conversation and the list reads only the index. Nothing
// is read before the history view opens or a save lands. Writes from every tab go through one Web Lock, and
// a tab overwrites a conversation only while it holds the version it last wrote or read: when another tab
// changed or deleted it meanwhile, this tab's copy is saved as a conversation of its own.

const SAVE_DELAY_MS = 1000
const LOCK = "filen-web-assistant-history"
const CHANNEL = "filen-web-assistant-history"

interface AssistantHistoryStore {
	// Newest activity first; null until the history view first opens.
	conversations: readonly ConversationMeta[] | null
	// The history list shows in the panel in place of the conversation.
	open: boolean
	// The saved conversation the panel shows; null until its first save.
	currentId: string | null
}

export const useAssistantHistoryStore = create<AssistantHistoryStore>(() => ({ conversations: null, open: false, currentId: null }))

// The conversation the panel shows, as this tab last saved or read it.
interface Slot {
	id: string | null
	rev: string | null
	title: string | null
	createdAt: number | null
	// The content last handed to a write, so an unchanged conversation is never written again (and an
	// opened one does not move to "Today" just for being read).
	savedJson: string | null
}

function emptySlot(): Slot {
	return { id: null, rev: null, title: null, createdAt: null, savedJson: null }
}

let slot = emptySlot()
let capture: (() => ConversationSnapshot) | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let queue: Promise<void> = Promise.resolve()
// Logout: nothing may be written after the wipe.
let closed = false
let channel: BroadcastChannel | null = null
let pageHideListening = false
let unwatchSignOut: (() => void) | null = null
let indexLoads = 0

function newToken(): string {
	return crypto.randomUUID()
}

// Another tab's sign-out reaches this one as a broadcast after its wipe; from then on nothing is written
// here either, not even the save the reload's pagehide runs.
function watchSignOut(): void {
	if (closed || unwatchSignOut !== null) {
		return
	}

	unwatchSignOut = onAuthBroadcast(message => {
		if (message.kind === "logout") {
			resetConversationHistory()
		}
	})
}

// Serialized in this tab, and across tabs by the lock: a read of the stored version and the write that
// depends on it never interleave with another tab's.
function enqueue(task: () => Promise<void>): Promise<void> {
	watchSignOut()

	const next = queue.then(() => navigator.locks.request(LOCK, task))

	queue = next.catch((error: unknown) => {
		log.warn("assistant", "conversation history write failed", error)
	})

	return next
}

// Opened by the first save or list in this tab: a tab showing the list reloads it when another tab changed
// the history (a closed list reads it fresh on its next open); an open conversation finds out on its next
// save.
function historyChannel(): BroadcastChannel | null {
	if (closed) {
		return null
	}

	if (channel !== null) {
		return channel
	}

	try {
		channel = new BroadcastChannel(CHANNEL)
	} catch {
		return null
	}

	channel.onmessage = () => {
		if (useAssistantHistoryStore.getState().open) {
			void loadConversationIndex()
		}
	}

	return channel
}

function notifyOtherTabs(): void {
	try {
		historyChannel()?.postMessage({ kind: "changed" })
	} catch {
		// A closed channel: the other tabs read the index again when their history view opens.
	}
}

function upsertIndex(meta: ConversationMeta): void {
	useAssistantHistoryStore.setState(state =>
		state.conversations === null ? {} : { conversations: [meta, ...state.conversations.filter(existing => existing.id !== meta.id)] }
	)
}

function removeFromIndex(ids: ReadonlySet<string>): void {
	useAssistantHistoryStore.setState(state => ({
		conversations: state.conversations?.filter(meta => !ids.has(meta.id)) ?? null,
		currentId: state.currentId !== null && ids.has(state.currentId) ? null : state.currentId
	}))
}

// Only index rows that validate and sit under their own id.
async function readIndex(): Promise<ConversationMeta[]> {
	const entries = await kvEntriesJson(HISTORY_META_PREFIX, conversationMetaSchema)

	return entries.filter(([key, meta]) => key === historyMetaKey(meta.id)).map(([, meta]) => meta)
}

async function removeRows(id: string): Promise<void> {
	await kvDelete(historyMetaKey(id))
	await kvDelete(historyBodyKey(id))
}

// Under the lock, so no write is halfway. Rows no valid index row covers (a tab that closed between a
// body and its index row, an index row that no longer validates) are invisible to the list and the
// budget, so they go too.
async function prune(keep: ReadonlySet<string>): Promise<void> {
	const [keys, metas] = await Promise.all([kvKeys(HISTORY_KV_PREFIX), readIndex()])
	const listed = new Set(metas.map(meta => meta.id))
	const stray = new Set<string>()

	for (const key of keys) {
		const id = historyRowId(key)

		if (id === null || !listed.has(id)) {
			stray.add(key)
		}
	}

	const pruned = planHistoryPrune(metas, keep)

	for (const key of stray) {
		await kvDelete(key)
	}

	for (const id of pruned) {
		await removeRows(id)
	}

	if (pruned.length > 0) {
		removeFromIndex(new Set(pruned))
	}
}

async function write(target: Slot, content: ConversationContent, json: string): Promise<void> {
	// Signing out in this or another tab: a row landing after the wipe would outlive the account. The
	// session row goes before the kv wipe, and the wipe waits for this lock (withHistoryWritesHeld), so a
	// write either lands before the wipe or finds no session.
	if (closed || readSignOutPending() || !(await hasPersistedSession())) {
		if (target.savedJson === json) {
			target.savedJson = null
		}

		return
	}

	try {
		let id = target.id

		if (id !== null) {
			const stored = await kvGetJson(historyMetaKey(id), conversationMetaSchema)

			if (stored?.rev !== target.rev) {
				id = null
			}
		}

		const now = Date.now()
		const rev = newToken()
		const meta: ConversationMeta = {
			id: id ?? newToken(),
			title: target.title ?? conversationTitle(content),
			createdAt: target.createdAt ?? now,
			updatedAt: now,
			bytes: utf8Bytes(json),
			rev
		}
		const body: ConversationBody = { v: 1, rev, ...content }

		await kvSetJson(historyBodyKey(meta.id), body)
		await kvSetJson(historyMetaKey(meta.id), meta)

		target.id = meta.id
		target.rev = rev
		target.title = meta.title
		target.createdAt = meta.createdAt

		if (target === slot) {
			useAssistantHistoryStore.setState({ currentId: meta.id })
		}

		upsertIndex(meta)
		// The conversation on screen may be another one by now (a switch saves the old one on its way out).
		await prune(new Set(slot.id === null ? [meta.id] : [meta.id, slot.id]))
		notifyOtherTabs()
	} catch (error) {
		// The next change tries again.
		if (target.savedJson === json) {
			target.savedJson = null
		}

		throw error
	}
}

// What the panel shows right now; registered by the session glue (assistantSession.ts).
export function registerConversationSnapshot(next: () => ConversationSnapshot): void {
	capture = next
}

// A closing tab still gets a save that was waiting out its delay.
function listenForPageHide(): void {
	if (pageHideListening || typeof document === "undefined") {
		return
	}

	pageHideListening = true
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") {
			saveConversationNow()
		}
	})
	window.addEventListener("pagehide", saveConversationNow)
}

// Called at a turn's start and end and when a card settles, never per streamed token; the write waits for
// the conversation to go quiet.
export function scheduleConversationSave(): void {
	if (closed || capture === null) {
		return
	}

	listenForPageHide()
	watchSignOut()
	clearTimeout(timer)
	timer = setTimeout(saveConversationNow, SAVE_DELAY_MS)
}

// Takes the snapshot now (the write itself is queued), so it is safe right before the panel switches
// conversations.
export function saveConversationNow(): void {
	clearTimeout(timer)
	timer = undefined

	if (closed || capture === null) {
		return
	}

	const snapshot = capture()

	if (snapshot.entries.length === 0) {
		return
	}

	const content = serializeConversation(snapshot, Date.now())
	const json = JSON.stringify(content)
	const target = slot

	if (content.entries.length === 0 || json === target.savedJson) {
		return
	}

	target.savedJson = json
	void enqueue(() => write(target, content, json)).catch(() => undefined)
}

// A new, unsaved conversation; whatever the old one had waiting is dropped (the caller saved it first, or
// it was deleted).
export function startConversationSlot(): void {
	clearTimeout(timer)
	timer = undefined
	slot = emptySlot()
	useAssistantHistoryStore.setState({ currentId: null })
}

// The panel now shows this saved conversation. `content` is what a save of it would write unchanged.
export function adoptConversationSlot(meta: ConversationMeta, rev: string, content: ConversationContent): void {
	clearTimeout(timer)
	timer = undefined
	slot = { id: meta.id, rev, title: meta.title, createdAt: meta.createdAt, savedJson: JSON.stringify(content) }
	useAssistantHistoryStore.setState({ currentId: meta.id })
}

export function currentConversationId(): string | null {
	return slot.id
}

export async function loadConversationIndex(): Promise<void> {
	const load = ++indexLoads

	historyChannel()

	try {
		// This tab's own writes land first, so the list has the conversation on screen.
		await queue

		const metas = await readIndex()

		if (load === indexLoads && !closed) {
			useAssistantHistoryStore.setState({ conversations: metas.sort((a, b) => b.updatedAt - a.updatedAt) })
		}
	} catch (error) {
		log.warn("assistant", "failed to load the conversation history", error)

		if (load === indexLoads && !closed) {
			useAssistantHistoryStore.setState(state => ({ conversations: state.conversations ?? [] }))
		}
	}
}

// After this tab's own queued writes, so it never reads a conversation older than one it just saved.
export async function readConversation(id: string): Promise<ConversationBody | null> {
	await queue

	try {
		return await kvGetJson(historyBodyKey(id), conversationBodySchema)
	} catch (error) {
		log.warn("assistant", "failed to read a saved conversation", error)

		return null
	}
}

export function deleteConversation(id: string): Promise<void> {
	return enqueue(async () => {
		await removeRows(id)
		removeFromIndex(new Set([id]))
		notifyOtherTabs()
	})
}

export function clearConversations(): Promise<void> {
	return enqueue(async () => {
		await kvDeletePrefix(HISTORY_KV_PREFIX)
		useAssistantHistoryStore.setState({ conversations: [], currentId: null })
		notifyOtherTabs()
	})
}

// Opening the list saves the conversation on screen and reads the index fresh: it is small, and another
// tab may have changed it unseen.
export function setHistoryOpen(open: boolean): void {
	useAssistantHistoryStore.setState({ open })

	if (open) {
		saveConversationNow()
		void loadConversationIndex()
	}
}

// Settles once every write queued so far has landed (or failed).
export function whenHistoryWritten(): Promise<void> {
	return queue
}

// The logout kv wipe runs inside this, so it never lands under a write already past its checks.
export function withHistoryWritesHeld(task: () => Promise<void>): Promise<void> {
	return navigator.locks.request(LOCK, task)
}

// Logout, here or in another tab: no write may follow the wipe, and the list leaves memory. The rows go
// with the kv wipe itself.
export function resetConversationHistory(): void {
	closed = true
	unwatchSignOut?.()
	unwatchSignOut = null
	clearTimeout(timer)
	timer = undefined
	slot = emptySlot()
	channel?.close()
	channel = null
	useAssistantHistoryStore.setState({ conversations: null, open: false, currentId: null })
}
