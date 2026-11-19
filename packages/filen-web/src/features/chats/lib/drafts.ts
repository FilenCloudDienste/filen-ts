import { type } from "arktype"
import { run } from "@filen/shared"
import { kvGetJson, kvSetJson, kvDelete } from "@/lib/storage/adapter"
import { log } from "@/lib/log"

// Cross-reload durability for the per-chat composer draft — mobile persists the input value to
// secureStore (`chatInputValue:${uuid}`); the web mirror is a per-uuid kv entry. The in-memory store
// (useChatComposer) is the synchronous source of truth for the live UI (it survives navigation between
// chats); this disk mirror only re-seeds it after a full reload. Writes are debounced so a burst of
// keystrokes collapses to one kv transaction. All operations are best-effort and never throw — a lost
// draft is a nicety, not a correctness guarantee (the SEND outbox, not this, owns delivery durability).

const DRAFT_KEY_PREFIX = "chatDraft:"
const DRAFT_DEBOUNCE_MS = 400

const draftSchema = type("string")
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()
// The value this tab last knows to be on disk per chat ("" = no entry), from a read or a completed
// write/delete. Absent = unknown: an op is in flight, it failed, or the chat was never read.
const persisted = new Map<string, string>()
// The newest disk op per chat; a read or write that finishes behind a newer op must not record its value.
const latestOp = new Map<string, number>()
let opSeq = 0

function draftKey(chatUuid: string): string {
	return `${DRAFT_KEY_PREFIX}${chatUuid}`
}

function beginOp(chatUuid: string): number {
	opSeq += 1
	latestOp.set(chatUuid, opSeq)
	persisted.delete(chatUuid)

	return opSeq
}

function settleOp(chatUuid: string, op: number, value: string): void {
	if (latestOp.get(chatUuid) === op) {
		latestOp.delete(chatUuid)
		persisted.set(chatUuid, value)
	}
}

function cancelPendingWrite(chatUuid: string): void {
	const existing = pendingWrites.get(chatUuid)

	if (existing !== undefined) {
		clearTimeout(existing)
		pendingWrites.delete(chatUuid)
	}
}

// Read a persisted draft (empty string when none / on any read failure).
export async function loadDraft(chatUuid: string): Promise<string> {
	const opBefore = latestOp.get(chatUuid)
	const result = await run(async () => {
		return (await kvGetJson(draftKey(chatUuid), draftSchema)) ?? ""
	})

	if (!result.success) {
		log.warn("chats-drafts", "loadDraft failed", chatUuid, result.error)

		return ""
	}

	// Only when no write started meanwhile (the read may predate it) and none is still in flight.
	if (opBefore === undefined && !latestOp.has(chatUuid)) {
		persisted.set(chatUuid, result.data)
	}

	return result.data
}

// Debounced persist. An empty value deletes the entry so a cleared draft doesn't linger on disk. A value
// already on disk schedules nothing (and drops a pending write), so opening a chat writes nothing back.
// The check repeats when the timer fires: a read or delete in flight at schedule time has settled by then.
export function saveDraftDebounced(chatUuid: string, value: string): void {
	cancelPendingWrite(chatUuid)

	if (persisted.get(chatUuid) === value) {
		return
	}

	pendingWrites.set(
		chatUuid,
		setTimeout(() => {
			pendingWrites.delete(chatUuid)

			if (persisted.get(chatUuid) === value) {
				return
			}

			const op = beginOp(chatUuid)

			void run(async () => {
				if (value.length === 0) {
					await kvDelete(draftKey(chatUuid))

					return
				}

				await kvSetJson(draftKey(chatUuid), value)
			}).then(result => {
				if (!result.success) {
					log.warn("chats-drafts", "saveDraft failed", chatUuid, result.error)

					return
				}

				settleOp(chatUuid, op, value)
			})
		}, DRAFT_DEBOUNCE_MS)
	)
}

// Immediate delete (a pending debounced write is cancelled first). Called on send, and on conversation
// removal (purgeChatInflightState) so a leave/delete leaves no orphaned draft behind.
export async function deleteDraft(chatUuid: string): Promise<void> {
	cancelPendingWrite(chatUuid)

	const op = beginOp(chatUuid)
	const result = await run(async () => {
		await kvDelete(draftKey(chatUuid))
	})

	if (!result.success) {
		log.warn("chats-drafts", "deleteDraft failed", chatUuid, result.error)

		return
	}

	settleOp(chatUuid, op, "")
}
