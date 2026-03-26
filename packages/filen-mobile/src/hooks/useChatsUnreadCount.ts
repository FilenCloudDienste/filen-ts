import useChatsQuery from "@/queries/useChats.query"
import { chatMessagesQueryGet } from "@/queries/useChatMessages.query"
import chats from "@/lib/chats"
import { useEffect } from "react"
import { useStringifiedClient } from "@/lib/auth"
import useEffectOnce from "@/hooks/useEffectOnce"

export function useChatsUnreadCount() {
	const stringifiedClient = useStringifiedClient()

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

			count += messages.filter(
				message =>
					chat.lastFocus &&
					chat.lastMessage &&
					!chat.muted &&
					message.sentTimestamp > chat.lastFocus &&
					message.inner.senderId !== stringifiedClient?.userId
			).length
		}

		return {
			unreadCount: count,
			hasMissingMessages: missing
		}
	})()

	useEffect(() => {
		if (hasMissingMessages && stringifiedClient) {
			chats.refetchChatsAndMessages().catch(console.error)
		}
	}, [hasMissingMessages, stringifiedClient])

	useEffectOnce(() => {
		if (!stringifiedClient) {
			return
		}

		chats.refetchChatsAndMessages().catch(err => {
			console.error(err)
		})
	})

	return unreadCount
}

export default useChatsUnreadCount
