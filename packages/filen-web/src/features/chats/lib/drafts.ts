import { type } from "arktype"
import { run } from "@filen/utils"
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

function draftKey(chatUuid: string): string {
	return `${DRAFT_KEY_PREFIX}${chatUuid}`
}

// Read a persisted draft (empty string when none / on any read failure).
export async function loadDraft(chatUuid: string): Promise<string> {
	const result = await run(async () => {
		return (await kvGetJson(draftKey(chatUuid), draftSchema)) ?? ""
	})

	if (!result.success) {
		log.warn("chats-drafts", "loadDraft failed", chatUuid, result.error)

		return ""
	}

	return result.data
}

// Debounced persist. An empty value deletes the entry so a cleared draft doesn't linger on disk.
export function saveDraftDebounced(chatUuid: string, value: string): void {
	const existing = pendingWrites.get(chatUuid)

	if (existing !== undefined) {
		clearTimeout(existing)
	}

	pendingWrites.set(
		chatUuid,
		setTimeout(() => {
			pendingWrites.delete(chatUuid)

			void run(async () => {
				if (value.length === 0) {
					await kvDelete(draftKey(chatUuid))

					return
				}

				await kvSetJson(draftKey(chatUuid), value)
			}).then(result => {
				if (!result.success) {
					log.warn("chats-drafts", "saveDraft failed", chatUuid, result.error)
				}
			})
		}, DRAFT_DEBOUNCE_MS)
	)
}

// Immediate delete (a pending debounced write is cancelled first). Called on conversation removal
// (purgeChatInflightState) so a leave/delete leaves no orphaned draft behind.
export async function deleteDraft(chatUuid: string): Promise<void> {
	const existing = pendingWrites.get(chatUuid)

	if (existing !== undefined) {
		clearTimeout(existing)
		pendingWrites.delete(chatUuid)
	}

	const result = await run(async () => {
		await kvDelete(draftKey(chatUuid))
	})

	if (!result.success) {
		log.warn("chats-drafts", "deleteDraft failed", chatUuid, result.error)
	}
}
