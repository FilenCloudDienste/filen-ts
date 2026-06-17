import { router } from "expo-router"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { selectContacts } from "@/features/contacts/contactsSelect"
import chatsLib from "@/features/chats/chats"
import logger from "@/lib/logger"

export async function createChatFlow(): Promise<void> {
	const selectContactsResult = await selectContacts({
		multiple: true,
		userIdsToExclude: []
	})

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
