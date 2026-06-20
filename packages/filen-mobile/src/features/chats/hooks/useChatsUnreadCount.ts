import useChatsQuery from "@/features/chats/queries/useChats.query"
import { chatMessagesQueryGet } from "@/features/chats/queries/useChatMessages.query"
import chats from "@/features/chats/chats"
import { useEffect } from "react"
import { useStringifiedClient } from "@/lib/auth"
import useEffectOnce from "@/hooks/useEffectOnce"
import { isMessageUnread } from "@/features/chats/chatSelectors"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import logger from "@/lib/logger"

export function useChatsUnreadCount() {
	const stringifiedClient = useStringifiedClient()
	const blocked = useBlockedUsers()

	const chatsQuery = useChatsQuery({
		enabled: false
	})

	const { unreadCount, hasMissingMessages } = (() => {
		if (chatsQuery.status !== "success" || !stringifiedClient) {
			return {
				unreadCount: 0,
				hasMissingMessages: false
			}
		}

		let count = 0
		let missing = false

		for (const chat of chatsQuery.data) {
			const messages = chatMessagesQueryGet({
				uuid: chat.uuid
			})

			if (!messages) {
				missing = true

				continue
			}

			if (messages.length === 0) {
				continue
			}

			count += messages.filter(message => isMessageUnread(message, chat, stringifiedClient?.userId, blocked)).length
		}

		return {
			unreadCount: count,
			hasMissingMessages: missing
		}
	})()

	useEffect(() => {
		if (hasMissingMessages && stringifiedClient) {
			chats.refetchChatsAndMessages().catch(e => logger.warn("chats", "refetchChatsAndMessages (missing messages) failed", { error: e }))
		}
	}, [hasMissingMessages, stringifiedClient])

	useEffectOnce(() => {
		if (!stringifiedClient) {
			return
		}

		chats.refetchChatsAndMessages().catch(err => {
			logger.error("chats", "initial refetchChatsAndMessages failed", { error: err })
		})
	})

	return unreadCount
}

export default useChatsUnreadCount
