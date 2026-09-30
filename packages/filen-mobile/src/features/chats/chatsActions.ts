import { router } from "@/lib/router"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { selectContacts } from "@/features/contacts/contactsSelect"
import chatsLib from "@/features/chats/chats"
import logger from "@/lib/logger"
import type { Chat } from "@/types"

export async function createChatFlow(): Promise<void> {
	const selectContactsResult = await selectContacts()

	if (selectContactsResult.cancelled) {
		return
	}

	const result = await runWithLoading(async () => {
		return await chatsLib.create({
			contacts: selectContactsResult.selectedContacts
		})
	})

	if (!result.success) {
		logger.error("chats", "createChatFlow failed", { error: result.error })
		alerts.error(result.error)

		return
	}

	router.push(`/chat/${result.data.uuid}`)
}

export async function addChatParticipantsFlow(chat: Chat): Promise<void> {
	const selectContactsResult = await selectContacts({
		userIdsToExclude: chat.participants.map(p => Number(p.userId))
	})

	if (selectContactsResult.cancelled) {
		return
	}

	const result = await runWithLoading(async () => {
		return await chatsLib.addParticipants({
			chat,
			contacts: selectContactsResult.selectedContacts
		})
	})

	if (!result.success) {
		logger.error("chats", "addParticipants failed", { error: result.error })
		alerts.error(result.error)
	}
}
