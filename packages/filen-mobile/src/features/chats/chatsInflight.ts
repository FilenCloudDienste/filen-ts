import { run } from "@filen/shared"
import useChatsStore, { type ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"
import { sync } from "@/features/chats/components/sync"
import secureStore from "@/lib/secureStore"
import { chatMessagesQueryUpdate } from "@/features/chats/queries/useChatMessages.query"
import { type Chat } from "@/types"
import logger from "@/lib/logger"
import { chatDraftSecureStoreKeys } from "@/features/chats/chatDrafts"

// D4b + M5: purges every piece of per-chat in-flight state when a chat is removed — queued unsent
// messages, their error/strike entries, the persisted queue on disk and the per-chat input drafts.
// Called from all three removal paths (chats.delete, chats.leave, the ConversationDeleted socket
// event). Best-effort and silent: it never throws (callers must not fail a succeeded removal over
// cleanup) and never fires UI.
export async function purgeChatInflightState(chatUuid: string): Promise<void> {
	useChatsStore.getState().setInflightMessages(prev => {
		if (!prev[chatUuid]) {
			return prev
		}

		const updated = {
			...prev
		}

		delete updated[chatUuid]

		return updated
	})

	useChatsStore.getState().setInflightErrors(prev => {
		const remaining = Object.entries(prev).filter(([, entry]) => entry.message.chat !== chatUuid)

		if (remaining.length === Object.keys(prev).length) {
			return prev
		}

		return Object.fromEntries(remaining)
	})

	// Best-effort: flushToDisk reports failure as `false` and logs internally (M3); the
	// run() guard additionally keeps even an unexpected throw from failing a succeeded
	// removal (defense-in-depth — this purge must never reject).
	const flushResult = await run(async () => {
		await sync.flushToDisk(useChatsStore.getState().inflightMessages)
	})

	if (!flushResult.success) {
		logger.error("chats-inflight", "failed to flush inflight purge to disk", { chatUuid, error: flushResult.error })
	}

	const draftsResult = await run(async () => {
		await Promise.all(chatDraftSecureStoreKeys(chatUuid).map(key => secureStore.remove(key)))
	})

	if (!draftsResult.success) {
		logger.warn("chats-inflight", "failed to remove chat draft keys", { chatUuid, error: draftsResult.error })
	}
}

// D4c "Retry": puts a failed send back on the queue (the 3-strike drop removes doomed messages
// from it), clears its error/strike state so the bubble returns to pending with a fresh retry
// budget, persists the queue and kicks a sync pass. Safe to call while the message is still
// queued (no duplicate is enqueued). Silent — callers own UX.
export async function retryInflightMessage({ chat, message }: { chat: Chat; message: ChatMessageWithInflightId }): Promise<void> {
	// Prefer the error entry's snapshot (authoritative for dropped messages); fall back to the
	// rendered message.
	const snapshot = useChatsStore.getState().inflightErrors[message.inflightId]?.message ?? message

	useChatsStore.getState().setInflightMessages(prev => {
		const existing = prev[chat.uuid]

		if (existing?.messages.some(m => m.inflightId === message.inflightId)) {
			return prev
		}

		return {
			...prev,
			[chat.uuid]: {
				chat,
				messages: [...(existing?.messages ?? []), snapshot]
			}
		}
	})

	useChatsStore.getState().clearInflightError(message.inflightId)

	const retryFlushed = await sync.flushToDisk(useChatsStore.getState().inflightMessages)

	if (!retryFlushed) {
		logger.error("chats-inflight", "retryInflightMessage flush failed — message memory-only", { inflightId: message.inflightId, chatUuid: chat.uuid })
	}

	sync.syncNow()
}

// D4c "Remove": discards a failed send entirely — drops it from the queue, its error/strike
// entry, the optimistic copy in the messages query cache (so the bubble disappears immediately
// instead of lingering until the next refetch) and persists the queue. Silent — callers own UX.
export async function removeInflightMessage({ chat, message }: { chat: Chat; message: ChatMessageWithInflightId }): Promise<void> {
	useChatsStore.getState().dequeueInflightMessage(chat.uuid, message.inflightId)
	useChatsStore.getState().clearInflightError(message.inflightId)

	chatMessagesQueryUpdate({
		params: {
			uuid: chat.uuid
		},
		updater: prev => prev.filter(m => m.inflightId !== message.inflightId)
	})

	const removeFlushed = await sync.flushToDisk(useChatsStore.getState().inflightMessages)

	if (!removeFlushed) {
		logger.warn("chats-inflight", "removeInflightMessage flush failed — removed message may re-appear", { inflightId: message.inflightId, chatUuid: chat.uuid })
	}
}
