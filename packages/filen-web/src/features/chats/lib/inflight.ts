import { run } from "@filen/utils"
import type { Chat } from "@filen/sdk-rs"
import { log } from "@/lib/log"
import { sync } from "@/features/chats/lib/sync"
import { deleteDraft } from "@/features/chats/lib/drafts"
import { chatMessagesQueryUpdate } from "@/features/chats/queries/chatMessages"
import useChatsInflightStore, { type ChatMessageWithInflightId } from "@/features/chats/store/useChatsInflight"

// Failed-send helpers + per-chat outbox purge — a port of mobile's chatsInflight.ts. All are
// best-effort and silent (callers own UX / must not fail a succeeded removal over cleanup).

// Purges every piece of per-chat send state when a chat is removed: queued unsent messages, their
// error/strike records, the persisted queue on disk, AND the per-chat composer draft. Called from all
// removal paths (leaveChat, deleteChat in lib/actions.ts, and the conversationDeleted
// socket event, via socketHandlers.ts's handleConversationDeleted). Never throws; never fires UI.
export async function purgeChatInflightState(chatUuid: string): Promise<void> {
	// Drop the persisted draft (best-effort, never throws).
	await deleteDraft(chatUuid)

	useChatsInflightStore.getState().setInflightMessages(prev => {
		if (!prev[chatUuid]) {
			return prev
		}

		const updated = {
			...prev
		}

		Reflect.deleteProperty(updated, chatUuid)

		return updated
	})

	useChatsInflightStore.getState().setInflightErrors(prev => {
		const remaining = Object.entries(prev).filter(([, entry]) => entry.message.chat !== chatUuid)

		if (remaining.length === Object.keys(prev).length) {
			return prev
		}

		return Object.fromEntries(remaining)
	})

	// Best-effort: flushToDisk reports failure as `false` and logs internally; the run() guard
	// additionally keeps even an unexpected throw from failing a succeeded removal (this purge must
	// never reject).
	const flushResult = await run(async () => {
		await sync.flushToDisk(useChatsInflightStore.getState().inflightMessages)
	})

	if (!flushResult.success) {
		log.error("chats-inflight", "failed to flush inflight purge to disk", chatUuid, flushResult.error)
	}
}

// "Retry": puts a failed send back on the queue (the 3-strike drop removes doomed messages from it),
// clears its error/strike state so the bubble returns to pending with a fresh retry budget, persists
// the queue and kicks a sync pass. Safe to call while the message is still queued (no duplicate is
// enqueued). Silent — callers own UX.
export async function retryInflightMessage({ chat, message }: { chat: Chat; message: ChatMessageWithInflightId }): Promise<void> {
	// Prefer the error record's snapshot (authoritative for dropped messages); fall back to the passed
	// message.
	const snapshot = useChatsInflightStore.getState().inflightErrors[message.inflightId]?.message ?? message

	useChatsInflightStore.getState().setInflightMessages(prev => {
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

	useChatsInflightStore.getState().setInflightErrors(prev => {
		if (prev[message.inflightId] === undefined) {
			return prev
		}

		const updated = {
			...prev
		}

		Reflect.deleteProperty(updated, message.inflightId)

		return updated
	})

	const retryFlushed = await sync.flushToDisk(useChatsInflightStore.getState().inflightMessages)

	if (!retryFlushed) {
		log.error("chats-inflight", "retryInflightMessage flush failed — message memory-only", message.inflightId, chat.uuid)
	}

	sync.syncNow()
}

// "Remove": discards a failed send entirely — drops it from the queue, its error/strike record, and
// the optimistic copy in the message cache (so the bubble disappears immediately instead of lingering
// until the next refetch), then persists the queue. Silent — callers own UX.
export async function removeInflightMessage({ chat, message }: { chat: Chat; message: ChatMessageWithInflightId }): Promise<void> {
	useChatsInflightStore.getState().setInflightMessages(prev => {
		const existing = prev[chat.uuid]

		if (!existing) {
			return prev
		}

		const remaining = existing.messages.filter(m => m.inflightId !== message.inflightId)

		if (remaining.length === existing.messages.length) {
			return prev
		}

		const updated = {
			...prev
		}

		if (remaining.length === 0) {
			Reflect.deleteProperty(updated, chat.uuid)
		} else {
			updated[chat.uuid] = {
				...existing,
				messages: remaining
			}
		}

		return updated
	})

	useChatsInflightStore.getState().setInflightErrors(prev => {
		if (prev[message.inflightId] === undefined) {
			return prev
		}

		const updated = {
			...prev
		}

		Reflect.deleteProperty(updated, message.inflightId)

		return updated
	})

	// The optimistic copy's uuid IS its inflightId.
	chatMessagesQueryUpdate(chat.uuid, prev => prev.filter(m => m.uuid !== message.inflightId))

	const removeFlushed = await sync.flushToDisk(useChatsInflightStore.getState().inflightMessages)

	if (!removeFlushed) {
		log.warn("chats-inflight", "removeInflightMessage flush failed — removed message may re-appear", message.inflightId, chat.uuid)
	}
}
